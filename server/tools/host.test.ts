// The tool host is the harness side of a driver-owned turn.  Two things
// have to be true of it: `list_bots` must tell an HTTP bot exactly what the
// MCP lane tells a CLI bot, and `ask_bot` must go through
// `executeAskBotRequest` rather than reimplementing the peer hop — every
// guard that matters (depth cap, section, thread ownership, approval,
// mirroring) lives in there.
import { describe, expect, it, vi } from "vitest";

import { createTurnToolHost, type TurnToolBot, type TurnToolHostDeps } from "./host.ts";
import { sectionKey } from "../store.ts";

const bots: TurnToolBot[] = [
  { id: "bot-self", name: "self", section: "ops", modelSelection: { model: "m" }, title: "self title" },
  { id: "bot-peer", name: "peer", section: "ops", modelSelection: { model: "m" }, title: "peer title" },
  { id: "bot-busy", name: "busy", section: "ops", modelSelection: { model: "m" }, busy: true },
  { id: "bot-hidden", name: "hidden", section: "ops", modelSelection: { model: "m" }, hidden: true },
  { id: "bot-other", name: "other", section: "research", modelSelection: { model: "m" } },
];

/** A pinned copy of the `/api/internal/agents` endpoint body (server/index.ts,
 *  the `GET /api/internal/agents` branch) — the single implementation the MCP
 *  lane serves to CLI bots.  The host must produce the same rows.  PR 4
 *  replaces both with one registry entry and deletes this copy; until then
 *  this is the drift test that would have caught the divergence where the
 *  HTTP executor offered a bot its own row and hid `busy`. */
function endpointAgents(selfId: string, all: TurnToolBot[]) {
  const sender = all.find((b) => b.id === selfId);
  if (!sender) return null;
  return all
    .filter((b) => b.id !== selfId && !b.hidden && sectionKey(b.section) === sectionKey(sender.section))
    .map((b) => ({
      id: b.id,
      name: b.name,
      model: b.modelSelection.model,
      busy: !!b.busy,
      title: b.title || undefined,
      description: b.description || undefined,
    }));
}

function deps(over: Partial<TurnToolHostDeps> = {}): TurnToolHostDeps {
  return {
    bot: (id) => bots.find((b) => b.id === id),
    bots: () => bots,
    executeAskBotRequest: vi.fn(
      async (): Promise<{ status: number; body: Record<string, unknown> }> => ({ status: 200, body: {} }),
    ),
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

const runtime = { signal: new AbortController().signal, requestApproval: async () => "unavailable" as const };

describe("list_bots", () => {
  it("matches the /api/internal/agents rows the MCP lane serves", async () => {
    const outcome = await hostFor().execute({ id: "1", name: "list_bots", arguments: {} }, runtime);
    expect(outcome.kind).toBe("result");
    expect(JSON.parse(outcome.content).bots).toEqual(endpointAgents("bot-self", bots));
  });

  it("excludes the caller itself — a bot asking itself for help is a wasted round", async () => {
    const outcome = await hostFor().execute({ id: "1", name: "list_bots", arguments: {} }, runtime);
    const ids = JSON.parse(outcome.content).bots.map((b: { id: string }) => b.id);
    expect(ids).not.toContain("bot-self");
    expect(ids).toContain("bot-peer");
  });

  it("reports busy, so the model does not spend a round on a peer that cannot answer", async () => {
    const outcome = await hostFor().execute({ id: "1", name: "list_bots", arguments: {} }, runtime);
    const rows: Array<{ id: string; busy: boolean }> = JSON.parse(outcome.content).bots;
    expect(rows.find((b) => b.id === "bot-busy")?.busy).toBe(true);
    expect(rows.find((b) => b.id === "bot-peer")?.busy).toBe(false);
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

describe("ask_bot", () => {
  it("delegates to executeAskBotRequest with the turn's own identity, never the model's", async () => {
    const executeAskBotRequest = vi.fn(
      async (): Promise<{ status: number; body: Record<string, unknown> }> => ({
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
      // the model also passes a fromBotId; it must be ignored
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

  it("accepts an id as well as an @name", async () => {
    const executeAskBotRequest = vi.fn(
      async (): Promise<{ status: number; body: Record<string, unknown> }> => ({
        status: 200,
        body: { botName: "peer", text: "ok" },
      }),
    );
    await hostFor({ executeAskBotRequest }).execute(
      { id: "1", name: "ask_bot", arguments: { bot_id: "bot-peer", task: "x" } },
      runtime,
    );
    expect(executeAskBotRequest).toHaveBeenCalledWith(expect.objectContaining({ toBotId: "bot-peer" }));
  });

  it("requires both arguments", async () => {
    const outcome = await hostFor().execute(
      { id: "1", name: "ask_bot", arguments: { bot_id: "@peer" } },
      runtime,
    );
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toMatch(/requires both/);
  });

  it("names an unknown peer rather than failing silently", async () => {
    const outcome = await hostFor().execute(
      { id: "1", name: "ask_bot", arguments: { bot_id: "@nobody", task: "x" } },
      runtime,
    );
    expect(JSON.parse(outcome.content).error).toMatch(/no bot matches/);
  });

  it("turns a busy peer into something the model can act on", async () => {
    const outcome = await hostFor({
      executeAskBotRequest: async () => ({ status: 200, body: { busy: true } }),
    }).execute({ id: "1", name: "ask_bot", arguments: { bot_id: "@peer", task: "x" } }, runtime);
    expect(outcome.kind).toBe("error");
    expect(JSON.parse(outcome.content).error).toMatch(/busy/);
  });

  it("passes the peer path's own refusal straight through", async () => {
    const outcome = await hostFor({
      executeAskBotRequest: async () => ({ status: 200, body: { error: "denied by user" } }),
    }).execute({ id: "1", name: "ask_bot", arguments: { bot_id: "@peer", task: "x" } }, runtime);
    expect(JSON.parse(outcome.content).error).toBe("denied by user");
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
});
