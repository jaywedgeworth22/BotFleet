import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent, TurnToolHost } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { observeRuntimeEvent, resetSentryAiForTests, type SentryAiSink } from "../sentry-ai.ts";
import { costUsd } from "./chat-completions/pricing.ts";
import {
  decodeMinimaxConfig,
  isPricedMinimaxEndpoint,
  loadLocalMiniMaxConfig,
  MinimaxDriver,
  MINIMAX_PRICE_PER_MILLION,
} from "./minimax.ts";

/** One scripted SSE response, [DONE]-terminated. */
const sse = (...frames: string[]) =>
  new Response(frames.map((f) => `data: ${f}\n`).join("") + "data: [DONE]\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const TOOL_CALL_ROUND = [
  '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_bots","arguments":"{}"}}]}}]}',
  '{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"ask_bot","arguments":"{\\"bot_id\\":\\"@peer\\",\\"task\\":\\"hi\\"}"}}]}}]}',
  '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
];

const answeringHost: TurnToolHost = {
  execute: async (call) => ({ kind: "result", content: `${call.name} ok` }),
};

// SAFETY: every call site passes an event already matched by
// `event.type === "turn.completed"` via `recorder.until`, which is exactly
// the RuntimeEvent variant carrying `cost`.
const costOf = (event: RuntimeEvent): number | null => (event as { cost: number | null }).cost;

/** A minimal Sentry sink that just remembers which spans opened and whether
 *  each one was ended — enough to prove span COUNT and lifecycle without
 *  standing up real Sentry. */
function recordingSink() {
  const spans: Array<{ op: string; ended: boolean }> = [];
  const sink: SentryAiSink = {
    setConversationId: () => undefined,
    startInactiveSpan: (opts) => {
      const rec = { op: opts.op, ended: false };
      spans.push(rec);
      return {
        setAttribute: () => undefined,
        setStatus: () => undefined,
        end: () => {
          rec.ended = true;
        },
      };
    },
    captureException: () => undefined,
    addBreadcrumb: () => undefined,
  };
  return { sink, spans };
}

