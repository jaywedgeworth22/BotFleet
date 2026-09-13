// Closed-app wake: when a paired phone has no live SSE stream, the sidecar
// sends an APNs alert so iOS can relaunch the companion.  The .p8 never
// leaves this process; tests inject sendImpl.
import { createHash, createPrivateKey, sign as cryptoSign } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  p8: string;
  production: boolean;
}

/** Where the signing key lives.  The path, never the contents. */
export function apnsKeyPath(): string {
  const keyId = process.env.APNS_KEY_ID?.trim() || "N3949G7CN6";
  return process.env.APNS_P8_PATH?.trim() || join(homedir(), ".secrets", `AuthKey_${keyId}.p8`);
}

/** A fingerprint of the key FILE — modification time and size, never a
 * byte of the key itself.  Cheap enough to take every few minutes, and
 * enough to notice a rotated .p8 that kept its path. */
export function apnsKeyStamp(path = apnsKeyPath()): string | null {
  try {
    const info = statSync(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
}

export function loadApnsConfig(): ApnsConfig | null {
  const keyId = process.env.APNS_KEY_ID?.trim() || "N3949G7CN6";
  const teamId = process.env.APNS_TEAM_ID?.trim() || "CC8UTF7ATG";
  const bundleId = process.env.APNS_BUNDLE_ID?.trim() || "app.botfleet";
  const p8Path = apnsKeyPath();
  if (!existsSync(p8Path)) return null;
  let p8: string;
  try {
    p8 = readFileSync(p8Path, "utf8");
  } catch {
    return null;
  }
  if (!p8.includes("BEGIN PRIVATE KEY")) return null;
  return {
    keyId,
    teamId,
    bundleId,
    p8,
    production: process.env.APNS_PRODUCTION !== "0",
  };
}

export function apnsJwt(config: Pick<ApnsConfig, "keyId" | "teamId" | "p8">, now = Math.floor(Date.now() / 1000)): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: config.keyId })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: config.teamId, iat: now })).toString("base64url");
  const data = `${header}.${payload}`;
  const key = createPrivateKey(config.p8);
  const sig = cryptoSign("SHA256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });
  return `${data}.${Buffer.from(sig).toString("base64url")}`;
}

// --- Provider token cache -------------------------------------------------
//
// Apple refuses a provider token minted more often than once every 20
// minutes with `TooManyProviderTokenUpdates`, and accepts one for an hour.
// Re-signing per send walked straight into that rate limit on a busy fleet
// and paid for an ES256 signature every push for nothing.  One token per
// key, reused for the whole window, re-signed the moment Apple says it is
// no longer good.

export const PROVIDER_TOKEN_MAX_AGE_MS = 20 * 60 * 1000;

interface CachedProviderToken {
  jwt: string;
  issuedAt: number;
}

const providerTokens = new Map<string, CachedProviderToken>();

/** Cache identity, not key material.  The digest distinguishes a rotated
 * .p8 that kept its key id from the one it replaced; it is one-way, so the
 * map holds nothing that could be turned back into a signing key. */
function providerTokenKey(config: Pick<ApnsConfig, "keyId" | "teamId" | "p8">): string {
  const fingerprint = createHash("sha256").update(config.p8).digest("hex").slice(0, 16);
  return `${config.teamId}:${config.keyId}:${fingerprint}`;
}

/** The provider token for this key, minted at most once per window. */
export function providerToken(
  config: Pick<ApnsConfig, "keyId" | "teamId" | "p8">,
  now = Date.now(),
): string {
  const key = providerTokenKey(config);
  const cached = providerTokens.get(key);
  if (cached && now - cached.issuedAt < PROVIDER_TOKEN_MAX_AGE_MS) return cached.jwt;
  const jwt = apnsJwt(config, Math.floor(now / 1000));
  providerTokens.set(key, { jwt, issuedAt: now });
  return jwt;
}

/** Drop a token Apple rejected, so the next send signs a fresh one. */
export function invalidateProviderToken(config: Pick<ApnsConfig, "keyId" | "teamId" | "p8">): void {
  providerTokens.delete(providerTokenKey(config));
}

/** Test seam: forget every cached token. */
export function resetProviderTokens(): void {
  providerTokens.clear();
}

