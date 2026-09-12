import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  initSentry,
  initSentryFromRuntime,
  refreshSentryFromRuntime,
  resetSentryForTests,
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
    expect(src).toMatch(/autoInject:\s*true/);
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

  it("applies the runtime kill switch to a packaged build and can re-enable with a changed key", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", BUILD_DSN);
    vi.stubEnv("VITE_SENTRY_ENV", "production");
    vi.stubEnv("VITE_SENTRY_TRACES_SAMPLE_RATE", "0.2");
    initSentry();
    expect(sentry.record.inits).toHaveLength(1);
    expect(sentry.record.inits[0]).toMatchObject({ dsn: BUILD_DSN });

    harness.answer({ enabled: false, requestedEnabled: false, dsn: null });
    await initSentryFromRuntime();
    expect(sentry.record.closes).toBe(1);
    expect(sentry.record.inits).toHaveLength(1);

    harness.answer({ enabled: false, requestedEnabled: true, dsn: null, environment: "production", tracesSampleRate: 0.2 });
    await refreshSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(2);
    expect(sentry.record.inits[1]).toMatchObject({ dsn: BUILD_DSN });

    harness.answer({ enabled: true, requestedEnabled: true, dsn: ROTATED_DSN, environment: "staging", tracesSampleRate: 0.5 });
    await refreshSentryFromRuntime();
    expect(sentry.record.closes).toBe(2);
    expect(sentry.record.inits).toHaveLength(3);
    expect(sentry.record.inits[2]).toMatchObject({ dsn: ROTATED_DSN, environment: "staging", tracesSampleRate: 0.5 });
    expect(harness.calls()).toBe(3);
  });

  it("keeps a packaged client running when the runtime status is unavailable", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", BUILD_DSN);
    initSentry();
    harness.answer(null);

    await initSentryFromRuntime();

    expect(harness.calls()).toBe(1);
    expect(sentry.record.inits).toHaveLength(1);
    expect(sentry.record.closes).toBe(0);
    expect(sentry.record.running).toBe(true);
  });

  it("keeps normal packaged diagnostics when the harness is merely unconfigured", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", BUILD_DSN);
    initSentry();
    harness.answer({ enabled: false, requestedEnabled: true, dsn: null });

    await initSentryFromRuntime();

    expect(sentry.record.inits).toHaveLength(1);
    expect(sentry.record.closes).toBe(0);
    expect(sentry.record.running).toBe(true);
  });

  it("ignores a stale boot answer when a newer Settings refresh finishes first", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", BUILD_DSN);
    initSentry();
    let finishBoot: ((value: RuntimeObservability) => void) | undefined;
    setObservabilityReaderForTests(() => new Promise((resolve) => { finishBoot = resolve; }));
    const boot = initSentryFromRuntime();

    setObservabilityReaderForTests(async () => ({ enabled: false, requestedEnabled: false, dsn: null }));
    await refreshSentryFromRuntime();
    finishBoot?.({ enabled: true, requestedEnabled: true, dsn: RUNTIME_DSN });
    await boot;

    expect(sentry.record.closes).toBe(1);
    expect(sentry.record.inits).toHaveLength(1);
    expect(sentry.record.running).toBe(false);
  });

  it("stays inert when the harness will not answer", async () => {
    harness.answer(null);
    await initSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(0);

    await refreshSentryFromRuntime();
    expect(sentry.record.inits).toHaveLength(0);
    expect(sentry.record.closes).toBe(0);
  });
});
