// The tool host is the harness side of a driver-owned turn, and after the
// registry landed it owns exactly three things: caller identity, the gate
// that decides which catalog entry a call may reach, and the promise that
// `execute` never throws.  The tool BODIES are tested in `agents.test.ts`
// and the two lanes' definitions in `registry.test.ts`; what is left here is
// the join.
//
// The pinned copy of the `/api/internal/agents` body that used to live in
// this file is gone.  It was a drift detector for a divergence that can no
// longer happen: the host now receives the endpoint function itself.
import { describe, expect, it, vi } from "vitest";

import type { RequestOutcome } from "../contracts.ts";
import { createTurnToolHost, type TurnToolHostDeps } from "./host.ts";
import { listAgentsResponse, type AgentBot, type AgentRequestResult } from "./agents.ts";

const bots: AgentBot[] = [
  { id: "bot-self", name: "self", section: "ops", modelSelection: { model: "m" }, title: "self title" },
  { id: "bot-peer", name: "peer", section: "ops", modelSelection: { model: "m" }, title: "peer title" },
  { id: "bot-busy", name: "busy", section: "ops", modelSelection: { model: "m" }, busy: true },
  { id: "bot-hidden", name: "hidden", section: "ops", modelSelection: { model: "m" }, hidden: true },
  { id: "bot-other", name: "other", section: "research", modelSelection: { model: "m" } },
];

function deps(over: Partial<TurnToolHostDeps> = {}): TurnToolHostDeps {
  return {
    // The real endpoint bodies, bound to a fixture roster — the same
    // functions `index.ts` exports and binds to the live store.
    executeListAgentsRequest: ({ selfId }) => listAgentsResponse(selfId, bots),
    executeAskBotRequest: vi.fn(
      async (): Promise<AgentRequestResult> => ({ status: 200, body: {} }),
    ),
    executeListRoutinesRequest: () => ({
      status: 200,
      body: { now: "2026-09-12T10:00:00.000Z", timeZone: "UTC", routines: [] },
    }),
    ...over,
  };
}

const hostFor = (over: Partial<TurnToolHostDeps> = {}, ctx: { commsDepth?: number } = {}) =>
  createTurnToolHost({
    botId: "bot-self",
    threadId: "thread-1",
    commsDepth: ctx.commsDepth ?? 0,
    deps: deps(over),
  });

/** The loop's runtime, with a broker that says yes.  The rows in "the host
 *  asks before a write tool runs" cover deny and no-broker explicitly; the
 *  rest of this file is about what happens once a call is allowed. */
const runtime = { signal: new AbortController().signal, requestApproval: async () => "allowed-once" as const };

/** A runtime that records what it was asked and answers with `verdict`. */
function askingRuntime(verdict: RequestOutcome) {
  const asks: Array<{ tool: string; summary: string }> = [];
  return {
    asks,
    runtime: {
      signal: new AbortController().signal,
      requestApproval: async (ask: { tool: string; summary: string }) => {
        asks.push(ask);
        return verdict;
      },
    },
  };
}

