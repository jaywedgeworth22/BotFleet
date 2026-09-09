import type { ProviderInstance, SendTurnInput } from "./contracts.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the heavy modules so this test only exercises the tool executor.
// The driver, the store, and askBotAndWait are swapped for fakes.
//
// `bus` used to be an inert `{ subscribe: () => () => undefined }` stub —
// nothing ever reached a listener, so `sendTurnWithToolLoop` (which
// subscribes on the bus and waits for the driver's own events to arrive)
// was unreachable from a test at all. This is a real, tiny pub/sub instead:
// `subscribe` registers a listener the way the real EventBus does, and
// `publish` — exported so the test body can drive it directly — delivers to
// every current listener. It still never touches the real EventBus in
// index.ts.
vi.mock("./index.ts", () => {
  const listeners = new Set<(event: any) => void>();
  const bus = {
    subscribe: (listener: (event: any) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: (event: any) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
  const bots = [
    {
      id: "bot-self",
      name: "self",
      title: "self title",
      description: "self desc",
      section: "ops",
      hidden: false,
      modelSelection: { model: "test-model" },
    },
    {
      id: "bot-peer",
      name: "peer",
      title: "peer title",
      description: "peer desc",
      section: "ops",
      hidden: false,
      modelSelection: { model: "test-model" },
    },
    {
      id: "bot-other-section",
      name: "other",
      title: null,
      description: null,
      section: "other",
      hidden: false,
      modelSelection: { model: "test-model" },
    },
    {
      id: "bot-hidden",
      name: "hidden",
      title: null,
      description: null,
      section: "ops",
      hidden: true,
      modelSelection: { model: "test-model" },
    },
  ];
  return {
    bus,
    executeAskBotRequest: vi.fn(async (input: { toBotId: string; message: string }) => ({
      status: 200,
      body: { botName: "peer", text: `(peer reply to: ${input.message})` },
    })),
    store: {
      bot: (id: string) => bots.find((b) => b.id === id),
      bots: bots,
    },
  };
});

// Importing the mocked bus gives the test body a handle to `publish` — the
// same object `runHttpLaneTool`/`sendTurnWithToolLoop` subscribe on via the
// mock above.
import { bus } from "./index.ts";
import {
  buildToolContinuation,
  isToolCallsStopReason,
  parseToolArguments,
  runHttpLaneTool,
  sendTurnWithToolLoop,
} from "./tool-executor.ts";

describe("parseToolArguments", () => {
  it("returns an empty object for null or undefined", () => {
    expect(parseToolArguments("any", null)).toEqual({});
    expect(parseToolArguments("any", undefined)).toEqual({});
  });

  it("returns the object as-is when the driver already decoded it", () => {
    expect(parseToolArguments("any", { foo: "bar" })).toEqual({ foo: "bar" });
  });

  it("parses a JSON-encoded argument string", () => {
    expect(parseToolArguments("any", '{"section":"ops"}')).toEqual({ section: "ops" });
  });

  it("returns an empty object for malformed JSON", () => {
    expect(parseToolArguments("any", "{not json")).toEqual({});
  });

  it("returns an empty object for a JSON array (not an object)", () => {
    expect(parseToolArguments("any", "[1,2,3]")).toEqual({});
  });
});

describe("runHttpLaneTool", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("list_bots returns peers in the same section, excluding hidden", async () => {
    const result = await runHttpLaneTool(
      { id: "1", name: "list_bots", arguments: {} },
      { threadId: "t", fromBotId: "bot-self", commsDepth: 0 },
    );
    const parsed = JSON.parse(result);
    expect(parsed.section).toBe("ops");
    const ids: string[] = parsed.bots.map((b: { id: string }) => b.id);
    expect(ids).toContain("bot-self");
    expect(ids).toContain("bot-peer");
    expect(ids).not.toContain("bot-hidden");
    expect(ids).not.toContain("bot-other-section");
  });

  it("ask_bot forwards through the guarded internal path and returns its reply", async () => {
    const result = await runHttpLaneTool(
      { id: "1", name: "ask_bot", arguments: { bot_id: "@peer", task: "summarize this" } },
      { threadId: "t", fromBotId: "bot-self", commsDepth: 0 },
    );
    expect(result).toBe("peer replied:\n(peer reply to: summarize this)");
  });

  it("ask_bot requires both bot_id and task", async () => {
    const result = await runHttpLaneTool(
      { id: "1", name: "ask_bot", arguments: { bot_id: "@peer" } },
      { threadId: "t", fromBotId: "bot-self", commsDepth: 0 },
    );
    expect(JSON.parse(result).error).toMatch(/requires both/);
  });

  it("asks_bot on an unknown peer returns a clear error", async () => {
    const result = await runHttpLaneTool(
      { id: "1", name: "ask_bot", arguments: { bot_id: "@nope", task: "x" } },
      { threadId: "t", fromBotId: "bot-self", commsDepth: 0 },
    );
    expect(JSON.parse(result).error).toMatch(/no bot matches/);
  });

  it("Composio tools return a 'not implemented' so the model stops calling them", async () => {
    const result = await runHttpLaneTool(
      { id: "1", name: "COMPOSIO_SEARCH_TOOLS", arguments: { query: "gmail" } },
      { threadId: "t", fromBotId: "bot-self", commsDepth: 0 },
    );
    expect(result).toMatch(/not wired to the HTTP tool executor/);
  });

  it("Computer tools return a 'not implemented' so the model stops calling them", async () => {
    const result = await runHttpLaneTool(
      { id: "1", name: "computer_screenshot", arguments: {} },
      { threadId: "t", fromBotId: "bot-self", commsDepth: 0 },
    );
    expect(result).toMatch(/not wired to the HTTP tool executor/);
  });

  it("An unknown tool name returns a generic 'not implemented'", async () => {
    const result = await runHttpLaneTool(
      { id: "1", name: "mystery_tool", arguments: {} },
      { threadId: "t", fromBotId: "bot-self", commsDepth: 0 },
    );
    expect(result).toMatch(/not implemented/);
  });
});

describe("isToolCallsStopReason", () => {
  it("matches the inner-round prefix and ignores other settles", () => {
    expect(isToolCallsStopReason("tool_calls: ask_bot")).toBe(true);
    expect(isToolCallsStopReason("error")).toBe(false);
    expect(isToolCallsStopReason(null)).toBe(false);
  });
});

describe("buildToolContinuation", () => {
  it("puts the original user text before the tool call, not after the results", () => {
    const next = buildToolContinuation(
      { threadId: "t", text: "ping the peer", transcript: [] },
      [{ id: "c1", name: "ask_bot", arguments: { bot_id: "bot-peer", task: "hi" } }],
      [{ id: "c1", result: "ok" }],
    );
    expect(next.text).toBe("");
    expect(next.transcript?.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(next.transcript?.[0]?.text).toBe("ping the peer");
    expect(next.transcript?.[1]?.toolCalls?.[0]?.id).toBe("c1");
    expect(next.transcript?.[2]?.toolResults?.[0]?.result).toBe("ok");
  });
});

// Characterization tests for the CURRENT sendTurnWithToolLoop, run over the
// real pub/sub above instead of the old inert stub. These pin today's
// baseline behavior — two-round happy path, the round-cap return shape, and
// the per-round timeout — so PR 2's driver-owned loop has something
// concrete to match or beat, not just a description in a design doc.
describe("sendTurnWithToolLoop", () => {
  const publishEvent = (threadId: string, turnId: string, rest: Record<string, unknown>) =>
    // `bus` types against the real EventBus (RuntimeEvent-only) even though
    // the mock above swaps its implementation — these fixture events are
    // deliberately loose (only the fields runOneTurn's subscriber reads).
    (bus as { publish(event: unknown): void }).publish({
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
      provider: "fake",
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
      ...rest,
    });

  /** A fake driver instance whose `sendTurn` resolves immediately (as every
   *  real driver's does) and then asynchronously plays the next scripted
   *  round's events onto the bus — mirroring how a real driver's detached
   *  IIFE emits after `sendTurn` has already returned `{ turnId }`. */
  function scriptedInstance(scripts: Array<(threadId: string, turnId: string) => void>) {
    const calls: SendTurnInput[] = [];
    let round = 0;
    const sendTurn = vi.fn(async (input: SendTurnInput) => {
      calls.push(input);
      const turnId = `turn-${round + 1}`;
      const script = scripts[round++];
      queueMicrotask(() => script?.(input.threadId, turnId));
      return { turnId };
    });
    return { instance: { adapter: { sendTurn } } as unknown as ProviderInstance, calls };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a two-round tool exchange and settles on the model's final reply (also proves buildToolContinuation wiring)", async () => {
    const { instance, calls } = scriptedInstance([
      (threadId, turnId) => {
        publishEvent(threadId, turnId, {
          type: "item.started",
          itemType: "tool",
          itemId: "call-1",
          title: "list_bots",
          arguments: "",
        });
        publishEvent(threadId, turnId, { type: "item.completed", itemType: "tool", itemId: "call-1" });
        publishEvent(threadId, turnId, { type: "turn.completed", ok: true, stopReason: "tool_calls: list_bots" });
      },
      (threadId, turnId) => {
        publishEvent(threadId, turnId, { type: "item.completed", itemType: "assistant_text", text: "here are your bots" });
        publishEvent(threadId, turnId, { type: "turn.completed", ok: true, stopReason: null });
      },
    ]);

    const result = await sendTurnWithToolLoop(
      instance,
      { threadId: "thread-happy", text: "list my bots", transcript: [] },
      { threadId: "thread-happy", fromBotId: "bot-self", commsDepth: 0 },
    );

    expect(result).toEqual({ text: "here are your bots", ok: true, rounds: 2 });
    expect(calls).toHaveLength(2);

    const listBotsResult = JSON.stringify({
      section: "ops",
      bots: [
        { id: "bot-self", name: "self", title: "self title", description: "self desc", model: "test-model" },
        { id: "bot-peer", name: "peer", title: "peer title", description: "peer desc", model: "test-model" },
      ],
    });
    expect(calls[1]).toEqual(
      buildToolContinuation(
        calls[0],
        [{ id: "call-1", name: "list_bots", arguments: {} }],
        [{ id: "call-1", result: listBotsResult }],
      ),
    );
  });

  it("stops at the round cap with an unsettled (ok: false) result when the model keeps calling tools forever", async () => {
    const alwaysCallsAToolAndNeverStops = (threadId: string, turnId: string) => {
      publishEvent(threadId, turnId, {
        type: "item.started",
        itemType: "tool",
        itemId: `call-${turnId}`,
        title: "list_bots",
        arguments: "",
      });
      publishEvent(threadId, turnId, { type: "item.completed", itemType: "tool", itemId: `call-${turnId}` });
      publishEvent(threadId, turnId, { type: "turn.completed", ok: true, stopReason: "tool_calls: list_bots" });
    };
    const { instance, calls } = scriptedInstance(Array(10).fill(alwaysCallsAToolAndNeverStops));

    const result = await sendTurnWithToolLoop(
      instance,
      { threadId: "thread-cap", text: "loop forever", transcript: [] },
      { threadId: "thread-cap", fromBotId: "bot-self", commsDepth: 0 },
    );

    // MAX_TOOL_ROUNDS (5) is an internal constant, not exported — pinning
    // its externally-observable shape here, not the number itself, is the
    // point: a runaway model must not loop forever, and the loop must
    // report itself unsettled (ok: false) rather than silently succeeding.
    expect(result).toEqual({ text: "", ok: false, rounds: 5 });
    expect(calls).toHaveLength(5);
  });

  it("settles a round as a timeout under the internal per-round budget instead of hanging forever", async () => {
    vi.useFakeTimers();
    // sendTurn resolves — as a real driver's does at dispatch — but never
    // actually publishes a single bus event for this thread: the shape a
    // driver that crashed or hung mid-turn produces.
    const instance = {
      adapter: { sendTurn: vi.fn(async () => ({ turnId: "turn-hang" })) },
    } as unknown as ProviderInstance;

    const pending = sendTurnWithToolLoop(
      instance,
      { threadId: "thread-timeout", text: "hang", transcript: [] },
      { threadId: "thread-timeout", fromBotId: "bot-self", commsDepth: 0 },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    expect(result).toEqual({ text: "", ok: false, rounds: 1 });
  });
});
