/**
 * Sentry client observability for BotFleet.
 *
 * Gated on VITE_SENTRY_DSN (inlined by Vite at build time).
 * Completely inert in dev/CI when no DSN is provided.
 *
 * Replay stays 100% on error / 10% session with mask-all privacy.
 * User Feedback is the consumer widget.  Agent traces live on the
 * Node harness (`server/sentry.ts`), not this browser bundle.
 */

import * as Sentry from "@sentry/react";

let initialized = false;

/** Vite types every `import.meta.env` entry loosely, so read one through a
 * string-shaped door instead of asserting at each call site.  An entry that
 * was never inlined reads as undefined and the caller falls back. */
function viteEnvText(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export function initSentry(): void {
  if (initialized || !globalThis.window) return;

  const dsn = viteEnvText(import.meta.env.VITE_SENTRY_DSN);
  if (!dsn) return;

  const env = viteEnvText(import.meta.env.VITE_SENTRY_ENV) || viteEnvText(import.meta.env.MODE) || "production";

  const tracesSampleRate = Number(viteEnvText(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE) ?? "0.2");
  const replayRaw = viteEnvText(import.meta.env.VITE_SENTRY_REPLAY_ENABLED);
  const replayDisabled = replayRaw ? /^(false|0|off|no)$/i.test(replayRaw) : false;
  const replaysSessionSampleRate = Number(viteEnvText(import.meta.env.VITE_SENTRY_REPLAY_SESSION_SAMPLE_RATE) ?? "0.1");
  const replaysOnErrorSampleRate = Number(viteEnvText(import.meta.env.VITE_SENTRY_REPLAY_ERROR_SAMPLE_RATE) ?? "1.0");

  Sentry.init({
    dsn,
    environment: env,
    tracesSampleRate: Number.isFinite(tracesSampleRate) ? Math.min(Math.max(tracesSampleRate, 0), 1) : 0.2,
    enableLogs: true,
    replaysSessionSampleRate: !replayDisabled && Number.isFinite(replaysSessionSampleRate) ? replaysSessionSampleRate : 0,
    replaysOnErrorSampleRate: !replayDisabled && Number.isFinite(replaysOnErrorSampleRate) ? replaysOnErrorSampleRate : 0,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.feedbackIntegration({
        colorScheme: "light",
        autoInject: true,
        showBranding: false,
        buttonLabel: "Report a problem",
        submitButtonLabel: "Send",
        formTitle: "Report a problem",
      }),
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

/** What `GET /api/observability` answers with, narrowed to the four fields
 * the renderer needs.  The harness owns the full status view; anything else
 * on the response is deliberately ignored here. */
type RuntimeObservability = {
  enabled?: boolean;
  dsn?: string | null;
  environment?: string;
  tracesSampleRate?: number;
};

/**
 * Runtime fallback for the desktop app and dev/attached windows, where no
 * build-time VITE_SENTRY_DSN was inlined: ask the harness what it resolved
 * (env or ~/.botfleet/config.json) over `GET /api/observability` and start
 * the same browser SDK with that DSN.
 *
 * A no-op when `initSentry()` above already started the SDK from a
 * build-time DSN — public releases keep that path and never call the
 * harness. Swallows every failure; a harness that is unreachable, a 404
 * from an older harness, or a malformed response all leave the renderer
 * exactly as inert as it is today.
 */
export async function initSentryFromRuntime(): Promise<void> {
  if (initialized || !globalThis.window) return;

  try {
    // The same helper the settings store uses, so an attached webview and a
    // plain dev-server tab resolve the harness identically (retries once on
    // the 502 a harness restart briefly returns).
    const { api } = await import("@/state/store");
    const data: RuntimeObservability | null = await api("/api/observability");
    if (!data || initialized) return;

    const dsn = data.dsn?.trim();
    if (!data.enabled || !dsn) return;

    const env = data.environment?.trim() || "production";
    const reportedRate = data.tracesSampleRate;
    const tracesSampleRate =
      reportedRate !== undefined && Number.isFinite(reportedRate) ? reportedRate : 0.2;

    const replaysSessionSampleRate = Number(viteEnvText(import.meta.env.VITE_SENTRY_REPLAY_SESSION_SAMPLE_RATE) ?? "0.1");
    const replaysOnErrorSampleRate = Number(viteEnvText(import.meta.env.VITE_SENTRY_REPLAY_ERROR_SAMPLE_RATE) ?? "1.0");

    Sentry.init({
      dsn,
      environment: env,
      tracesSampleRate: Math.min(Math.max(tracesSampleRate, 0), 1),
      enableLogs: true,
      replaysSessionSampleRate: Number.isFinite(replaysSessionSampleRate) ? replaysSessionSampleRate : 0,
      replaysOnErrorSampleRate: Number.isFinite(replaysOnErrorSampleRate) ? replaysOnErrorSampleRate : 0,
      integrations: [
        Sentry.browserTracingIntegration(),
        Sentry.feedbackIntegration({
          colorScheme: "light",
          autoInject: true,
          showBranding: false,
          buttonLabel: "Report a problem",
          submitButtonLabel: "Send",
          formTitle: "Report a problem",
        }),
        Sentry.replayIntegration({
          maskAllText: true,
          blockAllMedia: true,
        }),
      ],
    });

    initialized = true;
  } catch {
    /* the harness may be unreachable (dev, or Settings > Observability
     * mid-restart) — the renderer stays exactly as inert as it is today */
  }
}