describe("the host runs what the catalog advertised", () => {
  it("serves the registry's three agents tools", async () => {
    const host = hostFor();
    for (const name of ["list_bots", "ask_bot", "list_routines"]) {
      const outcome = await host.execute({ id: "1", name, arguments: { bot_id: "bot-peer", task: "x" } }, runtime);
      expect(outcome.content, name).not.toContain("is not available to this bot");
    }
  });

  it("matches the /api/internal/agents rows the MCP lane serves", async () => {
    const outcome = await hostFor().execute({ id: "1", name: "list_bots", arguments: {} }, runtime);
    expect(outcome.kind).toBe("result");
    expect(JSON.parse(outcome.content).bots).toEqual(listAgentsResponse("bot-self", bots).body.bots);
  });

  it("serves `section` alongside the rows, as it did before the registry", async () => {
    // The host is the lane that regressed: `host.ts` used to build
    // `{ section, bots }` inline.  Pinned here as well as in
    // `agents.test.ts` so neither side can drop it alone.
    const outcome = await hostFor().execute({ id: "1", name: "list_bots", arguments: {} }, runtime);
    const payload = JSON.parse(outcome.content);
    expect(payload.section).toBe("ops");
    expect(payload.section).toBe(listAgentsResponse("bot-self", bots).body.section);
  });

  it("excludes the caller and reports busy — the two facts that save a round", async () => {
    const outcome = await hostFor().execute({ id: "1", name: "list_bots", arguments: {} }, runtime);
    const rows: Array<{ id: string; busy: boolean }> = JSON.parse(outcome.content).bots;
    expect(rows.map((b) => b.id)).not.toContain("bot-self");
    expect(rows.find((b) => b.id === "bot-busy")?.busy).toBe(true);
  });

  it("hides other sections and hidden bots", async () => {
    const outcome = await hostFor().execute({ id: "1", name: "list_bots", arguments: {} }, runtime);
    const ids = JSON.parse(outcome.content).bots.map((b: { id: string }) => b.id);
    expect(ids).not.toContain("bot-other");
    expect(ids).not.toContain("bot-hidden");
  });

  it("fails clearly when the caller no longer exists", async () => {
    const host = createTurnToolHost({
      botId: "gone",
      threadId: "thread-1",
      commsDepth: 0,
      deps: deps(),
    });
    const outcome = await host.execute({ id: "1", name: "list_bots", arguments: {} }, runtime);
    expect(outcome.kind).toBe("error");
  });
});

describe("caller identity is the turn's, never the model's", () => {
  it("bakes botId, threadId and depth into ask_bot at dispatch", async () => {
    const executeAskBotRequest = vi.fn(
      async (): Promise<AgentRequestResult> => ({
        status: 200,
        body: { botName: "peer", text: "here you go" },
      }),
    );
    const host = createTurnToolHost({
      botId: "bot-self",
      threadId: "thread-1",
      commsDepth: 1,
      deps: deps({ executeAskBotRequest }),
    });
    const outcome = await host.execute(
      { id: "1", name: "ask_bot", arguments: { bot_id: "@peer", task: "summarize", fromBotId: "bot-other" } },
      runtime,
    );
    expect(executeAskBotRequest).toHaveBeenCalledWith({
      fromBotId: "bot-self",
      toBotId: "bot-peer",
      message: "summarize",
      depth: 1,
      fromThreadId: "thread-1",
    });
    expect(outcome).toMatchObject({ kind: "result", content: "peer replied:\nhere you go" });
  });

  it("ignores a thread the model names for list_routines", async () => {
    const executeListRoutinesRequest = vi.fn(() => ({ status: 200, body: { routines: [] } }));
    await hostFor({ executeListRoutinesRequest }).execute(
      { id: "1", name: "list_routines", arguments: { fromThreadId: "thread-9" } },
      runtime,
    );
    expect(executeListRoutinesRequest).toHaveBeenCalledWith({
      fromBotId: "bot-self",
      fromThreadId: "thread-1",
    });
  });
});

