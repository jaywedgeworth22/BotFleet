/**
 * Sentry client observability for BotFleet.
 *
 * Two ways in, and they do not mix.  `initSentry()` uses VITE_SENTRY_DSN,
 * inlined by Vite at build time — that is the public release path, it wins,
 * and it is never re-configured at runtime: a shipped build reports to the
 * DSN it was built with for the life of the window.  Everything else (the
 * desktop app, dev, an attached webview) has no inlined DSN and asks the
 * harness instead, through `initSentryFromRuntime()` at boot and
 * `refreshSentryFromRuntime()` after Settings > Observability changes.
 * Completely inert in dev/CI when neither path finds a DSN.
 *
 * Replay stays 100% on error / 10% session with mask-all privacy.
 * User Feedback is the consumer widget.  Agent traces live on the
 * Node harness (`server/sentry.ts`), not this browser bundle.
 */

import * as Sentry from "@sentry/react";

/** Everything that decides what a client this module starts will do.  The
 * rest of the browser SDK's configuration is fixed here, so a stand-in
 * installed by a test does not have to reproduce any of it. */
export interface SentryClientOptions {
  dsn: string;
  environment: string;
  tracesSampleRate: number;
  replayEnabled: boolean;
  replaysSessionSampleRate: number;
  replaysOnErrorSampleRate: number;
}

/** The three things this module does to the browser SDK.  Behind a port so
 * a test can install a stand-in and drive the real control flow, the way
 * `setSentryLoaderForTests` does for the harness in `server/sentry.ts`. */
export interface SentryBrowserPort {
  init(options: SentryClientOptions): void;
  close(): PromiseLike<boolean>;
  getClient(): { close(): PromiseLike<boolean> } | undefined;
}

/** What `GET /api/observability` answers with, narrowed to the four fields
 * the renderer needs.  The harness owns the full status view; anything else
 * on the response is deliberately ignored here. */
export interface RuntimeObservability {
  enabled?: boolean;
  dsn?: string | null;
  environment?: string;
  tracesSampleRate?: number;
}

/** How the renderer asks the harness what it resolved. */
export type ObservabilityReader = () => Promise<RuntimeObservability | null>;

const browserPort: SentryBrowserPort = {
  init(options: SentryClientOptions): void {
    Sentry.init({
      dsn: options.dsn,
      environment: options.environment,
      tracesSampleRate: options.tracesSampleRate,
      enableLogs: true,
      replaysSessionSampleRate: options.replaysSessionSampleRate,
      replaysOnErrorSampleRate: options.replaysOnErrorSampleRate,
      integrations: [
        Sentry.browserTracingIntegration(),
        Sentry.feedbackIntegration({
          colorScheme: "light",
          autoInject: false,
          showBranding: false,
          buttonLabel: "Report a problem",
          submitButtonLabel: "Send",
          formTitle: "Report a problem",
        }),
        ...(options.replayEnabled
          ? [
              Sentry.replayIntegration({
                maskAllText: true,
                blockAllMedia: true,
              }),
            ]
          : []),
      ],
    });
  },
  close: () => Sentry.close(),
  getClient: () => Sentry.getClient(),
};

const harnessReader: ObservabilityReader = async () => {
  // The same helper the settings store uses, so an attached webview and a
  // plain dev-server tab resolve the harness identically (retries once on
  // the 502 a harness restart briefly returns).
  const { api } = await import("@/state/store");
  const data: RuntimeObservability | null = await api("/api/observability");
  return data;
};

let sentryPort: SentryBrowserPort = browserPort;
let readObservability: ObservabilityReader = harnessReader;

/** A client is running, whichever path started it. */
let initialized = false;
/**
 * The build-time DSN won, so the runtime path must not touch the SDK.
 * Release and package workflows bake VITE_SENTRY_DSN in; reconfiguring that
 * client from `GET /api/observability` would let a harness setting silently
 * redirect or silence a shipped build's own reporting.  Settings governs the
 * harness, and this flag is what keeps the two apart.
 */
