// DeepSeek driver contract tests — fake fetch scripts HTTP + SSE. Covers
// stream_options.include_usage (otherwise Usage is always zero) and the
// model-rate cost that settles the turn for the Usage page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import {
  computeDeepSeekCost,
  DeepSeekDriver,
  usageFromDeepSeekApi,
} from "./deepseek.ts";

describe("computeDeepSeekCost", () => {
  it("prices V4 Flash / Pro / Reasoner from the Usage-page rates", () => {
    expect(computeDeepSeekCost("deepseek-v4-flash", { input: 1_000_000, output: 1_000_000 })).toBeCloseTo(0.21);
    expect(computeDeepSeekCost("deepseek-v4-pro", { input: 1_000, output: 500 })).toBeCloseTo(0.00028);
    expect(
      computeDeepSeekCost("deepseek-reasoner", { input: 1_000, output: 100, cachedInput: 800 }),
    ).toBeCloseTo(0.000441);
  });

  it("returns null without usage and inherits Pro rates for unknown models", () => {
    expect(computeDeepSeekCost("deepseek-v4-pro", null)).toBeNull();
    expect(computeDeepSeekCost("unknown-model", { input: 1_000_000, output: 0 })).toBeCloseTo(0.14);
  });

  it("reads cache hits from the DeepSeek usage object", () => {
    expect(
      usageFromDeepSeekApi({
        prompt_tokens: 12,
        completion_tokens: 3,
        prompt_cache_hit_tokens: 8,
      }),
    ).toEqual({ input: 12, output: 3, cachedInput: 8 });
  });
});

describe("DeepSeekDriver turns (fake fetch)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let lastBody: unknown;

  beforeEach(() => {
    process.env.FAKE_DEEPSEEK_RETRY_SCALE = "0.001";
    lastBody = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        lastBody = JSON.parse(String(init?.body));
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"prompt_cache_hit_tokens":4}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.FAKE_DEEPSEEK_RETRY_SCALE;
    recorder?.stop();
    await instance?.dispose();
  });

  it("requests streamed usage and settles the turn with a computed cost", async () => {
    instance = await DeepSeekDriver.create({
      instanceId: "deepseek-turn",
      displayName: "DeepSeek",
      enabled: true,
      config: DeepSeekDriver.defaultConfig(),
      environment: { DEEPSEEK_API_KEY: "secret" },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "thread",
      text: "hi",
      model: "deepseek-v4-flash",
    });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(lastBody).toMatchObject({
      model: "deepseek-v4-flash",
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(completed).toMatchObject({
      ok: true,
      usage: { input: 12, output: 3, cachedInput: 4 },
      cost: computeDeepSeekCost("deepseek-v4-flash", { input: 12, output: 3, cachedInput: 4 }),
    });
  });
});