// --- Payload shape --------------------------------------------------------

export const APNS_APPROVAL_CATEGORY = "BOTFLEET_APPROVAL";
export const APNS_UPDATE_CATEGORY = "BOTFLEET_UPDATE";

/** The harness notify kinds, mirrored from `server/notify.ts`. */
export type ApnsAlertKind = "approval" | "question" | "done" | "routine-failed" | "takeover";

export interface ApnsAlert {
  title: string;
  body: string;
  /** Which notify frame this came from; decides how loudly it lands. */
  kind?: string;
  threadId?: string;
  botId?: string;
  /** The request waiting on an answer, on an approval or a question.  A
   * phone answering from a lock screen has no transcript to search, so
   * without this it has to guess which card the banner meant. */
  requestId?: string;
  /** The tool that asked — display only. */
  tool?: string;
}

export interface ApnsDelivery {
  category: string;
  interruptionLevel: "time-sensitive" | "active";
  relevanceScore: number;
}

/** How a kind should land on a locked phone.
 *
 * A bot blocked on you is the only thing here worth breaking a Focus for,
 * so approval and question get the time-sensitive level the app is entitled
 * to and everything else stays `active`.  The relevance score orders the
 * stack when several arrive at once: approvals on top, then the question
 * that is also waiting, then the reports. */
export function deliveryForKind(kind: string | undefined): ApnsDelivery {
  switch (kind) {
    case "approval":
      return { category: APNS_APPROVAL_CATEGORY, interruptionLevel: "time-sensitive", relevanceScore: 1 };
    case "question":
      return { category: APNS_APPROVAL_CATEGORY, interruptionLevel: "time-sensitive", relevanceScore: 0.9 };
    case "takeover":
      return { category: APNS_UPDATE_CATEGORY, interruptionLevel: "active", relevanceScore: 0.7 };
    case "routine-failed":
      return { category: APNS_UPDATE_CATEGORY, interruptionLevel: "active", relevanceScore: 0.6 };
    case "done":
      return { category: APNS_UPDATE_CATEGORY, interruptionLevel: "active", relevanceScore: 0.4 };
    default:
      return { category: APNS_UPDATE_CATEGORY, interruptionLevel: "active", relevanceScore: 0.3 };
  }
}

/** The `aps` dictionary Apple reads.  Named rather than open so the shape
 * is a contract a test can assert against and a reviewer can read. */
export interface ApnsAps {
  alert: { title: string; body: string };
  sound: string;
  "thread-id"?: string;
  category: string;
  "interruption-level": "time-sensitive" | "active";
  "relevance-score": number;
  "mutable-content": 1;
  "content-available": 1;
}

export interface ApnsPayload {
  aps: ApnsAps;
  threadId?: string;
  botId?: string;
  kind?: string;
  requestId?: string;
  tool?: string;
}

/** The JSON body for one alert.  Exported so a test can read the shape
 * without standing up a fetch. */
export function apnsPayload(alert: ApnsAlert): ApnsPayload {
  const delivery = deliveryForKind(alert.kind);
  return {
    aps: {
      alert: { title: alert.title, body: alert.body },
      sound: "default",
      "thread-id": alert.threadId,
      category: delivery.category,
      "interruption-level": delivery.interruptionLevel,
      "relevance-score": delivery.relevanceScore,
      "mutable-content": 1,
      // Background fetch so a suspended companion reconnects without a tap.
      // A force-quit app still needs the lock-screen alert (user tap).
      "content-available": 1,
    },
    // The same keys the in-app path puts in `content.userInfo`, so one
    // routing function on the phone covers a local and a remote delivery.
    threadId: alert.threadId,
    botId: alert.botId,
    kind: alert.kind,
    requestId: alert.requestId,
    tool: alert.tool,
  };
}

// --- Sending --------------------------------------------------------------

export interface ApnsSendResult {
  ok: boolean;
  status: number;
  /** Apple's own `reason` string, when it sent one.  Safe to log. */
  reason?: string;
  attempts: number;
}

export interface ApnsSendOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

/** One send plus its retries.  Three is enough to ride out a rate limit or
 * a brief 503 without holding the notify loop open behind a wall of sleeps. */
export const APNS_MAX_ATTEMPTS = 3;

