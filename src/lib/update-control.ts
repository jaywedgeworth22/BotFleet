// The renderer's half of "check for a newer BotFleet, and install it".
//
// Two update paths exist and they answer different questions.  The signed
// release feed (electron-updater) asks "has a build been published?" and only
// works in a packaged, signed app that shipped with `app-update.yml`.  This
// one asks "is this Mac's own always-on checkout behind `origin/main`?" and
// is answered by the harness, which can also start the transactional local
// updater.  A locally built app has no release feed at all, so its Check for
// Updates used to fail silently — this is what it uses instead.
//
// Everything here is either a fetch or a pure string: the components own the
// markup, this file owns the wording and the decision about which path is
// live, so both can be tested without rendering anything.
import { useCallback, useEffect, useRef, useState } from "react";

/** The gap protocol's wide sentence break, for copy a person reads. */
const GAP = "\u00a0 ";

export interface UpdateCommit {
  sha: string;
  subject: string;
}

export interface UpdateAvailable {
  sourceCommit: string;
  version?: string;
  aheadBy: number;
  commits: UpdateCommit[];
}

export interface UpdateRunning {
  runId: string;
  startedAt: string;
  step: string;
  progress?: number;
  logTail: string[];
}

export type UpdateOutcome = "verified" | "rolled-back" | "failed" | "refused";

export interface UpdateLastRun {
  runId: string;
  startedAt: string;
  finishedAt: string;
  outcome: UpdateOutcome;
  message: string;
  receiptPath?: string;
}

export interface UpdateStatus {
  installed: { version: string; sourceCommit: string; installedAt?: string };
  available: UpdateAvailable | null;
  checkedAt: string | null;
  running: UpdateRunning | null;
  lastRun: UpdateLastRun | null;
  capabilities: { canCheck: boolean; canRun: boolean; reasons: string[] };
}

/** The event the store re-broadcasts when an `update.status` frame lands. */
export const UPDATE_STATUS_EVENT = "botfleet:update-status";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const JSON_HEADERS = { "content-type": "application/json" };

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

/** Null rather than a throw when this build has no harness answer for it —
 * a dev browser, an older harness, a non-Mac. */
export async function fetchUpdateStatus(request: Fetcher = fetch): Promise<UpdateStatus | null> {
  try {
    const response = await request("/api/update/status");
    if (!response.ok) return null;
    const body = await readJson(response);
    return isUpdateStatus(body) ? body : null;
  } catch {
    return null;
  }
}

export async function requestUpdateCheck(request: Fetcher = fetch): Promise<UpdateStatus> {
  const response = await request("/api/update/check", { method: "POST", headers: JSON_HEADERS, body: "{}" });
  const body = await readJson(response);
  if (!response.ok || !isUpdateStatus(body)) {
    throw new Error(asError(body) ?? `Could not check for updates (${response.status}).`);
  }
  return body;
}

export async function requestUpdateRun(
  options: { force?: boolean } = {},
  request: Fetcher = fetch,
): Promise<{ runId: string; status: UpdateStatus }> {
  const response = await request("/api/update/run", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(options.force ? { force: true } : {}),
  });
  const body = await readJson(response);
  if (!response.ok) throw new Error(asError(body) ?? `Could not start the update (${response.status}).`);
  const status = body.status;
  if (typeof body.runId !== "string" || !isUpdateStatus(status)) {
    throw new Error("The harness started an update but did not describe it.");
  }
  return { runId: body.runId, status };
}

function asError(body: Record<string, unknown>): string | null {
  return typeof body.error === "string" && body.error ? body.error : null;
}

/** A shape check rather than a cast: this crosses a process boundary and an
 * older harness answers 404 with an HTML body. */
export function isUpdateStatus(value: unknown): value is UpdateStatus {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const installed = record.installed as Record<string, unknown> | undefined;
  const capabilities = record.capabilities as Record<string, unknown> | undefined;
  return Boolean(
    installed && typeof installed.version === "string" && typeof installed.sourceCommit === "string"
    && capabilities && typeof capabilities.canCheck === "boolean" && typeof capabilities.canRun === "boolean",
  );
}

export type UpdateSource = "harness" | "feed" | "none";

/**
 * Which path drives the Updates card.
 *
 * The harness wins whenever it says this computer can check or install,
 * because that answer already means macOS plus a real always-on checkout —
 * exactly "the app is attached to a local harness on a Mac".  The signed
 * release feed is the fallback, and it only exists at all when the preload's
 * updater bridge is there (a packaged build).  Neither, in a dev browser.
 */
export function updateSource(status: UpdateStatus | null, hasUpdaterBridge: boolean): UpdateSource {
  if (status && (status.capabilities.canCheck || status.capabilities.canRun)) return "harness";
  return hasUpdaterBridge ? "feed" : "none";
}

/** `1.0.30 (ae8abe7)` — the version alone is ambiguous between two builds of
 * the same version, and on this Mac that happens every day. */
export function installedLabel(status: UpdateStatus): string {
  return `${status.installed.version} (${shortCommit(status.installed.sourceCommit)})`;
}