let buildTimeDsnActive = false;
/**
 * DSN, environment and trace rate of the client the *runtime* path started,
 * or null when it has none running.  Compared on every refresh so an
 * unchanged answer from the harness leaves the client alone instead of
 * tearing one down and rebuilding it on every save.  Renderer-local and
 * never logged; it lives in the process that already holds the DSN.
 */
let runtimeIdentity: string | null = null;

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

  sentryPort.init({
    dsn,
    environment: env,
    tracesSampleRate: Number.isFinite(tracesSampleRate) ? Math.min(Math.max(tracesSampleRate, 0), 1) : 0.2,
    replayEnabled: !replayDisabled,
    replaysSessionSampleRate: !replayDisabled && Number.isFinite(replaysSessionSampleRate) ? replaysSessionSampleRate : 0,
    replaysOnErrorSampleRate: !replayDisabled && Number.isFinite(replaysOnErrorSampleRate) ? replaysOnErrorSampleRate : 0,
  });

  initialized = true;
  // Pin the runtime path off for the life of this window.  See the flag.
  buildTimeDsnActive = true;
}

export const SentryErrorBoundary = Sentry.ErrorBoundary;
export const captureException = Sentry.captureException;
export const captureMessage = Sentry.captureMessage;

export interface OpenFeedbackOptions {
  formTitle?: string;
  defaultMessage?: string;
  defaultEmail?: string;
  defaultName?: string;
}

interface SentryFeedbackDialog {
  appendToDom(): void;
  open(): void;
  close(): void;
  removeFromDom(): void;
}

let activeFeedbackDialog: SentryFeedbackDialog | null = null;
let isCreatingFeedback = false;
let activeFeedbackDetails: string | null = null;
let feedbackProcessorInstalled = false;

export function attachFeedbackEventDetails<T extends Sentry.Event>(event: T): T {
  if (event.type === "feedback" && activeFeedbackDetails) {
    return {
      ...event,
      contexts: {
        ...event.contexts,
        reported_problem: {
          error_details: activeFeedbackDetails,
        },
      },
    };
  }
  return event;
}

export function setActiveFeedbackDetailsForTests(details: string | null): void {
  activeFeedbackDetails = details;
}

function ensureFeedbackEventProcessor(): void {
  if (feedbackProcessorInstalled) return;
  feedbackProcessorInstalled = true;
  Sentry.addEventProcessor((event) => attachFeedbackEventDetails(event));
}

function toWellFormedString(val: string): string {
  if (typeof (val as { toWellFormed?: () => string }).toWellFormed === "function") {
    return (val as unknown as { toWellFormed: () => string }).toWellFormed();
  }
  let result = "";
  for (let i = 0; i < val.length; i++) {
    const code = val.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < val.length) {
        const next = val.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          result += val[i] + val[i + 1];
          i++;
          continue;
        }
      }
      result += "\uFFFD";
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\uFFFD";
    } else {
      result += val[i];
    }
  }
  return result;
}

export function buildFallbackIssueUrl(
  rawTitle: string,
  rawMessage?: string,
  maxTotalLength = 2000,
): string {
  const wellFormedTitle = toWellFormedString(rawTitle || "Bug Report");
  const points = Array.from(wellFormedTitle);
  const safeTitle = (points.length > 80 ? points.slice(0, 80).join("") + "…" : points.join(""));
  const encodedTitle = encodeURIComponent(safeTitle);
  const base = `https://github.com/jaywedgeworth22/BotFleet/issues/new?title=${encodedTitle}&body=`;
  const budget = maxTotalLength - base.length;
  if (budget <= 0) return base;

  if (!rawMessage) {
    const defaultBody = "<!-- Describe the problem and reproduction steps here -->\n\n*(Submitted via BotFleet)*";
    return base + encodeURIComponent(defaultBody);
  }

  const wellFormedMsg = toWellFormedString(rawMessage);
  const header = "**Reported Problem:**\n";
  const footer = "\n\n*(Submitted via BotFleet)*";
  const msgPoints = Array.from(wellFormedMsg);
  let low = 0;
  let high = Math.min(msgPoints.length, budget);
  let best = "";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidateSlice = msgPoints.slice(0, mid).join("") + (mid < msgPoints.length ? "…" : "");
    const candidateText = `${header}${candidateSlice}${footer}`;
    try {
      const candidateEncoded = encodeURIComponent(candidateText);
      if (candidateEncoded.length <= budget) {
        best = candidateEncoded;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    } catch {
      high = mid - 1;
    }
  }

  return base + best;
}

