// Reads the user's MiniMax account balance / Token Plan quota and serves it
// to the Settings → Usage UI. A peer of deepseek-balance.ts, same cache and
// timeout shape, deliberately never injected into any engine's process
// environment — this only ever reads the same key the MiniMax driver already
// resolved, it never adds a new credential surface.
//
// MiniMax's PUBLIC docs (platform.minimax.io/docs — api-reference/api-overview,
// faq/about-account, faq/about-apis, guides/pricing-paygo, token-plan/intro;
// checked 2026-09-13) document no balance/quota API at all: every number
// there — cash balance, voucher balance, credits, Token Plan usage — lives
// only in the web dashboard (platform.minimax.io/user-center/payment/balance).
//
// MiniMax's own OFFICIAL `mmx-cli` npm package (published by npm user
// `minimax-ai`, the same account whose `mmx quota show` this driver's
// sign-in copy already tells users to run) proves two real endpoints exist —
// just never documented — by shipping a `quota show` command backed by them.
// Recovered by reading the published bundle (mmx-cli@1.0.25, dist/sdk.mjs):
//
//   - Pay-as-you-go SECRET keys (start with "sk-api-"):
//       GET {base}/account/query_balance
//       -> { available_amount, cash_balance, voucher_balance, credit_balance,
//            owed_amount, balance_alert_switch, balance_alert_threshold,
//            base_resp }  (all amount fields are decimal strings, USD)
//   - Token Plan / subscription keys (anything else, incl. OAuth tokens):
//       GET {base}/v1/token_plan/remains
//       -> { model_remains: [{ model_name, current_interval_remaining_percent,
//            current_weekly_remaining_percent, end_time, weekly_end_time,
//            current_interval_status, current_weekly_status, … }] }
//
// Both take `Authorization: Bearer <key>` and report success via
// `base_resp.status_code === 0` (nonzero is an error, message in
// `status_msg`). `{base}` is the bare region host (https://api.minimax.io, or
// https://api.minimaxi.com for "cn") — NOT the /v1-suffixed apiUrl the
// minimax.ts driver builds for chat completions.
//
// Undocumented means unstable: field shapes, percent vs. fraction, and even
// which endpoint answers for a given key can change without notice. Every
// parse here is defensive, and any failure degrades to an "unknown" snapshot
// with `error` set — it never throws into the /api/quotas response the way a
// stuck DeepSeek fetch must not either.

export type MiniMaxBalanceSource = "account-balance" | "token-plan" | "unavailable";
export type MiniMaxBalanceStatus = "ok" | "near_cap" | "capped" | "unknown";

export type MiniMaxModelQuota = {
  /** 0–100. The 5-hour ("interval") window, when the Token Plan endpoint
   *  reported one for this model. */
  remainingPercent: number | null;
  /** 0–100. The weekly window, when reported. Null (not undefined) when the
   *  model only has an interval window — matches antigravity-quota.ts's
   *  contract so the two can share a renderer. */
  secondaryRemainingPercent: number | null;
  /** "5hr/Week" when both windows are known, "5hr" when only the interval
   *  is — same vocabulary antigravity-quota.ts uses. */
  windowsLabel: string | undefined;
  /** Epoch ms of the more restrictive (sooner) of the two window resets. */
  resetsAt: number | null;
};

export type MiniMaxBalanceSnapshot = {
  /** Which undocumented endpoint answered, or "unavailable" when neither
   *  did (no key, network failure, or an unrecognized response shape). */
  source: MiniMaxBalanceSource;
  /** Whether MiniMax reported a real cap/balance figure at all — false only
   *  when the account has no discoverable ceiling ("unavailable"). */
  capExists: boolean;
  status: MiniMaxBalanceStatus;
  /** USD remaining, pay-as-you-go accounts only. */
  balanceUsd: number | null;
  /** 0–100, most restrictive across models. Token Plan accounts only. */
  remainingPercent: number | null;
  secondaryRemainingPercent: number | null;
  windowsLabel: string | undefined;
  /** Per-model breakdown, Token Plan accounts only — mirrors
   *  antigravity-quota.ts's per-model shape so both can feed the same
   *  registry.ts dual-window merge. */
  models: Record<string, MiniMaxModelQuota> | null;
  /** Epoch ms of the soonest known reset, across every model. */
  resetsAt: number | null;
  fetchedAt: number;
  /** Set when the key is missing, the request failed, or the response was
   *  not parseable. The UI hides quota detail when this is set, the same
   *  contract deepseek-balance.ts uses. */
  error: string | null;
};

