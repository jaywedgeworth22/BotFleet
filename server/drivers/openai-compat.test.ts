import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent, TurnToolHost } from "../contracts.ts";
import { RepeatDetector, callKey } from "../repeat-detector.ts";
import { recordEvents } from "../testing/events.ts";
import { startFakeOpenAiServer, type FakeOpenAiServer } from "../testing/fake-openai-server.ts";
import { OpenAICompatDriver, sentryProviderForUrl } from "./openai-compat.ts";

/** One scripted SSE response, [DONE]-terminated. */
const sse = (...frames: string[]) =>
  new Response(frames.map((f) => `data: ${f}\n`).join("") + "data: [DONE]\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

/** A host that answers every call, so the loop runs a second round the way
 *  it does in production.  The same fixture minimax.test.ts uses — both
 *  drivers assert the same wire contract. */
const answeringHost: TurnToolHost = {
  execute: async (call) => ({ kind: "result", content: `${call.name} ok` }),
};

/** Script the `/models` probe the driver fires on create, then one scripted
 *  reply per `/chat/completions` round. */
const stubRounds = (...rounds: Array<() => Response>) => {
  let round = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      const next = rounds[Math.min(round, rounds.length - 1)];
      round += 1;
      return next();
    }),
  );
};

describe("OpenAICompatDriver", () => {
  const savedUrl = process.env.OPENAI_COMPAT_URL;
  const savedKey = process.env.OPENAI_COMPAT_API_KEY;

  beforeEach(() => {
    delete process.env.OPENAI_COMPAT_URL;
    delete process.env.OPENAI_COMPAT_API_KEY;
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.OPENAI_COMPAT_URL;
    else process.env.OPENAI_COMPAT_URL = savedUrl;
    if (savedKey === undefined) delete process.env.OPENAI_COMPAT_API_KEY;
    else process.env.OPENAI_COMPAT_API_KEY = savedKey;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers with the openai-compat kind and a display name", () => {
    expect(OpenAICompatDriver.driverKind).toBe("openai-compat");
    expect(OpenAICompatDriver.metadata.displayName).toMatch(/OpenRouter|Groq/);
  });

  it("falls back to the OpenRouter endpoint by default", () => {
    const cfg = OpenAICompatDriver.defaultConfig();
    expect(cfg.url).toBe("https://openrouter.ai/api/v1");
    expect(cfg.apiKeyEnv).toBe("OPENAI_COMPAT_API_KEY");
  });

  it("honours an explicit url and apiKeyEnv override", () => {
    const cfg = OpenAICompatDriver.decodeConfig({
      url: "https://api.groq.com/openai/v1/",
      apiKeyEnv: "GROQ_KEY",
    });
    expect(cfg.url).toBe("https://api.groq.com/openai/v1");
    expect(cfg.apiKeyEnv).toBe("GROQ_KEY");
  });

  it("reports unavailable without an API key", async () => {
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-1",
      displayName: "Free",
      enabled: true,
      config: { url: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENAI_COMPAT_API_KEY" },
      environment: {},
    });
    const snap = await inst.snapshot();
    expect(snap.state).toBe("unavailable");
    await inst.dispose();
  });

  it("exposes a refreshed model catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "vendor/model-a", name: "Model A" },
              { id: "vendor/model-b" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-models",
      displayName: "Models",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });

    await inst.refreshModels?.();

    expect(inst.models).toEqual({
      default: "vendor/model-a",
      options: [
        { id: "vendor/model-a", label: "Model A" },
        { id: "vendor/model-b", label: "vendor/model-b" },
      ],
    });
    await inst.dispose();
  });

  it("includes streamed token totals in turn.completed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-turn",
      displayName: "Turn",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread", text: "private prompt", model: "vendor/model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 12, output: 3 } });
    recorder.stop();
    await inst.dispose();
  });

  it("streams reasoning separately and completes only actual assistant text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n' +
            'data: {"choices":[{"delta":{"content":"answer"}}]}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-reasoning-stream",
      displayName: "Reasoning",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "reasoning-thread", text: "question", model: "vendor/model" });
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
    await inst.dispose();
  });

  it("uses reasoning as a helper-model fallback when normal content is whitespace", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: "  ", reasoning_content: "usable result" } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-reasoning-helper",
      displayName: "Reasoning helper",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });

    await expect(inst.generateText?.("question")).resolves.toBe("usable result");
    await inst.dispose();
  });

  it("falls back to reasoning_content when content is empty (streaming)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"reasoning_content":"thinking through the problem"}}]}\n' +
            'data: {"choices":[{"delta":{"content":""}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-reasoning-fallback-stream",
      displayName: "Reasoning Fallback",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-rf", text: "prompt", model: "vendor/model" });
    const item = await recorder.until((e) => e.type === "item.completed");
    const completed = await recorder.until((e) => e.type === "turn.completed");

    expect(item).toMatchObject({
      type: "item.completed",
      itemType: "assistant_text",
      text: "thinking through the problem",
    });
    expect(completed).toMatchObject({ ok: true, usage: { input: 10, output: 5 } });

    const deltas = recorder.events.filter((e) => e.type === "content.delta");
    expect(deltas.some((d: any) => d.streamKind === "reasoning_text" && d.delta === "thinking through the problem")).toBe(true);

    recorder.stop();
    await inst.dispose();
  });
});

