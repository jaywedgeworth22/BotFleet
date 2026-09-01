// Node Sentry for the BotFleet harness.  Gated on SENTRY_DSN so unit
// tests and CI stay inert.  The SDK is loaded only after a DSN is present
// so importing this module in vitest does not pay the Node SDK tax.
// Browser Replay/Feedback live in src/lib/sentry.ts.
import { createRequire } from "node:module";

type SentryNode = typeof import("@sentry/node");

let initialized = false;
let sentrySdk: SentryNode | null = null;

export function sentryDsnFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = (env.SENTRY_DSN || env.BOTFLEET_SENTRY_DSN || "").trim();
  return raw || undefined;
}

export function initSentry(env: NodeJS.ProcessEnv = process.env): boolean {
  if (initialized) return true;
  if (env.VITEST === "true" || env.NODE_ENV === "test") return false;
  const dsn = sentryDsnFromEnv(env);
  if (!dsn) return false;

  const require = createRequire(import.meta.url);
  // SAFETY: lazy-load so vitest importing the harness does not boot the Node SDK.
  const Sentry = require("@sentry/node") as SentryNode;
  const tracesSampleRate = Number(env.SENTRY_TRACES_SAMPLE_RATE ?? "0.2");
  Sentry.init({
    dsn,
    environment: (env.SENTRY_ENV || env.NODE_ENV || "production").trim(),
    tracesSampleRate: Number.isFinite(tracesSampleRate)
      ? Math.min(Math.max(tracesSampleRate, 0), 1)
      : 0.2,
    enableLogs: true,
    sendDefaultPii: false,
  });
  sentrySdk = Sentry;
  initialized = true;
  return true;
}

export function isSentryInitialized(): boolean {
  return initialized;
}

export function getSentry(): SentryNode | null {
  return sentrySdk;
}

export function resetSentryForTests(): void {
  initialized = false;
  sentrySdk = null;
}