const CACHE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 4_000;
/** MiniMax's own "balance alert" feature is the user's own chosen low-balance
 *  threshold — reuse it as "near cap" instead of picking an arbitrary
 *  percentage no one asked for. */
const NEAR_CAP_PERCENT = 10;

type CacheEntry = {
  key: string;
  url: string;
  expiresAt: number;
  inflight: Promise<MiniMaxBalanceSnapshot> | null;
  value: MiniMaxBalanceSnapshot;
};

let entry: CacheEntry | null = null;

function emptySnapshot(now: number, error: string | null): MiniMaxBalanceSnapshot {
  return {
    source: "unavailable",
    capExists: false,
    status: "unknown",
    balanceUsd: null,
    remainingPercent: null,
    secondaryRemainingPercent: null,
    windowsLabel: undefined,
    models: null,
    resetsAt: null,
    fetchedAt: now,
    error,
  };
}

function parseAmount(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** MiniMax's own field name says "percent", but an undocumented endpoint is
 *  free to report a 0–1 fraction instead — same defensive call
 *  antigravity-quota.ts's secondaryPercent makes for promptCredits. */
function parsePercent(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const pct = raw > 0 && raw <= 1 ? raw * 100 : raw;
  return Math.round(pct * 100) / 100;
}

/** MiniMax's epoch fields are unlabeled in the reverse-engineered types —
 *  treat anything past year ~2001 in ms (>1e12) as already milliseconds,
 *  else as seconds. Either reading degrades to "no reset known" rather than
 *  a wrong one: resetsAt is display-only, never routed on. */
function parseEpochMs(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return raw > 1e12 ? raw : raw * 1000;
}

function normalizeBase(url: string | undefined): string {
  let href = (url ?? "").trim();
  if (!href) return "https://api.minimax.io";
  if (!/^https?:\/\//i.test(href)) href = `https://${href}`;
  href = href.replace(/\/+$/, "");
  // minimax.ts's own apiUrl (config.url / local.url) is always /v1-suffixed
  // for chat completions; both balance endpoints hang off the bare host.
  return href.replace(/\/v1$/i, "");
}

/** Matches mmx-cli's own selectUsageEndpoint: a pay-as-you-go SECRET key
 *  reads the wallet; anything else (a Token Plan / subscription key, or an
 *  OAuth-issued token) reads the Token Plan quota. */
function isSecretApiKey(key: string): boolean {
  return key.trim().startsWith("sk-api-");
}

function statusFromPercent(percent: number | null): MiniMaxBalanceStatus {
  if (percent == null) return "unknown";
  if (percent <= 0) return "capped";
  if (percent <= NEAR_CAP_PERCENT) return "near_cap";
  return "ok";
}

function parseAccountBalanceResponse(body: Record<string, unknown>, now: number): MiniMaxBalanceSnapshot {
  const balance = parseAmount(body.available_amount);
  const alertOn = body.balance_alert_switch === true;
  const threshold = parseAmount(body.balance_alert_threshold);
  let status: MiniMaxBalanceStatus = "unknown";
  if (balance != null) {
    status = balance <= 0 ? "capped" : alertOn && threshold != null && balance <= threshold ? "near_cap" : "ok";
  }
  return {
    source: "account-balance",
    capExists: balance != null,
    status,
    balanceUsd: balance,
    remainingPercent: null,
    secondaryRemainingPercent: null,
    windowsLabel: undefined,
    models: null,
    resetsAt: null,
    fetchedAt: now,
    error: null,
  };
}

function parseTokenPlanResponse(body: Record<string, unknown>, now: number): MiniMaxBalanceSnapshot {
  const rows = Array.isArray(body.model_remains) ? body.model_remains : [];
  if (rows.length === 0) {
    return { ...emptySnapshot(now, null), source: "token-plan" };
  }
  const models: Record<string, MiniMaxModelQuota> = {};
  let minInterval: number | null = null;
  let minWeekly: number | null = null;
  let earliestReset: number | null = null;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const modelName = typeof row.model_name === "string" && row.model_name ? row.model_name : null;
    if (!modelName) continue;
    const interval = parsePercent(row.current_interval_remaining_percent);
    const weekly = parsePercent(row.current_weekly_remaining_percent);
    const intervalReset = parseEpochMs(row.end_time);
    const weeklyReset = parseEpochMs(row.weekly_end_time);
    const resetsAt = intervalReset != null && weeklyReset != null
      ? Math.min(intervalReset, weeklyReset)
      : intervalReset ?? weeklyReset;
    models[modelName] = {
      remainingPercent: interval,
      secondaryRemainingPercent: weekly,
      windowsLabel: weekly != null ? "5hr/Week" : interval != null ? "5hr" : undefined,
      resetsAt,
    };
    if (interval != null) minInterval = minInterval == null ? interval : Math.min(minInterval, interval);
    if (weekly != null) minWeekly = minWeekly == null ? weekly : Math.min(minWeekly, weekly);
    if (resetsAt != null) earliestReset = earliestReset == null ? resetsAt : Math.min(earliestReset, resetsAt);
  }
  return {
    source: "token-plan",
    capExists: true,
    status: statusFromPercent(minInterval),
    balanceUsd: null,
    remainingPercent: minInterval,
    secondaryRemainingPercent: minWeekly,
    windowsLabel: minWeekly != null ? "5hr/Week" : minInterval != null ? "5hr" : undefined,
    models,
    resetsAt: earliestReset,
    fetchedAt: now,
    error: null,
  };
}

async function fetchOnce(key: string, url: string | undefined, signal: AbortSignal): Promise<MiniMaxBalanceSnapshot> {
  const now = Date.now();
  const trimmedKey = key.trim();
  if (!trimmedKey) return emptySnapshot(now, "no key configured");
  const base = normalizeBase(url);
  const endpoint = isSecretApiKey(trimmedKey) ? `${base}/account/query_balance` : `${base}/v1/token_plan/remains`;
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { authorization: `Bearer ${trimmedKey}`, accept: "application/json" },
      signal,
    });
    if (!response.ok) return emptySnapshot(now, `HTTP ${response.status}`);
    const body = (await response.json().catch(() => null)) as unknown;
    if (!body || typeof body !== "object") return emptySnapshot(now, "malformed response");
    const record = body as Record<string, unknown>;
    const baseResp = record.base_resp as { status_code?: unknown; status_msg?: unknown } | undefined;
    if (typeof baseResp?.status_code === "number" && baseResp.status_code !== 0) {
      const message = typeof baseResp.status_msg === "string" && baseResp.status_msg
        ? baseResp.status_msg
        : `MiniMax error ${baseResp.status_code}`;
      return emptySnapshot(now, message);
    }
    if ("available_amount" in record) return parseAccountBalanceResponse(record, now);
    if ("model_remains" in record) return parseTokenPlanResponse(record, now);
    return emptySnapshot(now, "unrecognized response shape");
  } catch (err) {
    return emptySnapshot(now, err instanceof Error ? err.message : String(err));
  }
}

