// One implementation, two lanes.
//
// A CLI bot reaches `list_bots` over the loopback + COMMS_TOKEN hop into
// `GET /api/internal/agents`; a MiniMax bot reaches it in-process through
// the turn tool host.  Both must run the SAME code, because the moment they
// do not, they drift — and they did: the old executor filtered on section
// and `!hidden` only, so it offered a bot its own row and never told it a
// peer was busy, which cost a wasted round every time.
//
// These tests pin the join.  `listAgentsResponse` is the endpoint body that
// `index.ts` exports as `executeListAgentsRequest`; the host receives that
// same function as a dependency, so asserting the host's rows equal
// `listAgentsResponse`'s rows is asserting there is one implementation.
import { describe, expect, it, vi } from "vitest";

import {
  createAgentTools,
  listAgentsResponse,
  selectPeerBots,
  type AgentBot,
  type AgentRequestResult,
  type AgentToolCallContext,
  type AgentToolDeps,
  type AskBotRequestInput,
} from "./agents.ts";

const bots: AgentBot[] = [
  { id: "bot-self", name: "self", section: "ops", modelSelection: { model: "m" }, title: "self title" },
  { id: "bot-peer", name: "peer", section: "ops", modelSelection: { model: "m" }, title: "peer title" },
  { id: "bot-busy", name: "busy", section: "ops", modelSelection: { model: "m" }, busy: true },
  { id: "bot-hidden", name: "hidden", section: "ops", modelSelection: { model: "m" }, hidden: true },
  { id: "bot-other", name: "other", section: "research", modelSelection: { model: "m" } },
];

const routinesBody = {
  now: "2026-09-12T10:00:00.000Z",
  timeZone: "America/Chicago",
  routines: [{ id: "routine-1", name: "Morning brief" }],
};

const deps = (over: Partial<AgentToolDeps> = {}): AgentToolDeps => ({
  // The real endpoint body, bound to a fixed roster instead of the live
  // store — the same function `index.ts` binds to `store.bots`.
  executeListAgentsRequest: ({ selfId }) => listAgentsResponse(selfId, bots),
  executeAskBotRequest: vi.fn(
    async (_input: AskBotRequestInput): Promise<AgentRequestResult> => ({
      status: 200,
      body: { botName: "peer", text: "hi" },
    }),
  ),
  executeListRoutinesRequest: () => ({ status: 200, body: { ...routinesBody } }),
  ...over,
});

const ctx = (over: Partial<AgentToolCallContext> = {}): AgentToolCallContext => ({
  botId: "bot-self",
  threadId: "thread-1",
  commsDepth: 0,
  ...over,
});

const runtime = {
  signal: new AbortController().signal,
  requestApproval: async () => "unavailable" as const,
};

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "1", name, arguments: args });

describe("selectPeerBots is the only peer filter", () => {
  it("excludes the caller, hidden bots and other sections, and reports busy", () => {
    const rows = selectPeerBots("bot-self", bots)!;
    expect(rows.map((r) => r.id)).toEqual(["bot-peer", "bot-busy"]);
    expect(rows.find((r) => r.id === "bot-busy")?.busy).toBe(true);
    expect(rows.find((r) => r.id === "bot-peer")?.busy).toBe(false);
    expect(rows.find((r) => r.id === "bot-peer")?.title).toBe("peer title");
  });

  it("refuses an unknown sender rather than leaking the whole roster", () => {
    expect(selectPeerBots("gone", bots)).toBeNull();
    expect(listAgentsResponse("gone", bots)).toEqual({ status: 403, body: { error: "unknown sender" } });
  });
});

describe("list_bots is the same implementation on both lanes", () => {
  it("returns exactly the rows the /api/internal/agents body returns", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.list_bots(call("list_bots"), ctx(), runtime);
    expect(outcome.kind).toBe("result");
    // The MCP lane serves `body.bots` verbatim over the hop; the host
    // serialises the same array.  Equality here IS the parity assertion.
    expect(JSON.parse(outcome.content).bots).toEqual(listAgentsResponse("bot-self", bots).body.bots);
  });

  it("excludes the caller — a bot asking itself for help is a wasted round", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.list_bots(call("list_bots"), ctx(), runtime);
    const ids = JSON.parse(outcome.content).bots.map((b: { id: string }) => b.id);
    expect(ids).not.toContain("bot-self");
    expect(ids).toContain("bot-peer");
  });

  it("reports busy identically, so the model does not ask a peer that cannot answer", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.list_bots(call("list_bots"), ctx(), runtime);
    const rows: Array<{ id: string; busy: boolean }> = JSON.parse(outcome.content).bots;
    expect(rows.find((b) => b.id === "bot-busy")?.busy).toBe(true);
    expect(rows.find((b) => b.id === "bot-peer")?.busy).toBe(false);
  });

  it("surfaces the endpoint's own refusal when the caller no longer exists", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.list_bots(call("list_bots"), ctx({ botId: "gone" }), runtime);
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toBe("unknown sender");
  });
});