describe("OpenAICompatDriver tool steps", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("emits contract-shaped tool steps and settles each one with the host's real outcome", async () => {
    // it used to emit `tool_call.delta` and `itemType: "tool_call"`, neither
    // of which is in the RuntimeEvent union — both were cast past the type
    // checker, the harness had no arm for either, and a turn that called a
    // tool rendered no steps at all.
    //
    // Round 1 asks for a tool, round 2 answers.  The old driver settled the
    // TURN on round 1 with a `tool_calls: …` stop reason and left the
    // harness-side executor to re-feed it; the loop keeps one turn open
    // across both rounds and closes the step with what the host actually
    // returned.  This is minimax.test.ts's assertion, on the second driver.
    stubRounds(
      () =>
        sse(
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}',
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"file_path\\":\\"/srv/app/store.ts\\"}"}}]}}]}',
        ),
      () => sse('{"choices":[{"delta":{"content":"it reads the store"}}]}'),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-tool-steps",
      displayName: "Tools",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({
      threadId: "tool-thread",
      text: "read it",
      model: "vendor/model",
      tools: [{ name: "read_file" }],
      toolHost: answeringHost,
    });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    const started = recorder.events.filter(
      (event) => event.type === "item.started" && event.itemType === "tool",
    );
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ itemId: "call_1", title: "read_file", toolKind: "read" });

    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "item.completed", itemType: "tool", itemId: "call_1", ok: true }),
    );
    expect(completed).toMatchObject({ ok: true, stopReason: "end_turn" });
    // one terminal event for the whole two-round turn, not one per round
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    // the old off-contract shapes cannot recur: `tool_call.delta` and
    // `itemType: "tool_call"` are not in the RuntimeEvent union, so the type
    // checker now refuses them where an `as any` used to wave them through
    recorder.stop();
    await inst.dispose();
  });

  it("does not open a second step for a call whose arguments streamed in fragments", async () => {
    stubRounds(
      () =>
        sse(
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"bash","arguments":"{\\"comm"}}]}}]}',
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"arguments":"and\\":\\"ls\\"}"}}]}}]}',
        ),
      () => sse('{"choices":[{"delta":{"content":"done"}}]}'),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-tool-fragments",
      displayName: "Tools",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({
      threadId: "fragment-thread",
      text: "run it",
      model: "vendor/model",
      tools: [{ name: "bash" }],
      toolHost: answeringHost,
    });
    await recorder.until((event) => event.type === "turn.completed");

    const started = recorder.events.filter(
      (event) => event.type === "item.started" && event.itemType === "tool",
    );
    const completedSteps = recorder.events.filter(
      (event) => event.type === "item.completed" && event.itemType === "tool",
    );
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ itemId: "call_a", toolKind: "execute" });
    // the settled step must key on the SAME id the step opened under, or
    // the transcript row it belongs to can never be found
    expect(completedSteps).toHaveLength(1);
    expect(completedSteps[0]).toMatchObject({ itemId: "call_a", ok: true, arguments: '{"command":"ls"}' });
    recorder.stop();
    await inst.dispose();
  });

  it("forwards turn.tools to the endpoint in OpenAI function-calling shape", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      body = JSON.parse(String(init?.body));
      return sse('{"choices":[{"delta":{"content":"hi"}}]}');
    }));
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-tool-wire",
      displayName: "Tools",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({
      threadId: "wire-thread",
      text: "list my bots",
      model: "vendor/model",
      tools: [
        {
          name: "list_bots",
          description: "List every bot in the fleet.",
          parameters: { type: "object", properties: { section: { type: "string" } }, required: [] },
        },
        { name: "ask_bot", description: "Delegate a subtask to another bot.", parameters: { type: "object" } },
      ],
    });
    await recorder.until((event) => event.type === "turn.completed");

    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "list_bots",
          description: "List every bot in the fleet.",
          parameters: { type: "object", properties: { section: { type: "string" } }, required: [] },
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
    recorder.stop();
    await inst.dispose();
  });

  it("does not advertise a local-computer tool it never mounts", async () => {
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-caps",
      displayName: "Caps",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    expect(inst.adapter.capabilities.localComputerMcp).toBeFalsy();
    expect(await inst.adapter.respondToRequest("t", "r", { behavior: "allow" })).toBe("unavailable");
    await inst.dispose();
  });
});