describe("MinimaxDriver", () => {
  const saved = {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    key: process.env.MINIMAX_API_KEY,
    url: process.env.MINIMAX_BASE_URL,
  };
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "botfleet-minimax-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_BASE_URL;
  });

  afterEach(() => {
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    if (saved.userProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = saved.userProfile;
    if (saved.key === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = saved.key;
    if (saved.url === undefined) delete process.env.MINIMAX_BASE_URL;
    else process.env.MINIMAX_BASE_URL = saved.url;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetSentryAiForTests();
  });

  it("sits on the Cloud rail as MiniMax, honestly — this driver spawns no CLI", () => {
    expect(MinimaxDriver.metadata.displayName).toBe("MiniMax");
    expect(MinimaxDriver.metadata.access).toBeUndefined();
  });

  it("offers only current official text models", () => {
    expect(MinimaxDriver.models).toEqual({
      default: "MiniMax-M3",
      options: [
        { id: "MiniMax-M3", label: "MiniMax M3", contextWindow: 1_000_000 },
        { id: "MiniMax-M2.7", label: "MiniMax M2.7", contextWindow: 204_800 },
        { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed", contextWindow: 204_800 },
      ],
    });
  });

  it("normalizes custom API roots", () => {
    expect(decodeMinimaxConfig({ url: "https://example.test/", apiKeyEnv: "CUSTOM_KEY" }))
      .toEqual({ url: "https://example.test/v1" });
  });

  it("reads the official mmx-cli config and honors its region and model", () => {
    const dir = join(home, ".mmx");
    mkdirSync(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      api_key: " local-key ",
      region: "cn",
      default_text_model: "MiniMax-M2.7-highspeed",
    }));

    expect(loadLocalMiniMaxConfig(home)).toEqual({
      apiKey: "local-key",
      url: "https://api.minimaxi.com/v1",
      defaultModel: "MiniMax-M2.7-highspeed",
    });
  });

  it("skips blank environment credentials and does not probe on snapshot", async () => {
    const dir = join(home, ".mmx");
    mkdirSync(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ api_key: "local-key" }));
    process.env.MINIMAX_API_KEY = "   ";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const instance = await MinimaxDriver.create({
      instanceId: "minimax-test",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "" },
    });

    await expect(instance.snapshot()).resolves.toMatchObject({ state: "available", authenticated: true });
    expect(fetchMock).not.toHaveBeenCalled();
    await instance.dispose();
  });

  it("streams content and usage with the MiniMax OpenAI contract", async () => {
    let request: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      request = init;
      return new Response(
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n' +
          "data: [DONE]\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-turn",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "private prompt" });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    const body = JSON.parse(String(request?.body));

    expect(body).toMatchObject({
      model: "MiniMax-M3",
      stream: true,
      reasoning_split: true,
      stream_options: { include_usage: true },
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(completed).toMatchObject({ ok: true, usage: { input: 12, output: 3 } });
    recorder.stop();
    await instance.dispose();
  });

  it("reports a bodyless stream clearly and releases the turn", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-empty",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
    const error = await recorder.until((event) => event.type === "runtime.error");
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(error).toMatchObject({ message: "MiniMax returned no response body" });
    expect(completed).toMatchObject({ ok: false, stopReason: "error" });
    expect(instance.adapter.hasSession("thread")).toBe(false);
    recorder.stop();
    await instance.dispose();
  });

  it("forwards turn.tools to the API in OpenAI function-calling shape", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\ndata: [DONE]\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-tools",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "thread",
      text: "list my bots",
      tools: [
        {
          name: "list_bots",
          description: "List every bot in the fleet.",
          parameters: {
            type: "object",
            properties: { section: { type: "string" } },
            required: [],
          },
        },
        {
          name: "ask_bot",
          description: "Delegate a subtask to another bot.",
          parameters: { type: "object" },
        },
      ],
    });
    await recorder.until((event) => event.type === "turn.completed");

    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "list_bots",
          description: "List every bot in the fleet.",
          parameters: {
            type: "object",
            properties: { section: { type: "string" } },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "ask_bot",
          description: "Delegate a subtask to another bot.",
          parameters: { type: "object" },
        },
      },
    ]);
    expect(body.tools).toHaveLength(2);
    recorder.stop();
    await instance.dispose();
  });

  it("streams tool_call deltas as item.started so steps render in the transcript", async () => {
    // Round 1 asks for a tool, round 2 answers.  The old driver settled the
    // TURN on round 1 with a `tool_calls: …` stop reason and left the bot
    // busy behind it; the loop keeps one turn open across both rounds.
    let round = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      round += 1;
      return round === 1
        ? sse(
            '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_bots","arguments":""}}]}}]}',
            '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"section\\":\\"ops\\"}"}}]}}]}',
            '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":""}}]}}]}',
          )
        : sse('{"choices":[{"delta":{"content":"two bots"}}]}');
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-tool-stream",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "thread",
      text: "list ops bots",
      tools: [{ name: "list_bots" }],
      toolHost: answeringHost,
    });
    const started = await recorder.until((event) => event.type === "item.started" && event.itemType === "tool");
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(started).toMatchObject({
      itemId: "call_1",
      title: "list_bots",
    });
    expect(completed).toMatchObject({ ok: true, stopReason: "end_turn" });
    // the row the streamed chip opened is closed by the host's real outcome,
    // never by the driver asserting ok for work it did not do
    expect(recorder.events.filter((e) => e.type === "item.started")).toHaveLength(1);
    recorder.stop();
    await instance.dispose();
  });

  it("keeps the first id and name for a tool call instead of letting a later chunk overwrite it", async () => {
    // openai-compat.ts's fix and comment: a provider that repeats the id
    // and name on a later chunk for the same call must not clobber the
    // value the first chunk already established, or a fragmented/corrupted
    // resend truncates the name and breaks the match to the item.started
    // step that already opened under the original id.
    let round = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      round += 1;
      return round === 1
        ? new Response(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"list_bots","arguments":"{\\"sec"}}]}}]}\n' +
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_stale","function":{"name":"list_b","arguments":"tion\\":\\"ops\\"}"}}]}}]}\n' +
            'data: [DONE]\n',
            { status: 200, headers: { "content-type": "text/event-stream" } },
          )
        : sse('{"choices":[{"delta":{"content":"done"}}]}');
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-tool-first-write-wins",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "thread",
      text: "list ops bots",
      tools: [{ name: "list_bots" }],
      toolHost: answeringHost,
    });
    await recorder.until((event) => event.type === "turn.completed");

    const started = recorder.events.filter((e) => e.type === "item.started" && e.itemType === "tool");
    const completedSteps = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ itemId: "call_a", title: "list_bots" });
    // the settled step must key on the SAME id the step opened under, or
    // the transcript row it belongs to can never be found
    expect(completedSteps).toHaveLength(1);
    expect(completedSteps[0]).toMatchObject({ itemId: "call_a", ok: true, arguments: '{"section":"ops"}' });
    recorder.stop();
    await instance.dispose();
  });

  it("flushes a final data: frame with no trailing newline instead of dropping it", async () => {
    // The frame carrying usage (stream_options.include_usage) can arrive as
    // the last thing the server writes before closing the connection, with
    // no terminating newline after it — the buffer must still be flushed
    // when the reader reports `done`, or this usage is silently lost.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-trailing-frame",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 9, output: 4 } });
    recorder.stop();
    await instance.dispose();
  });

  it("runs the tool loop inside sendTurn: one terminal event, summed usage, results in call order", async () => {
    const bodies: any[] = [];
    let round = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      round += 1;
      return round === 1
        ? sse(...TOOL_CALL_ROUND)
        : sse(
            '{"choices":[{"delta":{"content":"here you go"}}]}',
            '{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
          );
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-loop",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "thread",
      text: "who is around?",
      tools: [{ name: "list_bots" }, { name: "ask_bot" }],
      toolHost: answeringHost,
    });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    // ONE terminal event for the whole user turn, with the whole turn's cost
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(completed).toMatchObject({ ok: true, stopReason: "end_turn", usage: { input: 17, output: 8 } });
    // and nothing on the bus carries the old inner-round convention
    expect(
      recorder.events.filter(
        (e) => e.type === "turn.completed" && String(e.stopReason ?? "").startsWith("tool_calls:"),
      ),
    ).toHaveLength(0);

    // round 2 re-sends round 1's prefix byte for byte and appends the
    // assistant call plus one tool message per call, in CALL order
    expect(bodies).toHaveLength(2);
    expect(bodies[1].messages.slice(0, bodies[0].messages.length)).toEqual(bodies[0].messages);
    expect(bodies[1].messages.slice(-3)).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "list_bots", arguments: "{}" } },
          {
            id: "call_2",
            type: "function",
            function: { name: "ask_bot", arguments: '{"bot_id":"@peer","task":"hi"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "list_bots ok" },
      { role: "tool", tool_call_id: "call_2", content: "ask_bot ok" },
    ]);

    const toolRows = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(toolRows).toHaveLength(2);
    expect(toolRows.every((e) => (e as { ok: boolean }).ok)).toBe(true);
    expect(instance.adapter.hasSession("thread")).toBe(false);
    recorder.stop();
    await instance.dispose();
  });

  it("Stop settles a turn that is sitting inside a tool call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse(...TOOL_CALL_ROUND)));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-stop",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);
    let running: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      running = resolve;
    });

    await instance.adapter.sendTurn({
      threadId: "thread",
      text: "ask the peer",
      tools: [{ name: "ask_bot" }],
      // a tool that never returns — the window where Stop used to be a
      // silent no-op
      toolHost: { execute: async () => (running(), new Promise(() => undefined)) },
    });
    await started;
    await instance.adapter.interruptTurn("thread");
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: false, stopReason: "interrupted" });
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    // an interrupt is a decision, not a failure — no red chip
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toHaveLength(0);
    expect(instance.adapter.hasSession("thread")).toBe(false);
    recorder.stop();
    await instance.dispose();
  });

  it("rejects a bad dispatch synchronously, so startTurn's own recovery runs in milliseconds", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      }),
    ));
    const keyless = await MinimaxDriver.create({
      instanceId: "minimax-nokey",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: {},
    });
    await expect(keyless.adapter.sendTurn({ threadId: "thread", text: "hi" })).rejects.toThrow(/no MiniMax key/);
    await keyless.dispose();

    const instance = await MinimaxDriver.create({
      instanceId: "minimax-busy",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    // sendTurn resolves at DISPATCH — the loop runs detached, the way every
    // CLI driver's turn does
    await instance.adapter.sendTurn({ threadId: "thread", text: "first" });
    await expect(instance.adapter.sendTurn({ threadId: "thread", text: "second" })).rejects.toThrow(
      /already running/,
    );
    await instance.dispose();
  });

  it("streams reasoning separately and completes only actual assistant text", async () => {
    // MiniMax sends reasoning_split: true on every request; before this fix
    // the driver read no reasoning field at all on any path.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n' +
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n' +
      "data: [DONE]\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-reasoning-stream",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "reasoning-thread", text: "question" });
    await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "content.delta", streamKind: "reasoning_text", delta: "thinking" }),
      expect.objectContaining({ type: "content.delta", streamKind: "assistant_text", delta: "answer" }),
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "answer" }),
    ]));
    expect(recorder.events).not.toContainEqual(
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "thinking" }),
    );
    recorder.stop();
    await instance.dispose();
  });

  it("falls back to reasoning_content when assistant text is empty, so an all-reasoning reply is not an empty turn", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"reasoning_content":"thinking through the problem"}}]}\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n' +
      "data: [DONE]\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-reasoning-fallback",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread-rf", text: "prompt" });
    const item = await recorder.until((e) => e.type === "item.completed");
    const completed = await recorder.until((e) => e.type === "turn.completed");

    expect(item).toMatchObject({
      type: "item.completed",
      itemType: "assistant_text",
      text: "thinking through the problem",
    });
    expect(completed).toMatchObject({ ok: true, usage: { input: 10, output: 5 } });
    recorder.stop();
    await instance.dispose();
  });

  it("uses reasoning as a generateText fallback when normal content is whitespace (non-stream path)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "  ", reasoning_content: "usable result" } }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-reasoning-nonstream",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });

    await expect(instance.generateText?.("question")).resolves.toBe("usable result");
    await instance.dispose();
  });

  it("reports usage the stream already showed even when the request fails mid-stream", async () => {
    // A request timeout or upstream 5xx after several chunks previously
    // reported zero usage on the failure path, hiding real spend on a long
    // turn that happened to fail at the end.
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(
            new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":9}}\n'),
          );
          return;
        }
        controller.error(new Error("stream exploded"));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-usage-on-failure",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread-fail", text: "hi" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: false, stopReason: "error", usage: { input: 20, output: 9 } });
    recorder.stop();
    await instance.dispose();
  });
  it("has a real price row for every model in its own catalog", () => {
    for (const option of MinimaxDriver.models.options) {
      expect(Object.prototype.hasOwnProperty.call(MINIMAX_PRICE_PER_MILLION, option.id)).toBe(true);
    }
  });

  it("prices a settled turn from its real usage, at the M3 ≤512K-token rate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sse(
        '{"choices":[{"delta":{"content":"here you go"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":100000,"completion_tokens":50000}}',
      ),
    ));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-price",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 100_000, output: 50_000 } });
    // (100,000 @ $0.30/M) + (50,000 @ $1.20/M) = $0.03 + $0.06 = $0.09
    expect(costOf(completed)).toBeCloseTo(0.09, 10);
    expect(costOf(completed)).toBe(
      costUsd({ input: 100_000, output: 50_000 }, MINIMAX_PRICE_PER_MILLION, "MiniMax-M3"),
    );
    recorder.stop();
    await instance.dispose();
  });

  it("reads prompt_tokens_details.cached_tokens into cachedInput and bills it at the cache rate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sse(
        '{"choices":[{"delta":{"content":"here you go"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":100000,"completion_tokens":10000,"prompt_tokens_details":{"cached_tokens":40000}}}',
      ),
    ));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-cache",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({
      ok: true,
      usage: { input: 100_000, output: 10_000, cachedInput: 40_000 },
    });
    // 60,000 uncached @ $0.30/M + 40,000 cached @ $0.06/M + 10,000 out @ $1.20/M
    // = $0.018 + $0.0024 + $0.012 = $0.0324
    expect(costOf(completed)).toBeCloseTo(0.0324, 10);
    recorder.stop();
    await instance.dispose();
  });

  it("returns a null cost — never 0 — for a model outside the priced catalog, even with real usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sse(
        '{"choices":[{"delta":{"content":"hi"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50}}',
      ),
    ));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-unpriced-model",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hi", model: "MiniMax-Unreleased" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 100, output: 50 } });
    expect(costOf(completed)).toBeNull();
    recorder.stop();
    await instance.dispose();
  });

  it("prices the terminal event on the ERROR path too, from the usage a successful earlier round already reported", async () => {
    let round = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      round += 1;
      if (round === 1) return sse(...TOOL_CALL_ROUND);
      throw new Error("network down");
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-error-cost",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "thread",
      text: "who is around?",
      tools: [{ name: "list_bots" }, { name: "ask_bot" }],
      toolHost: answeringHost,
    });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    // TOOL_CALL_ROUND's own usage: prompt_tokens: 10, completion_tokens: 5
    expect(completed).toMatchObject({ ok: false, stopReason: "error", usage: { input: 10, output: 5 } });
    expect(costOf(completed)).toBeCloseTo(
      costUsd({ input: 10, output: 5 }, MINIMAX_PRICE_PER_MILLION, "MiniMax-M3")!,
      12,
    );
    recorder.stop();
    await instance.dispose();
  });

  it("knows which endpoints its published rates actually describe", () => {
    expect(isPricedMinimaxEndpoint("https://api.minimax.io/v1")).toBe(true);
    expect(isPricedMinimaxEndpoint("https://api.minimaxi.com/v1")).toBe(true);
    // case and a trailing slash are the same endpoint
    expect(isPricedMinimaxEndpoint("https://API.MiniMax.io/v1/")).toBe(true);
    // a gateway, a reseller, a self-hosted deployment — none of them
    // necessarily bills at MiniMax's own tariff
    expect(isPricedMinimaxEndpoint("https://gateway.internal.example/v1")).toBe(false);
    expect(isPricedMinimaxEndpoint("https://api.minimax.io.evil.example/v1")).toBe(false);
    expect(isPricedMinimaxEndpoint("not a url")).toBe(false);
  });

  it("reports a null cost — never MiniMax's own tariff — for a turn against a custom endpoint", async () => {
    // config.url and MINIMAX_BASE_URL are supported overrides for a
    // gateway or proxy whose billing this driver knows nothing about, and
    // a finite cost is stored downstream as real spend.
    vi.stubGlobal("fetch", vi.fn(async () =>
      sse(
        '{"choices":[{"delta":{"content":"hi"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":100000,"completion_tokens":50000}}',
      ),
    ));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-gateway",
      displayName: "MiniMax",
      enabled: true,
      config: decodeMinimaxConfig({ url: "https://gateway.internal.example" }),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    // the usage is real and still reported; only the price is unknown
    expect(completed).toMatchObject({ ok: true, usage: { input: 100_000, output: 50_000 } });
    expect(costOf(completed)).toBeNull();
    recorder.stop();
    await instance.dispose();
  });

  it("still prices a turn against MiniMax's own China endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sse(
        '{"choices":[{"delta":{"content":"hi"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":100000,"completion_tokens":50000}}',
      ),
    ));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-cn",
      displayName: "MiniMax",
      enabled: true,
      config: decodeMinimaxConfig({ url: "https://api.minimaxi.com" }),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(costOf(completed)).toBeCloseTo(0.09, 10);
    recorder.stop();
    await instance.dispose();
  });

  it("routes generateText (titles, summaries) through the highspeed utility model, not models.default", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "a title" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-utility-model",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });

    const text = await instance.generateText?.("Summarize this thread in five words.");

    expect(text).toBe("a title");
    expect(body.model).toBe("MiniMax-M2.7-highspeed");
    expect(body.model).not.toBe(MinimaxDriver.models.default);
    await instance.dispose();
  });

  // withChatSpan's OWN default sink resolves through the real, un-stubbed
  // Sentry loader (server/sentry.ts), which is inert under VITEST — so it
  // is a transparent pass-through here, exactly as it is in every other
  // test in this file, and its own span-emitting behavior is unit-tested
  // in sentry-ai.test.ts against a fake sink it is handed directly.  What
  // IS observable at the driver level, with no Sentry stubbing at all, is
  // the generic event-driven path every consumer (including the real
  // server/index.ts bus) actually uses: turn.started/item.started/
  // item.completed/turn.completed feed observeRuntimeEvent, which is what
  // produces the invoke_agent and execute_tool spans this test asserts on.
  it("produces one invoke_agent span with one execute_tool child per tool call — never duplicated by also calling recordExecutedTools", async () => {
    const { sink, spans } = recordingSink();
    let round = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      round += 1;
      return round === 1
        ? sse(...TOOL_CALL_ROUND)
        : sse(
            '{"choices":[{"delta":{"content":"here you go"}}]}',
            '{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
          );
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-spans",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    // Mirrors how server/index.ts's real bus feeds EVERY driver's events
    // through observeRuntimeEvent generically — nothing MiniMax-specific
    // is wired here, which is the whole point.
    instance.adapter.onEvent((event) => observeRuntimeEvent(event, sink));
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "thread",
      text: "who is around?",
      tools: [{ name: "list_bots" }, { name: "ask_bot" }],
      toolHost: answeringHost,
    });
    await recorder.until((event) => event.type === "turn.completed");

    expect(spans.filter((s) => s.op === "gen_ai.invoke_agent")).toHaveLength(1);
    // one execute_tool span per tool call, from item.started/item.completed
    // alone — recordExecutedTools is deliberately NOT also called for this
    // driver, or this count would be 4, not 2
    expect(spans.filter((s) => s.op === "gen_ai.execute_tool")).toHaveLength(2);
    expect(spans.every((s) => s.ended)).toBe(true);
    recorder.stop();
    await instance.dispose();
  });
});
