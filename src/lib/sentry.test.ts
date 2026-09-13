import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  attachFeedbackEventDetails,
  buildFallbackIssueUrl,
  initSentry,
  initSentryFromRuntime,
  isSentryFeedbackAvailable,
  refreshSentryFromRuntime,
  resetSentryForTests,
  setActiveFeedbackDetailsForTests,
  setObservabilityReaderForTests,
  setSentryPortForTests,
  type ObservabilityReader,
  type RuntimeObservability,
  type SentryBrowserPort,
  type SentryClientOptions,
} from "./sentry";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

// Obviously fake.  Nothing in this suite may ever reach a real ingest host.
const RUNTIME_DSN = "https://abc123@o0.ingest.sentry.io/1";
// Same host, same project, rotated key — the shape a host-and-project
// comparison would wrongly call "unchanged".
const ROTATED_DSN = "https://def456@o0.ingest.sentry.io/1";
const BUILD_DSN = "https://build0key@o1.ingest.sentry.io/2";

interface FakeSentryRecord {
  inits: SentryClientOptions[];
  closes: number;
  running: boolean;
}

interface FakeSentry {
  record: FakeSentryRecord;
  port: SentryBrowserPort;
}

/** A stand-in for the browser SDK.  Records what the module asked it to do
 * so a test can assert on the close-and-re-init path without a real client
 * and without mocking the @sentry/react module. */
function fakeSentryPort(): FakeSentry {
  const record: FakeSentryRecord = { inits: [], closes: 0, running: false };
  const close = (): Promise<boolean> => {
    record.closes += 1;
    record.running = false;
    return Promise.resolve(true);
  };
  return {
    record,
    port: {
      init(options: SentryClientOptions): void {
        record.inits.push(options);
        record.running = true;
      },
      close,
      getClient: () => (record.running ? { close } : undefined),
    },
  };
}

interface FakeHarness {
  /** Script the next answer from `GET /api/observability`. */
  answer(next: RuntimeObservability | null): void;
  /** How many times the renderer has asked. */
  calls(): number;
  read: ObservabilityReader;
}

/** The harness answering `GET /api/observability`, scripted per test. */
function fakeHarness(): FakeHarness {
  let scripted: RuntimeObservability | null = null;
  let seen = 0;
  return {
    answer(next: RuntimeObservability | null): void {
      scripted = next;
    },
    calls: () => seen,
    read: async () => {
      seen += 1;
      return scripted;
    },
  };
}