const APNS_MAX_BACKOFF_MS = 30_000;

/** Statuses worth trying again: Apple is asking us to slow down, or one of
 * its gateways is briefly unwell.  Everything else is about this request
 * and will fail identically next time. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** The one rejection worth signing a new token for.  `InvalidProviderToken`
 * is NOT here: it means Apple refuses the key itself — wrong team, revoked,
 * a .p8 that does not match its key id — and re-signing produces exactly the
 * same rejection, forever, on every send.  The watcher treats it as a key
 * fault instead. */
const EXPIRED_TOKEN_REASON = "ExpiredProviderToken";

/** Apple refuses the signing key itself.  A new signature cannot help. */
export const INVALID_PROVIDER_TOKEN = "InvalidProviderToken";

/** Rejections that mean this device token will never work again.  410 says
 * the same thing with a status; these two say it with a 400, and retrying
 * either one earns the identical answer on every future notification. */
export const PERMANENT_TOKEN_REASONS: ReadonlySet<string> = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
]);

/** True when Apple has told us to stop using this device token. */
export function tokenIsDead(status: number, reason: string | undefined): boolean {
  if (status === 410) return true;
  return status === 400 && reason !== undefined && PERMANENT_TOKEN_REASONS.has(reason);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `Retry-After` is seconds or an HTTP date; only the first is worth
 * honouring here, and a hostile value must not park the loop for a day. */
export function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, APNS_MAX_BACKOFF_MS);
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), APNS_MAX_BACKOFF_MS);
}

/** Apple answers a rejection with `{"reason":"BadDeviceToken"}`.  The body
 * is tiny and the parse is best-effort: a reason we could not read must not
 * turn a clean 400 into a thrown error. */
async function readReason(res: Response): Promise<string | undefined> {
  try {
    const text = (await res.text()).slice(0, 512);
    if (!text) return undefined;
    // SAFETY: this came from Apple's error body and the assertion grants no
    // behaviour — it permits one optional property read whose value must be
    // a string before it is used, and that value is only logged or compared
    // to a fixed literal.
    const parsed = JSON.parse(text) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

export async function sendApnsAlert(
  config: ApnsConfig,
  deviceToken: string,
  alert: ApnsAlert,
  options: ApnsSendOptions = {},
): Promise<ApnsSendResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, options.maxAttempts ?? APNS_MAX_ATTEMPTS);
  const host = config.production ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  const token = deviceToken.replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]{64,}$/.test(token)) return { ok: false, status: 400, reason: "BadDeviceToken", attempts: 0 };
  const body = JSON.stringify(apnsPayload(alert));

  let attempts = 0;
  let resigned = false;
  let lastStatus = 0;
  let lastReason: string | undefined;

  while (attempts < maxAttempts) {
    attempts += 1;
    const res = await fetchImpl(`https://${host}/3/device/${token}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${providerToken(config, now())}`,
        "apns-topic": config.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      },
      body,
    });
    if (res.ok) return { ok: true, status: res.status, attempts };

    const reason = await readReason(res);
    lastStatus = res.status;
    lastReason = reason;

    // Apple has unregistered this token.  The caller drops it; sending again
    // would only earn the same answer.
    if (res.status === 410) return { ok: false, status: 410, reason, attempts };

    // A stale provider token is the one failure worth retrying instantly:
    // sign a new one and go straight back, no backoff, exactly once.
    if (reason === EXPIRED_TOKEN_REASON && !resigned) {
      invalidateProviderToken(config);
      resigned = true;
      continue;
    }

    if (!RETRYABLE_STATUSES.has(res.status)) return { ok: false, status: res.status, reason, attempts };
    if (attempts >= maxAttempts) break;
    const wait = res.status === 429 ? retryAfterMs(res.headers.get("retry-after")) : null;
    await sleep(wait ?? backoffMs(attempts));
  }

  return { ok: false, status: lastStatus, reason: lastReason, attempts };
}

// --- Sender health --------------------------------------------------------

/** What the desktop and the phone may know about the push sender.  Every
 * field here is either a count, a timestamp, or a status Apple sent us —
 * nothing derived from the signing key. */
