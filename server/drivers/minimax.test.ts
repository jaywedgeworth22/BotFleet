import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TurnToolHost } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { decodeMinimaxConfig, loadLocalMiniMaxConfig, MinimaxDriver } from "./minimax.ts";

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
  });

  it("sits on the Cloud rail as MiniMax CLI", () => {
    expect(MinimaxDriver.metadata.displayName).toBe("MiniMax CLI");
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
});