describe("browser Sentry", () => {
  it("keeps Replay 100% on error / 10% session, Feedback, and mask-all privacy", () => {
    const src = readFileSync(join(ROOT, "src/lib/sentry.ts"), "utf8");
    expect(src).toMatch(/VITE_SENTRY_DSN/);
    expect(src).toMatch(/replaysSessionSampleRate[\s\S]*\?\? "0\.1"/);
    expect(src).toMatch(/replaysOnErrorSampleRate[\s\S]*\?\? "1\.0"/);
    expect(src).toMatch(/maskAllText:\s*true/);
    expect(src).toMatch(/blockAllMedia:\s*true/);
    expect(src).toMatch(/feedbackIntegration\(/);
    expect(src).toMatch(/autoInject:\s*false/);
    expect(src).toMatch(/enableLogs:\s*true/);
  });

  it("iOS Cocoa reads SENTRY_DSN from Info.plist only", () => {
    const swift = readFileSync(join(ROOT, "ios/App/SentryTelemetry.swift"), "utf8");
    expect(swift).toMatch(/forInfoDictionaryKey: "SENTRY_DSN"/);
    expect(swift).toMatch(/profilesSampleRate = 0\.1/);
    expect(swift).toMatch(/sessionReplay\.onErrorSampleRate = 1\.0/);
    expect(swift).not.toMatch(/ingest\.sentry\.io/);
    expect(swift).not.toMatch(/\?\? "https:\/\//);
    const yml = readFileSync(join(ROOT, "ios/project.yml"), "utf8");
    expect(yml).toMatch(/^\s+SENTRY_DSN:\s*""\s*$/m);
    expect(yml).toMatch(/^\s+SENTRY_DSN:\s*\$\(SENTRY_DSN\)\s*$/m);
    expect(yml).not.toMatch(/SENTRY_DSN:\s*"https:\/\//);
  });
});

// The renderer has its own Sentry client, and it used to be resolved exactly
// once at startup.  Disabling, removing, or replacing diagnostics in
// Settings reconfigured only the harness, so this window went on sending
// traces and replays to the DSN it booted with until someone reloaded it.
describe("renderer diagnostics refresh", () => {
  let sentry = fakeSentryPort();
  let harness = fakeHarness();

  beforeEach(() => {
    resetSentryForTests();
    sentry = fakeSentryPort();
    harness = fakeHarness();
    setSentryPortForTests(sentry.port);
    setObservabilityReaderForTests(harness.read);
    // The module refuses to touch the SDK outside a window.
    vi.stubGlobal("window", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetSentryForTests();
  });

  it("closes the old client and re-inits when the harness answers differently", async () => {
    harness.answer({ enabled: true, dsn: RUNTIME_DSN, environment: "production", tracesSampleRate: 0.2 });
    await initSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(1);
    expect(sentry.record.inits[0]).toMatchObject({
      dsn: RUNTIME_DSN,
      environment: "production",
      tracesSampleRate: 0.2,
    });

    harness.answer({ enabled: true, dsn: ROTATED_DSN, environment: "staging", tracesSampleRate: 0.5 });
    await refreshSentryFromRuntime();
    expect(sentry.record.closes).toBe(1);
    expect(sentry.record.inits).toHaveLength(2);
    expect(sentry.record.inits[1]).toMatchObject({
      dsn: ROTATED_DSN,
      environment: "staging",
      tracesSampleRate: 0.5,
    });
  });

  it("closes the client when the kill switch goes off, and starts nothing", async () => {
    harness.answer({ enabled: true, dsn: RUNTIME_DSN, environment: "production", tracesSampleRate: 0.2 });
    await initSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(1);

    harness.answer({ enabled: false, dsn: RUNTIME_DSN, environment: "production", tracesSampleRate: 0.2 });
    await refreshSentryFromRuntime();
    expect(sentry.record.closes).toBe(1);
    expect(sentry.record.inits).toHaveLength(1);

    // Still off, and a second look does not re-open it.
    await refreshSentryFromRuntime();
    expect(sentry.record.closes).toBe(1);
    expect(sentry.record.inits).toHaveLength(1);
  });

  it("closes the client when the diagnostics key is removed", async () => {
    harness.answer({ enabled: true, dsn: RUNTIME_DSN, environment: "production", tracesSampleRate: 0.2 });
    await initSentryFromRuntime();

    harness.answer({ enabled: true, dsn: null, environment: "production", tracesSampleRate: 0.2 });
    await refreshSentryFromRuntime();
    expect(sentry.record.closes).toBe(1);
    expect(sentry.record.inits).toHaveLength(1);
  });

  it("does nothing at all when the answer is unchanged", async () => {
    harness.answer({ enabled: true, dsn: RUNTIME_DSN, environment: "production", tracesSampleRate: 0.2 });
    await initSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(1);

    await refreshSentryFromRuntime();
    await refreshSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(1);
    expect(sentry.record.closes).toBe(0);
  });

  it("starts reporting when a DSN is added after boot", async () => {
    harness.answer({ enabled: true, dsn: null });
    await initSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(0);

    harness.answer({ enabled: true, dsn: RUNTIME_DSN, environment: "production", tracesSampleRate: 0.2 });
    await refreshSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(1);
    expect(sentry.record.inits[0]).toMatchObject({ dsn: RUNTIME_DSN });
    expect(sentry.record.closes).toBe(0);
  });

  it("leaves a build-time client pinned to the DSN the release was built with", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", BUILD_DSN);
    initSentry();
    expect(sentry.record.inits).toHaveLength(1);
    expect(sentry.record.inits[0]).toMatchObject({ dsn: BUILD_DSN });

    harness.answer({ enabled: false, dsn: null });
    await refreshSentryFromRuntime();
    expect(sentry.record.closes).toBe(0);
    expect(sentry.record.inits).toHaveLength(1);
    // The harness is never even asked: Settings governs the harness, not a
    // shipped build's own reporting.
    expect(harness.calls()).toBe(0);
  });

  it("stays inert when the harness will not answer", async () => {
    harness.answer(null);
    await initSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(0);

    await refreshSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(0);
    expect(sentry.record.closes).toBe(0);
  });

  it("buildFallbackIssueUrl bounds total encoded length and safely handles surrogate pairs and lone surrogates", () => {
    const hugeMessageWithEmoji = "Error: 🔥 something crashed 🚨 " + "x".repeat(10000) + " 💥";
    const url = buildFallbackIssueUrl("Error in Bot", hugeMessageWithEmoji, 2000);
    expect(url.length).toBeLessThanOrEqual(2000);
    expect(url).toContain("https://github.com/jaywedgeworth22/BotFleet/issues/new?title=");
    expect(url).toContain("Error%20in%20Bot");
    // Verify decodeURIComponent does not throw (meaning surrogate pairs were not split)
    expect(() => decodeURIComponent(url)).not.toThrow();

    // Lone surrogate string
    const loneSurrogate = "Broken surrogate: \uD800 invalid character";
    expect(() => buildFallbackIssueUrl("Issue \uD800", loneSurrogate)).not.toThrow();
    const loneUrl = buildFallbackIssueUrl("Issue \uD800", loneSurrogate);
    expect(() => decodeURIComponent(loneUrl)).not.toThrow();
  });

  it("isSentryFeedbackAvailable reflects client initialization state", () => {
    // When reset/uninitialized
    expect(isSentryFeedbackAvailable()).toBe(false);
  });

  it("attachFeedbackEventDetails binds diagnostic details strictly to feedback events", () => {
    setActiveFeedbackDetailsForTests("Diagnostic crash stack trace");

    // Standard exception or message event (not feedback)
    const errorEvent = { message: "Network timeout" } as import("@sentry/react").Event;
    const processedError = attachFeedbackEventDetails(errorEvent);
    expect(processedError.contexts).toBeUndefined();

    // Feedback event
    const feedbackEvent = { type: "feedback", contexts: { user_tag: { value: "user" } } } as import("@sentry/react").Event;
    const processedFeedback = attachFeedbackEventDetails(feedbackEvent);
    expect(processedFeedback.contexts).toEqual({
      user_tag: { value: "user" },
      reported_problem: {
        error_details: "Diagnostic crash stack trace",
      },
    });

    // When details cleared
    setActiveFeedbackDetailsForTests(null);
    const clearedFeedback = attachFeedbackEventDetails({ type: "feedback" } as import("@sentry/react").Event);
    expect(clearedFeedback.contexts).toBeUndefined();
  });
});