/** Returns the cached snapshot when the same (key, url) is requested within
 *  the TTL; otherwise fetches fresh and shares the in-flight promise across
 *  concurrent callers — identical contract to getDeepSeekBalance, so a
 *  Settings panel that mounts twice in 5 minutes does not double-ping
 *  MiniMax, and registry.ts's per-describe call rides the same cache the
 *  /api/quotas route does. */
export async function getMiniMaxBalance(key: string | undefined, url: string | undefined): Promise<MiniMaxBalanceSnapshot> {
  const safeKey = (key ?? "").trim();
  const safeUrl = (url ?? "").trim();
  const now = Date.now();
  if (entry && entry.key === safeKey && entry.url === safeUrl) {
    if (entry.expiresAt > now && entry.inflight === null) return entry.value;
    if (entry.inflight) return entry.inflight;
  }
  const inflight = (async () => {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, FETCH_TIMEOUT_MS);
    let value: MiniMaxBalanceSnapshot;
    try {
      value = await fetchOnce(safeKey, safeUrl, ac.signal);
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) value = { ...value, error: "timeout" };
    if (entry && entry.key === safeKey && entry.url === safeUrl) {
      entry.inflight = null;
      entry.expiresAt = Date.now() + CACHE_TTL_MS;
      entry.value = value;
    }
    return value;
  })();
  entry = { key: safeKey, url: safeUrl, expiresAt: now + CACHE_TTL_MS, inflight, value: emptySnapshot(0, safeKey ? null : "no key configured") };
  return inflight;
}

export function invalidateMiniMaxBalance(): void {
  entry = null;
}