export function isSentryFeedbackAvailable(): boolean {
  if (!globalThis.window || !initialized) return false;
  return Boolean(Sentry.getFeedback());
}

export async function openSentryFeedback(options?: OpenFeedbackOptions): Promise<void> {
  if (!globalThis.window) return;
  try {
    if (!isSentryFeedbackAvailable()) {
      const url = buildFallbackIssueUrl(options?.formTitle ?? "Report a Problem", options?.defaultMessage);
      if (typeof window !== "undefined") {
        if (window.ogb?.openExternal) {
          await window.ogb.openExternal(url);
        } else {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      }
      return;
    }

    const feedback = Sentry.getFeedback();
    if (!feedback || isCreatingFeedback) return;
    isCreatingFeedback = true;
    ensureFeedbackEventProcessor();

    let formOpened = false;
    try {
      if (activeFeedbackDialog) {
        try {
          activeFeedbackDialog.close();
          activeFeedbackDialog.removeFromDom();
        } catch {
          /* ignore cleanup failure */
        }
        activeFeedbackDialog = null;
      }

      activeFeedbackDetails = options?.defaultMessage ?? null;

      const cleanup = () => {
        dialog?.removeFromDom();
        activeFeedbackDialog = null;
        activeFeedbackDetails = null;
      };

      const dialog = (await feedback.createForm({
        formTitle: options?.formTitle ?? "Report a Problem",
        messagePlaceholder: options?.defaultMessage ? `Details: ${options.defaultMessage}` : "What went wrong?",
        tags: options?.defaultMessage ? { reportedError: options.defaultMessage.slice(0, 200) } : undefined,
        onFormSubmitted: cleanup,
        onFormClose: cleanup,
      })) as unknown as (SentryFeedbackDialog & { el?: unknown }) | undefined;

      if (dialog) {
        activeFeedbackDialog = dialog;
        dialog.appendToDom();
        dialog.open();
        formOpened = true;
        if (options?.defaultMessage) {
          try {
            const shadow = (dialog.el as { shadowRoot?: ShadowRoot | null } | undefined)?.shadowRoot;
            const textarea = shadow?.querySelector("textarea");
            if (textarea) {
              textarea.value = options.defaultMessage;
              textarea.dispatchEvent(new Event("input", { bubbles: true }));
            }
          } catch {
            /* ignore DOM inspection failures */
          }
        }
      }
    } finally {
      isCreatingFeedback = false;
      if (!formOpened) {
        activeFeedbackDetails = null;
      }
    }
  } catch {
    /* If the feedback dialog cannot be opened, swallow to protect the renderer */
  }
}


/** The option set that decides whether the running client is still the right
 * one.  Anything that changes where events go, or how many of them go,
 * belongs here — a rotated key on the same host has to count as different. */
function runtimeIdentityOf(dsn: string, environment: string, tracesSampleRate: number): string {
  return `${dsn}|${environment}|${tracesSampleRate}`;
}

/**
 * Stop the client the runtime path started, so nothing more leaves this
 * window.  The close is deliberately not awaited: this runs on a Settings
 * click, and a hung flush must not hold the card open.  State drops first,
 * so a follow-up refresh sees "nothing running" whether the flush lands
 * or not.
 */
function closeRuntimeClient(): void {
  runtimeIdentity = null;
  initialized = false;
  try {
    // `Sentry.close()` closes the client bound to the current scope; asking
    // the client directly is the same call without the global lookup, and a
    // window that somehow has no client still has to end up closed.
    const client = sentryPort.getClient();
    void Promise.resolve(client ? client.close() : sentryPort.close()).catch(() => {});
  } catch {
    /* a client that cannot close must not take the renderer down with it */
  }
}

/** Start the browser SDK against a DSN the harness resolved. */
function startRuntimeClient(dsn: string, environment: string, tracesSampleRate: number): void {
  const replaysSessionSampleRate = Number(viteEnvText(import.meta.env.VITE_SENTRY_REPLAY_SESSION_SAMPLE_RATE) ?? "0.1");
  const replaysOnErrorSampleRate = Number(viteEnvText(import.meta.env.VITE_SENTRY_REPLAY_ERROR_SAMPLE_RATE) ?? "1.0");

  sentryPort.init({
    dsn,
    environment,
    tracesSampleRate,
    replayEnabled: true,
    replaysSessionSampleRate: Number.isFinite(replaysSessionSampleRate) ? replaysSessionSampleRate : 0,
    replaysOnErrorSampleRate: Number.isFinite(replaysOnErrorSampleRate) ? replaysOnErrorSampleRate : 0,
  });

  runtimeIdentity = runtimeIdentityOf(dsn, environment, tracesSampleRate);
  initialized = true;
}

/**
 * Bring the renderer's client in line with one `GET /api/observability`
 * answer.  Three outcomes, and only three: a changed DSN, environment or
 * trace rate closes the old client and starts a new one; diagnostics turned
 * off (or a DSN removed) closes the client and starts nothing; an unchanged
 * answer does nothing at all.
 */
function applyRuntimeObservability(data: RuntimeObservability | null): void {
  if (buildTimeDsnActive) return;

  const dsn = data?.dsn?.trim();
  if (!data || !data.enabled || !dsn) {
    if (runtimeIdentity) closeRuntimeClient();
    return;
  }

  const environment = data.environment?.trim() || "production";
  const reportedRate = data.tracesSampleRate;
  const resolvedRate = reportedRate !== undefined && Number.isFinite(reportedRate) ? reportedRate : 0.2;
  const tracesSampleRate = Math.min(Math.max(resolvedRate, 0), 1);

  if (runtimeIdentity === runtimeIdentityOf(dsn, environment, tracesSampleRate)) return;
  if (runtimeIdentity) closeRuntimeClient();
  startRuntimeClient(dsn, environment, tracesSampleRate);
}

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
    const data = await readObservability();
    if (initialized) return;
    applyRuntimeObservability(data);
  } catch {
    /* the harness may be unreachable (dev, or Settings > Observability
     * mid-restart) — the renderer stays exactly as inert as it is today */
  }
}