export interface PushSenderHealth {
  /** Whether a usable .p8 has been found yet. */
  configured: boolean;
  /** Production or sandbox APNs, once configured. */
  production: boolean | null;
  /** Paired devices holding a push token right now. */
  tokensRegistered: number;
  sent: number;
  failed: number;
  lastSentAt: number | null;
  lastErrorAt: number | null;
  /** Status plus Apple's reason, e.g. `403 ExpiredProviderToken`. */
  lastError: string | null;
  /** Set when Apple refused the signing key itself.  Sending is off until
   * the key file changes; a new signature from the same key cannot help. */
  keyRejected: string | null;
  /** Notifications dropped because a device's queue was already full. */
  dropped: number;
}

interface HealthTracker {
  snapshot(): PushSenderHealth;
  setConfigured(config: ApnsConfig | null): void;
  rejectKey(at: number, reason: string): void;
  recordSent(at: number): void;
  recordError(at: number, status: number, reason?: string): void;
  recordDropped(): void;
}

function createHealthTracker(tokensRegistered: () => number): HealthTracker {
  let configured = false;
  let production: boolean | null = null;
  let sent = 0;
  let failed = 0;
  let lastSentAt: number | null = null;
  let lastErrorAt: number | null = null;
  let lastError: string | null = null;
  let keyRejected: string | null = null;
  let dropped = 0;
  return {
    snapshot: () => ({
      configured,
      production,
      tokensRegistered: tokensRegistered(),
      sent,
      failed,
      lastSentAt,
      lastErrorAt,
      lastError,
      keyRejected,
      dropped,
    }),
    setConfigured: (config) => {
      configured = config !== null;
      production = config ? config.production : null;
      // A key that loads again clears the rejection: the file changed, so
      // the verdict on the old one no longer describes what we hold.
      if (config) keyRejected = null;
    },
    rejectKey: (at, reason) => {
      configured = false;
      production = null;
      keyRejected = reason;
      lastErrorAt = at;
      lastError = reason;
    },
    recordSent: (at) => {
      sent += 1;
      lastSentAt = at;
    },
    recordError: (at, status, reason) => {
      failed += 1;
      lastErrorAt = at;
      lastError = reason ? `${status} ${reason}` : String(status);
    },
    recordDropped: () => {
      dropped += 1;
    },
  };
}

// --- The watcher ----------------------------------------------------------

/** How often to look for a .p8 that was not there at startup, or one that
 * has been replaced since.  Someone who drops a key in afterwards, or
 * rotates one, should get working pushes without restarting the sidecar,
 * and a five-minute stat() costs nothing. */
export const APNS_KEY_RECHECK_MS = 5 * 60 * 1000;

/** How many notifications may wait for ONE phone before the oldest is
 * dropped.  A phone Apple is rate-limiting must not be able to grow an
 * unbounded backlog inside a sidecar that runs for weeks, and when a
 * backlog does form the newest alerts are the ones worth keeping. */
export const APNS_MAX_QUEUED_PER_DEVICE = 8;

export interface PushWatch {
  /** Stop tailing the harness and sending. */
  stop(): void;
  /** What to show on a status page.  Never key material. */
  health(): PushSenderHealth;
}

