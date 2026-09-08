import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the heavy modules so this test only exercises the tool executor.
// The driver, the store, and askBotAndWait are swapped for fakes; the
// bus is created locally and never touches the real EventBus in index.ts.
vi.mock("./index.ts", () => {
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
    bus: {
      subscribe: () => () => undefined,
    },
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

import {
  buildToolContinuation,
  isToolCallsStopReason,
  parseToolArguments,
  runHttpLaneTool,
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