describe("ask_bot still goes through executeAskBotRequest", () => {
  it("passes the turn's own identity, never the model's", async () => {
    const executeAskBotRequest = vi.fn(
      async (): Promise<AgentRequestResult> => ({
        status: 200,
        body: { botName: "peer", text: "here you go" },
      }),
    );
    const tools = createAgentTools(deps({ executeAskBotRequest }));
    const outcome = await tools.ask_bot(
      // the model also passes a fromBotId; it must be ignored
      call("ask_bot", { bot_id: "@peer", task: "summarize", fromBotId: "bot-other" }),
      ctx({ commsDepth: 1 }),
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

  it("accepts both advertised argument names — the lanes' declared deviation", async () => {
    const executeAskBotRequest = vi.fn(
      async (_input: AskBotRequestInput): Promise<AgentRequestResult> => ({
        status: 200,
        body: { botName: "peer", text: "ok" },
      }),
    );
    const tools = createAgentTools(deps({ executeAskBotRequest }));
    // `message` is what the MCP lane advertises, `task` what the HTTP lane
    // advertises.  One body has to answer to both.
    await tools.ask_bot(call("ask_bot", { bot_id: "bot-peer", message: "x" }), ctx(), runtime);
    await tools.ask_bot(call("ask_bot", { bot_id: "bot-peer", task: "y" }), ctx(), runtime);
    expect(executeAskBotRequest.mock.calls.map(([input]) => input.message)).toEqual(["x", "y"]);
  });

  it("resolves a target only against the roster the model was shown", async () => {
    const executeAskBotRequest = vi.fn(
      async (): Promise<AgentRequestResult> => ({ status: 200, body: { text: "ok" } }),
    );
    const tools = createAgentTools(deps({ executeAskBotRequest }));
    for (const target of ["bot-hidden", "bot-other", "bot-self"]) {
      const outcome = await tools.ask_bot(call("ask_bot", { bot_id: target, task: "x" }), ctx(), runtime);
      expect(outcome.kind, target).toBe("error");
      expect(JSON.parse(outcome.content).error).toMatch(/no bot matches/);
    }
    expect(executeAskBotRequest).not.toHaveBeenCalled();
  });

  it("requires both arguments", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.ask_bot(call("ask_bot", { bot_id: "@peer" }), ctx(), runtime);
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toMatch(/requires both/);
  });

  it("turns a busy peer into something the model can act on", async () => {
    const tools = createAgentTools(
      deps({ executeAskBotRequest: async () => ({ status: 200, body: { busy: true } }) }),
    );
    const outcome = await tools.ask_bot(call("ask_bot", { bot_id: "@peer", task: "x" }), ctx(), runtime);
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toMatch(/busy/);
  });

  it("passes the peer path's own refusal straight through", async () => {
    const tools = createAgentTools(
      deps({ executeAskBotRequest: async () => ({ status: 200, body: { error: "denied by user" } }) }),
    );
    const outcome = await tools.ask_bot(call("ask_bot", { bot_id: "@peer", task: "x" }), ctx(), runtime);
    expect(JSON.parse(outcome.content).error).toBe("denied by user");
  });
});

describe("list_routines", () => {
  it("reports the endpoint's routines with its authoritative clock", async () => {
    const tools = createAgentTools(deps());
    const outcome = await tools.list_routines(call("list_routines"), ctx(), runtime);
    expect(outcome.kind).toBe("result");
    expect(JSON.parse(outcome.content)).toEqual(routinesBody);
    expect(outcome.detail).toBe("1 routine");
  });

  it("passes the turn's own thread, which the endpoint checks ownership of", async () => {
    const executeListRoutinesRequest = vi.fn(() => ({ status: 200, body: { routines: [] } }));
    const tools = createAgentTools(deps({ executeListRoutinesRequest }));
    await tools.list_routines(
      call("list_routines", { fromBotId: "bot-other", fromThreadId: "thread-9" }),
      ctx(),
      runtime,
    );
    expect(executeListRoutinesRequest).toHaveBeenCalledWith({
      fromBotId: "bot-self",
      fromThreadId: "thread-1",
    });
  });

  it("hands the endpoint's refusal to the model rather than an empty list", async () => {
    const tools = createAgentTools(
      deps({
        executeListRoutinesRequest: () => ({
          status: 403,
          body: { error: "source conversation does not belong to sender" },
        }),
      }),
    );
    const outcome = await tools.list_routines(call("list_routines"), ctx(), runtime);
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toMatch(/does not belong to sender/);
  });
});