describe("the host's contract", () => {
  it("never throws — a thrown dependency comes back as an error outcome", async () => {
    const outcome = await hostFor({
      executeAskBotRequest: async () => {
        throw new Error("comms bus is down");
      },
    }).execute({ id: "1", name: "ask_bot", arguments: { bot_id: "@peer", task: "x" } }, runtime);
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toBe("comms bus is down");
  });

  it("tells the model plainly about a tool it does not have", async () => {
    const outcome = await hostFor().execute({ id: "1", name: "delete_everything", arguments: {} }, runtime);
    expect(outcome.kind).toBe("error");
    expect(outcome.content).toContain("delete_everything");
  });

  it("carries the harness's broker so the driver's loop can pause its clock around it", () => {
    const requestApproval = async () => "allowed-once" as const;
    const host = createTurnToolHost({
      botId: "bot-self",
      threadId: "thread-1",
      commsDepth: 0,
      deps: deps(),
      requestApproval,
    });
    expect(host.requestApproval).toBe(requestApproval);
    // absent when no broker was mounted, so the loop can tell
    expect(hostFor().requestApproval).toBeUndefined();
  });

  it("refuses a tool that exists but was never in this turn's catalog", async () => {
    // The write tools land in a later PR.  Until they do, a model that
    // hallucinates one must not find an executor waiting for it.
    const outcome = await hostFor().execute({ id: "1", name: "create_bot", arguments: {} }, runtime);
    expect(outcome.kind).toBe("error");
    expect(outcome.content).toContain("is not available to this bot");
  });
});

// Before PR 6 nothing on this lane ever asked for permission: an HTTP bot
// ran whatever the model called.  The host is where that changed, and the
// policy is a FIELD ON THE TOOL — not a switch here — so a read tool
// cannot start carding by accident and a write tool cannot stop.
describe("the host asks before a write tool runs", () => {
  it("opens an ask carrying the registry's own summary, and only then runs the tool", async () => {
    const executeAskBotRequest = vi.fn(async () => ({ status: 200, body: { botName: "peer", text: "ok" } }));
    const asking = askingRuntime("allowed-once");
    const outcome = await hostFor({ executeAskBotRequest }).execute(
      { id: "1", name: "ask_bot", arguments: { bot_id: "@peer", task: "summarise  the   log" } },
      asking.runtime,
    );

    expect(asking.asks).toEqual([{ tool: "ask_bot", summary: "ask @peer: summarise the log" }]);
    expect(executeAskBotRequest).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("result");
  });

  it("a deny never reaches the executor, and the model is told why", async () => {
    const executeAskBotRequest = vi.fn(async () => ({ status: 200, body: {} }));
    const asking = askingRuntime("rejected");
    const outcome = await hostFor({ executeAskBotRequest }).execute(
      { id: "1", name: "ask_bot", arguments: { bot_id: "@peer", task: "spend the budget" } },
      asking.runtime,
    );

    // the side effect never happened — an approval that arrives after the
    // fact is a receipt, not a decision
    expect(executeAskBotRequest).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "error", detail: "denied" });
    expect(outcome.content).toContain("was not approved");
  });

  it("no broker mounted is fail-closed — nobody asked is not nobody objected", async () => {
    const executeAskBotRequest = vi.fn(async () => ({ status: 200, body: {} }));
    const asking = askingRuntime("unavailable");
    const outcome = await hostFor({ executeAskBotRequest }).execute(
      { id: "1", name: "ask_bot", arguments: { bot_id: "@peer", task: "x" } },
      asking.runtime,
    );

    expect(executeAskBotRequest).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "error", detail: "approval unavailable" });
  });

  it("a tool with no approval record never asks", async () => {
    const asking = askingRuntime("rejected");
    for (const name of ["list_bots", "list_routines"]) {
      const outcome = await hostFor().execute({ id: "1", name, arguments: {} }, asking.runtime);
      expect(outcome.kind, name).toBe("result");
    }
    // a denying broker proves it: these ran anyway, because they never
    // reached it
    expect(asking.asks).toEqual([]);
  });

  it("asks even when the summary cannot be built", async () => {
    // A card nobody can read is bad; running a write tool unasked is worse.
    const executeAskBotRequest = vi.fn(async () => ({ status: 200, body: {} }));
    const asking = askingRuntime("rejected");
    await hostFor({ executeAskBotRequest }).execute(
      { id: "1", name: "ask_bot", arguments: { bot_id: { nested: "object" }, task: 42 } },
      asking.runtime,
    );
    expect(asking.asks).toHaveLength(1);
    expect(executeAskBotRequest).not.toHaveBeenCalled();
  });
});
