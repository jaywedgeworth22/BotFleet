import { afterEach, describe, expect, it } from "vitest";
import { initSentry, isSentryInitialized, resetSentryForTests, sentryDsnFromEnv } from "./sentry.ts";

afterEach(() => {
  resetSentryForTests();
  delete process.env.SENTRY_DSN;
  delete process.env.BOTFLEET_SENTRY_DSN;
});

describe("server Sentry init", () => {
  it("stays inert without a DSN", () => {
    expect(sentryDsnFromEnv({})).toBeUndefined();
    expect(initSentry({})).toBe(false);
    expect(isSentryInitialized()).toBe(false);
  });

  it("stays inert under vitest even when a DSN is present", () => {
    expect(initSentry({ VITEST: "true", SENTRY_DSN: "https://example.invalid/1" })).toBe(false);
    expect(isSentryInitialized()).toBe(false);
  });

  it("reads SENTRY_DSN then BOTFLEET_SENTRY_DSN", () => {
    expect(sentryDsnFromEnv({ SENTRY_DSN: " https://example.invalid/1 " })).toBe("https://example.invalid/1");
    expect(sentryDsnFromEnv({ BOTFLEET_SENTRY_DSN: "https://example.invalid/2" })).toBe(
      "https://example.invalid/2",
    );
  });
});