/**
 * Re-resolve after Settings > Observability changed something.  Without
 * this, a renderer that started reporting at boot keeps sending to the old
 * DSN — or keeps sending at all after the kill switch is off — until the
 * window is reloaded, and a DSN added after boot does nothing until the
 * next launch.  The Observability card calls it after a successful Save and
 * after Remove Diagnostics Key.
 *
 * Never touches a client started from a build-time VITE_SENTRY_DSN: that
 * one is pinned to the DSN the release was built with.  Swallows every
 * failure for the same reason `initSentryFromRuntime()` does.
 */
export async function refreshSentryFromRuntime(): Promise<void> {
  if (buildTimeDsnActive || !globalThis.window) return;

  try {
    applyRuntimeObservability(await readObservability());
  } catch {
    /* a harness that will not answer leaves the client exactly as it is */
  }
}

/** Install a stand-in for the browser SDK so a test can exercise the init,
 * close and re-init path without a real client.  Pass null to restore the
 * real one. */
export function setSentryPortForTests(port: SentryBrowserPort | null): void {
  sentryPort = port ?? browserPort;
}

/** Script what the harness answers, so a test needs no fetch and no store. */
export function setObservabilityReaderForTests(reader: ObservabilityReader | null): void {
  readObservability = reader ?? harnessReader;
}

export function resetSentryForTests(): void {
  initialized = false;
  buildTimeDsnActive = false;
  runtimeIdentity = null;
  sentryPort = browserPort;
  readObservability = harnessReader;
  activeFeedbackDetails = null;
  activeFeedbackDialog = null;
  isCreatingFeedback = false;
}
