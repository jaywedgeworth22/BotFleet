import { afterEach, describe, expect, it } from "vitest";
import {
  applySentryConfig,
  initSentry,
  isSentryActive,
  isSentryInitialized,
  resetSentryForTests,
  sentryDsnFromEnv,
  setSentryLoaderForTests,
} from "./sentry.ts";

afterEach(() => {
  resetSentryForTests();
  delete process.env.SENTRY_DSN;
  delete process.env.BOTFLEET_SENTRY_DSN;
  delete process.env.SENTRY_AI_DATA_COLLECTION;
});

describe("server Sentry init", () => {
  it("stays inert without a DSN", async () => {
    expect(sentryDsnFromEnv({})).toBeUndefined();
    expect(await initSentry({})).toBe(false);
    expect(isSentryInitialized()).toBe(false);
  });

  it("stays inert under vitest even when a DSN is present", async () => {
    expect(await initSentry({ VITEST: "true", SENTRY_DSN: "https://example.invalid/1" })).toBe(false);
    expect(isSentryInitialized()).toBe(false);
  });

  it("reads SENTRY_DSN then BOTFLEET_SENTRY_DSN", async () => {
    expect(sentryDsnFromEnv({ SENTRY_DSN: " https://example.invalid/1 " })).toBe("https://example.invalid/1");
    expect(sentryDsnFromEnv({ BOTFLEET_SENTRY_DSN: "https://example.invalid/2" })).toBe(
      "https://example.invalid/2",
    );
  });

  it("serializes concurrent applies so the same fingerprint inits once", async () => {
    let inits = 0;
    let inflight = 0;
    let maxInflight = 0;
    const sdk = {
      init() {
        inits += 1;
      },
      close() {
        return Promise.resolve(true);
      },
      addIntegration() {},
      consoleLoggingIntegration() {
        return { name: "ConsoleLogs" };
      },
    } as unknown as typeof import("@sentry/node");
    setSentryLoaderForTests(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inflight -= 1;
      return sdk;
    });
    const input = {
      dsn: "https://abc123@o0.ingest.sentry.io/1",
      enabled: true,
      environment: "test",
      tracesSampleRate: 0.2,
      logsEnabled: true,
      source: "config" as const,
    };
    const [first, second] = await Promise.all([applySentryConfig(input), applySentryConfig(input)]);
    expect(maxInflight).toBe(1);
    expect(inits).toBe(1);
    expect(first.active).toBe(true);
    expect(second.active).toBe(true);
    expect(isSentryActive()).toBe(true);
  });
});

describe("Sentry AI data collection kill-switch", () => {
  it("defaults ON and accepts 0/false/off/no as OFF", async () => {
    const { isGenAiDataCollectionEnabled, genAiDataCollectionOptions } = await import("./sentry.ts");
    expect(isGenAiDataCollectionEnabled({})).toBe(true);
    expect(isGenAiDataCollectionEnabled({ SENTRY_AI_DATA_COLLECTION: "1" })).toBe(true);
    expect(isGenAiDataCollectionEnabled({ SENTRY_AI_DATA_COLLECTION: "0" })).toBe(false);
    expect(isGenAiDataCollectionEnabled({ SENTRY_AI_DATA_COLLECTION: "false" })).toBe(false);
    expect(isGenAiDataCollectionEnabled({ SENTRY_AI_DATA_COLLECTION: "OFF" })).toBe(false);
    expect(isGenAiDataCollectionEnabled({ SENTRY_AI_DATA_COLLECTION: "no" })).toBe(false);
    expect(genAiDataCollectionOptions({ SENTRY_AI_DATA_COLLECTION: "1" })).toEqual({
      genAI: { inputs: true, outputs: true },
    });
    expect(genAiDataCollectionOptions({ SENTRY_AI_DATA_COLLECTION: "0" })).toEqual({
      genAI: { inputs: false, outputs: false },
    });
  });

  it("passes streamGenAiSpans and dataCollection into Sentry.init", async () => {
    let initOpts: Record<string, unknown> | null = null;
    const sdk = {
      init(opts: Record<string, unknown>) {
        initOpts = opts;
      },
      close() {
        return Promise.resolve(true);
      },
      addIntegration() {},
      consoleLoggingIntegration() {
        return { name: "ConsoleLogs" };
      },
    } as unknown as typeof import("@sentry/node");
    setSentryLoaderForTests(async () => sdk);
    process.env.SENTRY_AI_DATA_COLLECTION = "1";
    await applySentryConfig({
      dsn: "https://abc123@o0.ingest.sentry.io/1",
      enabled: true,
      environment: "test",
      tracesSampleRate: 0.2,
      logsEnabled: false,
      source: "config",
    });
    expect(initOpts).toMatchObject({
      streamGenAiSpans: true,
      dataCollection: { genAI: { inputs: true, outputs: true } },
    });

    resetSentryForTests();
    setSentryLoaderForTests(async () => sdk);
    process.env.SENTRY_AI_DATA_COLLECTION = "0";
    initOpts = null;
    await applySentryConfig({
      dsn: "https://abc123@o0.ingest.sentry.io/1",
      enabled: true,
      environment: "test",
      tracesSampleRate: 0.2,
      logsEnabled: false,
      source: "config",
    });
    expect(initOpts).toMatchObject({
      streamGenAiSpans: true,
      dataCollection: { genAI: { inputs: false, outputs: false } },
    });
    delete process.env.SENTRY_AI_DATA_COLLECTION;
  });
});