export function shortCommit(sha: string): string {
  return /^[a-f0-9]{7,}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

/** The headline when something is waiting to be installed. */
export function availableLabel(status: UpdateStatus): string | null {
  const available = status.available;
  if (!available) return null;
  const name = available.version ?? shortCommit(available.sourceCommit);
  const commits = available.aheadBy === 1 ? "1 commit ahead" : `${available.aheadBy} commits ahead`;
  return `Update Available: ${name}, ${commits}`;
}

/** Sentence case, present tense, and never a percentage the updater did not
 * actually report. */
export function runningLabel(running: UpdateRunning): string {
  const percent = typeof running.progress === "number"
    ? ` (${Math.round(Math.min(1, Math.max(0, running.progress)) * 100)}%)`
    : "";
  return `${running.step}${percent}…`;
}

export function lastRunLabel(lastRun: UpdateLastRun | null): string | null {
  if (!lastRun) return null;
  const headline = lastRun.outcome === "verified"
    ? "The last update installed and verified."
    : lastRun.outcome === "rolled-back"
      ? "The last update failed and rolled back."
      : lastRun.outcome === "refused"
        ? "The last update was refused."
        : "The last update failed.";
  return lastRun.message ? `${headline}${GAP}${lastRun.message}` : headline;
}

/** What the card says when there is nothing to install. */
export function idleLabel(status: UpdateStatus): string {
  if (!status.capabilities.canCheck) {
    return status.capabilities.reasons[0] ?? "Updating from this computer is not available here.";
  }
  if (!status.checkedAt) return "This computer has not checked for a newer build yet.";
  return "BotFleet is on the newest build this computer knows about.";
}

/** Whether the floating banner should show the harness card at all. */
export function bannerIsActionable(status: UpdateStatus | null): boolean {
  if (!status) return false;
  if (status.running) return true;
  if (status.available) return true;
  return status.lastRun !== null && status.lastRun.outcome !== "verified";
}

/**
 * May the old fire-and-forget local updater still be offered?
 *
 * `window.ogb.updater.local()` spawns `~/apps/update-botfleet.sh` with no
 * run id and no progress file, so nothing can describe it, no second caller
 * can be refused against it, and the harness never learns it happened.  It
 * stays reachable in exactly one case: the harness gave no answer at all —
 * an old harness, or one that is down — where it is the only local path
 * there is.  A harness that answered and said it cannot install has made a
 * decision, and an untracked update must not talk past it.
 */
export function mayUseLegacyLocalUpdate(
  status: UpdateStatus | null,
  canLocalUpdate: boolean | undefined,
): boolean {
  return Boolean(canLocalUpdate) && status === null;
}

/** How long to wait before asking again after a status fetch came back with
 * nothing.  A miss is usually a harness that is restarting — which is exactly
 * what an update does to it — so the first retries are quick and the tail is
 * a slow heartbeat rather than a poll. */
export const STATUS_RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;
export const STATUS_RETRY_STEADY_MS = 5 * 60_000;

export function statusRetryDelay(attempt: number): number {
  return STATUS_RETRY_DELAYS_MS[attempt] ?? STATUS_RETRY_STEADY_MS;
}

/**
 * Keep asking until the harness answers, then stop.
 *
 * One failed fetch used to leave `status` null for the whole session, and a
 * null status means `updateSource` reports "feed" — so a single blip during
 * the restart an update performs would flip the UI back to the release feed
 * and re-enable the old untracked local updater.  The retry is what makes
 * "the harness is temporarily gone" temporary.
 *
 * Returns a disposer.  Injectable timers so the schedule is testable.
 */
export function scheduleStatusRetries(options: {
  fetchStatus: () => Promise<UpdateStatus | null>;
  onStatus: (status: UpdateStatus) => void;
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: never) => void;
}): () => void {
  const setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  let stopped = false;
  let handle: unknown = null;
  let attempt = 0;

  const tick = () => {
    void options.fetchStatus().then((status) => {
      if (stopped) return;
      if (status) {
        options.onStatus(status);
        return;
      }
      handle = setTimer(tick, statusRetryDelay(attempt));
      attempt += 1;
    });
  };

  tick();
  return () => {
    stopped = true;
    if (handle !== null) clearTimer(handle as never);
  };
}

export interface UpdateControlView {
  status: UpdateStatus | null;
  error: string | null;
  busy: "check" | "install" | null;
  check: () => Promise<void>;
  install: (options?: { force?: boolean }) => Promise<void>;
}

/**
 * One live view of the harness's update status.
 *
 * Live updates arrive as `update.status` frames on the existing event stream
 * (the store re-broadcasts them as a window event, so this does not open a
 * second EventSource).  The poll is only a backstop for a dropped stream
 * while a run is actually going — an update takes minutes and the person is
 * watching it.
 */
export function useUpdateControl(pollMs = 5_000): UpdateControlView {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"check" | "install" | null>(null);
  const running = Boolean(status?.running);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const stopRetries = scheduleStatusRetries({
      fetchStatus: () => fetchUpdateStatus(),
      onStatus: setStatus,
    });
    const onPush = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (isUpdateStatus(detail)) setStatus(detail);
    };
    // Coming back to the window is the moment the answer is most likely to
    // have changed — an update finished, or a harness came back — and it is
    // free compared with polling for it.
    const onFocus = () => {
      void fetchUpdateStatus().then((next) => {
        if (alive.current && next) setStatus(next);
      });
    };
    window.addEventListener(UPDATE_STATUS_EVENT, onPush);
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      stopRetries();
      window.removeEventListener(UPDATE_STATUS_EVENT, onPush);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      void fetchUpdateStatus().then((next) => {
        if (alive.current && next) setStatus(next);
      });
    }, pollMs);
    return () => clearInterval(timer);
  }, [running, pollMs]);

  const check = useCallback(async () => {
    setBusy("check");
    setError(null);
    try {
      setStatus(await requestUpdateCheck());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not check for updates.");
    } finally {
      setBusy(null);
    }
  }, []);

  const install = useCallback(async (options?: { force?: boolean }) => {
    setBusy("install");
    setError(null);
    try {
      setStatus((await requestUpdateRun(options ?? {})).status);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not start the update.");
    } finally {
      setBusy(null);
    }
  }, []);

  return { status, error, busy, check, install };
}