describe("Sentry provider for an OpenAI-compatible endpoint", () => {
  it("names the vendor actually answering, not the wire shape", () => {
    expect(sentryProviderForUrl("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(sentryProviderForUrl("https://api.groq.com/openai/v1")).toBe("groq");
    expect(sentryProviderForUrl("https://api.openai.com/v1")).toBe("openai");
  });

  it("falls back to openai-compat for anything else, matching on host only", () => {
    expect(sentryProviderForUrl("http://127.0.0.1:8080/v1")).toBe("openai-compat");
    expect(sentryProviderForUrl("https://together.xyz/v1")).toBe("openai-compat");
    // A look-alike host must not be read as the real one.
    expect(sentryProviderForUrl("https://openrouter.ai.example.com/v1")).toBe("openai-compat");
    expect(sentryProviderForUrl("https://notgroq.com/v1")).toBe("openai-compat");
    expect(sentryProviderForUrl("not a url")).toBe("openai-compat");
  });
});

// The whole point of moving the loop into the driver: one terminal event per
// user turn, on EVERY exit.  These run against the real fake endpoint rather
// than a stubbed `fetch`, so the request bodies rounds 2..N actually send are
// assertable.
describe("OpenAICompatDriver on the driver-owned tool loop", () => {
  let server: FakeOpenAiServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const instanceOn = (url: string, id: string) =>
    OpenAICompatDriver.create({
      instanceId: id,
      displayName: "Loop",
      enabled: true,
      config: { url, apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });

  it("settles a two-round tool turn exactly once, banking the summed usage and re-sending a byte-identical prefix", async () => {
    server = await startFakeOpenAiServer();
    server.queueCompletion({
      kind: "sse",
      frames: [
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_bots","arguments":"{}"}}]}}]}',
        '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
        "[DONE]",
      ],
    });
    server.queueCompletion({
      kind: "sse",
      frames: [
        '{"choices":[{"delta":{"content":"two bots"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":7}}',
        "[DONE]",
      ],
    });
    const inst = await instanceOn(server.url, "loop-two-round");
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({
      threadId: "loop-thread",
      text: "list my bots",
      model: "fake-model",
      tools: [{ name: "list_bots" }],
      toolHost: answeringHost,
    });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    // ONE terminal event for a turn that made two model requests
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(completed).toMatchObject({
      ok: true,
      stopReason: "end_turn",
      usage: { input: 30, output: 12 },
    });
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "two bots" }),
    );

    const completions = server.requests.filter((r) => r.url.endsWith("/chat/completions"));
    expect(completions).toHaveLength(2);
    const first = (completions[0].body as { messages: unknown[] }).messages;
    const second = (completions[1].body as { messages: unknown[] }).messages;
    // round 2 only APPENDS — the prefix the endpoint already saw is never
    // rewritten, which is what keeps prompt caching reachable
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.slice(first.length)).toEqual([
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "list_bots", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "list_bots ok" },
    ]);

    recorder.stop();
    await inst.dispose();
  });

  it("settles the round cap in milliseconds with a chip, instead of leaving the bot busy", async () => {
    server = await startFakeOpenAiServer();
    const toolRound = {
      kind: "sse" as const,
      frames: [
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"list_bots","arguments":"{}"}}]}}]}',
        "[DONE]",
      ],
    };
    server.queueCompletion(toolRound);
    server.queueCompletion(toolRound);
    const inst = await instanceOn(server.url, "loop-round-cap");
    const recorder = recordEvents(inst.adapter);

    const startedAt = Date.now();
    await inst.adapter.sendTurn({
      threadId: "cap-thread",
      text: "go",
      model: "fake-model",
      tools: [{ name: "list_bots" }],
      toolHost: { maxRounds: 2, execute: async () => ({ kind: "result", content: "[]" }) },
    });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: false, stopReason: "tool_round_limit" });
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "runtime.error", message: expect.stringContaining("2 tool rounds") }),
    );
    // the cap is not the 900s wall clock in disguise
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    recorder.stop();
    await inst.dispose();
  });

  it("rejects a bad dispatch synchronously, so startTurn's own recovery runs in milliseconds", async () => {
    server = await startFakeOpenAiServer();
    const noKey = await OpenAICompatDriver.create({
      instanceId: "loop-no-key",
      displayName: "Loop",
      enabled: true,
      config: { url: server.url, apiKeyEnv: "TEST_KEY" },
      environment: {},
    });
    const recorder = recordEvents(noKey.adapter);

    await expect(
      noKey.adapter.sendTurn({ threadId: "reject-thread", text: "hi", model: "fake-model" }),
    ).rejects.toThrow(/no API key/);

    // a rejection is NOT a turn: nothing was started, so nothing has to be
    // settled and startTurn's catch owns the whole recovery
    expect(recorder.events).toHaveLength(0);
    expect(noKey.adapter.hasSession("reject-thread")).toBe(false);
    recorder.stop();
    await noKey.dispose();
  });
});

