/**
 * Sentry client observability for BotFleet.
 *
 * Gated on VITE_SENTRY_DSN (inlined by Vite at build time).
 * Completely inert in dev/CI when no DSN is provided.
 *
 * Utilizes the fleet's $5,000 sponsored credit with:
 * - Error tracking & boundary capture
 * - Session Replay (100% on error, 10% baseline session)
 * - Distributed tracing & browser navigation spans
 * - Strict text & media masking for agent chat privacy
 */

import * as Sentry from "@sentry/react";

let initialized = false;

export function initSentry(): void {
  if (initialized || typeof window === "undefined") return;

  const dsn = (import.meta.env.VITE_SENTRY_DSN as string | undefined)?.trim();
  if (!dsn) return;

  const env = (import.meta.env.VITE_SENTRY_ENV as string | undefined)?.trim() ||
    (import.meta.env.MODE as string | undefined) ||
    "production";

  const tracesSampleRate = Number(
    (import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE as string | undefined)?.trim() ?? "0.2"
  );
  const replayRaw = (import.meta.env.VITE_SENTRY_REPLAY_ENABLED as string | undefined)?.trim();
  const replayDisabled = replayRaw ? /^(false|0|off|no)$/i.test(replayRaw) : false;
  const replaysSessionSampleRate = Number(
    (import.meta.env.VITE_SENTRY_REPLAY_SESSION_SAMPLE_RATE as string | undefined)?.trim() ?? "0.1"
  );
  const replaysOnErrorSampleRate = Number(
    (import.meta.env.VITE_SENTRY_REPLAY_ERROR_SAMPLE_RATE as string | undefined)?.trim() ?? "1.0"
  );

  Sentry.init({
    dsn,
    environment: env,
    tracesSampleRate: Number.isFinite(tracesSampleRate) ? Math.min(Math.max(tracesSampleRate, 0), 1) : 0.2,
    enableLogs: true,
    replaysSessionSampleRate: !replayDisabled && Number.isFinite(replaysSessionSampleRate) ? replaysSessionSampleRate : 0,
    replaysOnErrorSampleRate: !replayDisabled && Number.isFinite(replaysOnErrorSampleRate) ? replaysOnErrorSampleRate : 0,
    integrations: [
      Sentry.browserTracingIntegration(),
      ...(!replayDisabled
        ? [
            Sentry.replayIntegration({
              maskAllText: true,
              blockAllMedia: true,
            }),
          ]
        : []),
    ],
  });

  initialized = true;
}

export const SentryErrorBoundary = Sentry.ErrorBoundary;
export const captureException = Sentry.captureException;
export const captureMessage = Sentry.captureMessage;