/** Watch harness SSE on loopback and APNs-wake phones that are not streaming. */
export function watchHarnessNotifications(options: {
  harnessPort: number;
  connectedIds: () => string[];
  tokensForDisconnected: () => { deviceId: string; token: string }[];
  send?: typeof sendApnsAlert;
  /** Explicit config pins the sender; `undefined` discovers it from disk and
   * keeps looking until it appears, then watches for it changing. */
  config?: ApnsConfig | null;
  loadConfig?: () => ApnsConfig | null;
  /** Fingerprint of the key file, so a rotated key is noticed. */
  keyStamp?: () => string | null;
  forgetToken?: (deviceId: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  keyRecheckMs?: number;
  maxQueuedPerDevice?: number;
}): PushWatch {
  const health = createHealthTracker(() => options.tokensForDisconnected().length);
  const fixed = options.config;
  const loadConfig = options.loadConfig ?? loadApnsConfig;
  const keyStamp = options.keyStamp ?? (() => apnsKeyStamp());
  const now = options.now ?? Date.now;
  const recheckMs = options.keyRecheckMs ?? APNS_KEY_RECHECK_MS;
  const maxQueued = Math.max(1, options.maxQueuedPerDevice ?? APNS_MAX_QUEUED_PER_DEVICE);

  // An explicit null means "this process does not send pushes" — the desktop
  // saying so, or a test.  Honour it without holding a stream open.
  if (fixed === null) {
    health.setConfigured(null);
    return { stop: () => {}, health: health.snapshot };
  }

  const send = options.send ?? sendApnsAlert;
  const fetchImpl = options.fetchImpl ?? fetch;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;
  let retry: (() => void) | null = null;
  let discovered: ApnsConfig | null = fixed ?? null;
  let discoveredStamp: string | null = null;
  let lastLookupAt = 0;
  let warnedMissing = false;
  /** Set when Apple refused the key itself.  Only a different key file
   * clears it — a fresh signature from the same one earns the same answer. */
  let keyFault = false;
  /** The newest SSE id seen, so a reconnect resumes rather than silently
   * skipping every notification raised while we were away. */
  let lastEventId: string | null = null;
  /** One line per device and failure, so a phone with a dead token does not
   * write a log line for every notification the fleet ever sends. */
  const loggedFailures = new Set<string>();

  if (fixed) health.setConfigured(fixed);

  /** True the first time this exact failure is seen for this device. */
  const firstTime = (key: string): boolean => {
    if (loggedFailures.has(key)) return false;
    loggedFailures.add(key);
    return true;
  };

  const onKeyFault = (reason: string) => {
    if (keyFault) return;
    keyFault = true;
    discovered = null;
    health.rejectKey(now(), reason);
    console.warn(`companion: APNs refused the signing key (${reason}); pushes are off until the key file changes`);
    // Leave the stream so the pump re-enters the key check rather than
    // sending the same doomed request for every notification that follows.
    abort?.abort();
  };

  const resolveConfig = (): ApnsConfig | null => {
    if (fixed) return keyFault ? null : fixed;
    const at = now();
    if (lastLookupAt && at - lastLookupAt < recheckMs) return keyFault ? null : discovered;
    lastLookupAt = at;
    const stamp = keyStamp();
    if (keyFault) {
      // Apple refuses what is on disk.  Only a different file can help.
      if (stamp === null || stamp === discoveredStamp) return null;
      keyFault = false;
    } else if (discovered && stamp !== null && stamp === discoveredStamp) {
      // The same file as last time: keep the config, and the provider token
      // cached against it.
      return discovered;
    }
    const loaded = loadConfig();
    // Whatever is on disk now is not what the cached token was signed with.
    if (discovered) invalidateProviderToken(discovered);
    discovered = loaded;
    discoveredStamp = stamp;
    health.setConfigured(discovered);
    if (!discovered && !warnedMissing) {
      warnedMissing = true;
      console.warn("companion: APNs key missing; closed-app phone wake is off until it appears");
    }
    return discovered;
  };

  /** Sleep, but wake immediately when stop() is called. */
  const pause = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      retry = resolve;
      timer = setTimeout(() => {
        retry = null;
        resolve();
      }, ms);
    });

  // One queue per device, drained on its own chain.  A phone Apple is rate
  // limiting sleeps out its own Retry-After without holding up any other
  // phone, and each phone still sees its notifications in order.
  interface DeviceQueue {
    pending: { token: string; alert: ApnsAlert }[];
    running: boolean;
  }
  const queues = new Map<string, DeviceQueue>();

  const sendOne = async (config: ApnsConfig, deviceId: string, token: string, alert: ApnsAlert) => {
    let result: ApnsSendResult;
    try {
      result = await send(config, token, alert);
    } catch {
      health.recordError(now(), 0, "SendFailed");
      console.warn("companion: APNs send failed");
      return;
    }
    if (result.ok) {
      health.recordSent(now());
      return;
    }
    health.recordError(now(), result.status, result.reason);

    // The key, not the phone: every device is about to fail the same way.
    if (result.reason === INVALID_PROVIDER_TOKEN) {
      onKeyFault(result.reason);
      return;
    }

    // Apple has retired this token — 410, or a 400 that means the same
    // thing.  Drop it and let the phone register a new one; anything still
    // queued for it would earn the identical answer.
    if (tokenIsDead(result.status, result.reason)) {
      options.forgetToken?.(deviceId);
      const queue = queues.get(deviceId);
      if (queue) queue.pending.length = 0;
      if (firstTime(`${deviceId}:dead:${result.reason ?? result.status}`)) {
        console.warn(
          `companion: APNs ${result.status}${result.reason ? ` ${result.reason}` : ""} — dropped that phone's push token; it will register a new one`,
        );
      }
      return;
    }

    // 400 and 403 are configuration, not weather: the same push will fail
    // the same way forever, so say it once and stay quiet.
    if (result.status === 400 || result.status === 403) {
      if (!firstTime(`${deviceId}:${result.status}:${result.reason ?? ""}`)) return;
    }
    console.warn(`companion: APNs ${result.status}${result.reason ? ` ${result.reason}` : ""}`);
  };

  const drain = async (config: ApnsConfig, deviceId: string, queue: DeviceQueue) => {
    queue.running = true;
    try {
      while (!stopped) {
        const next = queue.pending.shift();
        if (!next) break;
        await sendOne(config, deviceId, next.token, next.alert);
      }
    } finally {
      queue.running = false;
      if (!queue.pending.length) queues.delete(deviceId);
    }
  };

  const deliver = (config: ApnsConfig, notification: {
    title?: string;
    body?: string;
    kind?: string;
    threadId?: string;
    botId?: string;
    requestId?: string;
    tool?: string;
  }) => {
    const connected = new Set(options.connectedIds());
    const alert: ApnsAlert = {
      title: notification.title ?? "BotFleet",
      body: notification.body ?? "",
      kind: notification.kind,
      threadId: notification.threadId,
      botId: notification.botId,
      requestId: notification.requestId,
      tool: notification.tool,
    };
    for (const row of options.tokensForDisconnected()) {
      if (connected.has(row.deviceId)) continue;
      let queue = queues.get(row.deviceId);
      if (!queue) {
        queue = { pending: [], running: false };
        queues.set(row.deviceId, queue);
      }
      queue.pending.push({ token: row.token, alert });
      if (queue.pending.length > maxQueued) {
        queue.pending.shift();
        health.recordDropped();
        console.warn("companion: APNs backlog for a phone is full; dropped its oldest notification");
      }
      if (!queue.running) void drain(config, row.deviceId, queue);
    }
  };

  const pump = async () => {
    while (!stopped) {
      const config = resolveConfig();
      if (!config) {
        await pause(recheckMs);
        continue;
      }
      abort = new AbortController();
      try {
        // Resume where the last connection stopped.  Without this every
        // notification raised during a harness restart, or during our own
        // four-second retry, is simply never pushed.
        const headers = new Headers({ accept: "text/event-stream" });
        if (lastEventId) headers.set("last-event-id", lastEventId);
        const res = await fetchImpl(`http://127.0.0.1:${options.harnessPort}/api/events`, {
          headers,
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const rows = part.split("\n");
            const id = rows.find((row) => row.startsWith("id:"));
            if (id) lastEventId = id.slice(3).trim();
            const line = rows.find((row) => row.startsWith("data:"));
            if (!line) continue;
            let frame: {
              kind?: string;
              notification?: {
                title?: string;
                body?: string;
                kind?: string;
                threadId?: string;
                botId?: string;
                requestId?: string;
                tool?: string;
              };
            };
            try {
              // SAFETY: the frame came off the harness's own loopback stream
              // and the assertion grants no behaviour — every field below is
              // optional, and each one is defaulted or checked before use.
              frame = JSON.parse(line.slice(5).trim()) as typeof frame;
            } catch {
              continue;
            }
            if (frame.kind !== "notify" || !frame.notification) continue;
            // Returns at once: the sends happen on each device's own queue,
            // so a reader that has to keep up with the harness never waits
            // on one phone's retry.
            deliver(config, frame.notification);
          }
        }
      } catch {
        /* harness down or stop() — retry unless we were asked to quit */
      }
      if (stopped) return;
      await pause(4000);
    }
  };
  void pump();
  return {
    stop: () => {
      stopped = true;
      abort?.abort();
      if (timer) clearTimeout(timer);
      retry?.();
      for (const queue of queues.values()) queue.pending.length = 0;
      queues.clear();
    },
    health: health.snapshot,
  };
}