// The consumers that were previously guarded off — or silently reset — by
// the per-round `turn.completed`.  The repeat detector is the one whose
// failure was invisible: it settles on every turn.completed, so a bot going
// in circles across five HTTP rounds reset its own counter four times and
// the 5×/10×/20× chip it exists for could never fire.
describe("the repeat detector counts across rounds of one turn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reaches the 5× threshold on a turn that makes the same call five times", async () => {
    let round = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        round += 1;
        // five identical calls — same tool, same arguments, a new call id
        // each round exactly as a real provider mints them
        return round <= 5
          ? sse(
              `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_${round}","function":{"name":"read_file","arguments":"{\\"file_path\\":\\"/a\\"}"}}]}}]}`,
            )
          : sse('{"choices":[{"delta":{"content":"giving up"}}]}');
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "repeat-rounds",
      displayName: "Repeats",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({
      threadId: "circles",
      text: "read it",
      model: "vendor/model",
      tools: [{ name: "read_file" }],
      toolHost: answeringHost,
    });
    await recorder.until((event) => event.type === "turn.completed");

    // index.ts's subscriber, verbatim in the part that matters: count tool
    // steps, settle on the terminal event.
    const detector = new RepeatDetector({ thresholds: [5, 10, 20], maxKeysPerThread: 256 });
    const thresholds: number[] = [];
    const feed = (event: RuntimeEvent) => {
      if (event.type === "turn.completed") return void detector.settle(event.threadId);
      if (event.type !== "item.started" || event.itemType !== "tool") return;
      const key = callKey((event.title ?? "").trim(), event.arguments);
      if (!key) return;
      const { threshold } = detector.record(event.threadId, key);
      if (threshold) thresholds.push(threshold);
    };
    for (const event of recorder.events) feed(event);

    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(thresholds).toEqual([5]);
    recorder.stop();
    await inst.dispose();
  });
});
