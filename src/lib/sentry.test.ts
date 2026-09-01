import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

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
    expect(swift).not.toMatch(/ingest\.sentry\.io/);
    expect(swift).not.toMatch(/\?\? "https:\/\//);
    const yml = readFileSync(join(ROOT, "ios/project.yml"), "utf8");
    expect(yml).toMatch(/^\s+SENTRY_DSN:\s+"https:\/\//m);
  });
});
