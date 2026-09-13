import { formatResetCountdown, type QuotaDisplayLine } from "./quota-display";

export type UsageMonitorQuotaWindow = {
  id: string;
  provider: string;
  providerKey?: string | null;
  providerLabel?: string | null;
  sourceApp?: string | null;
  source?: string | null;
  via?: string | null;
  label: string;
  remainingPercent?: number | null;
  resetAt?: string | null;
  skip: boolean;
  status?: string | null;
  window?: string | null;
  occurredAt?: string | null;
  modelId?: string | null;
};

const BOTFLEET_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "codex",
  "claude",
  "google-antigravity",
  "cursor",
  "xai",
  "grok",
  "minimax",
  "deepseek",
  "dsh",
]);

const EXCLUDED_PROVIDERS = new Set([
  "gemini-cli",
  "github-copilot",
  "copilot",
  "windsurf",
  "kimi",
  "moonshot",
]);

function normalized(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function providerKey(window: UsageMonitorQuotaWindow): string {
  if (normalized(window.via) === "antigravity") return "google-antigravity";
  const key = normalized(window.providerKey || window.provider);
  return ({ antigravity: "google-antigravity", "antigravity-cli": "google-antigravity", "claude-code": "anthropic", "openai-codex": "openai", "grok-build": "xai", "minimax-code": "minimax" } as Record<string, string>)[key] ?? key;
}

/** Only providers with a BotFleet engine may appear in its quota section. */
export function isBotFleetQuotaWindow(window: UsageMonitorQuotaWindow): boolean {
  const key = providerKey(window);
  if (/grok[-_ ]?bot/i.test(`${window.providerKey ?? ""} ${window.provider} ${window.sourceApp ?? ""}`)) return false;
  if (EXCLUDED_PROVIDERS.has(key)) return false;
  if (BOTFLEET_PROVIDERS.has(key)) {
    // A bare OpenAI provider is ambiguous for custom OpenAI-compatible engines.
    // Codex's source identity makes the native subscription window attributable.
    return key !== "openai" || /codex|chatgpt/i.test(`${window.sourceApp ?? ""} ${window.label}`);
  }
  return false;
}

type AntigravityPool = "gemini" | "third-party";
type AntigravityPeriod = "5h" | "weekly";

function poolFor(window: UsageMonitorQuotaWindow): AntigravityPool | null {
  const identity = `${window.label} ${window.providerLabel ?? ""}`.toLowerCase();
  if (identity.includes("gemini")) return "gemini";
  if (/third[ -]?party|claude|gpt|openai|anthropic/.test(identity)) return "third-party";
  return null;
}

function periodFor(window: UsageMonitorQuotaWindow): AntigravityPeriod | null {
  const token = normalized(window.window).replace(/-/g, "");
  if (["weekly", "week", "1w", "7d", "168h", "10080m"].includes(token)) return "weekly";
  if (["5h", "5hr", "5hours", "300m"].includes(token)) return "5h";
  const label = window.label.toLowerCase();
  if (label.includes("weekly")) return "weekly";
  if (label.includes("5-hour") || label.includes("5 hour")) return "5h";
  return null;
}

function finitePercent(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function periodLabel(period: AntigravityPeriod): string {
  return period === "5h" ? "5-hour" : "Weekly";
}

function observedAt(window: UsageMonitorQuotaWindow): number | null {
  if (!window.occurredAt) return null;
  const parsed = Date.parse(window.occurredAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMoreRecent(candidate: UsageMonitorQuotaWindow, prior: UsageMonitorQuotaWindow): boolean {
  const candidateAt = observedAt(candidate);
  const priorAt = observedAt(prior);
  if (candidateAt != null || priorAt != null) {
    if (candidateAt == null) return false;
    if (priorAt == null) return true;
    if (candidateAt !== priorAt) return candidateAt > priorAt;
  }
  return (finitePercent(candidate.remainingPercent) ?? 101) < (finitePercent(prior.remainingPercent) ?? 101);
}

/**
 * Selects the four shared Antigravity pools from Usage Monitor.  A partial
 * response remains four explicit rows with unknown values; no cap is inferred.
 */
export function antigravityQuotaWindows(
  windows: UsageMonitorQuotaWindow[],
): UsageMonitorQuotaWindow[] {
  const candidates = windows.filter((window) => providerKey(window) === "google-antigravity");
  if (candidates.length === 0) return [];

  const selected = new Map<string, UsageMonitorQuotaWindow>();
  for (const window of candidates) {
    const pool = poolFor(window);
    const period = periodFor(window);
    if (!pool || !period) continue;
    const key = `${pool}:${period}`;
    const prior = selected.get(key);
    if (!prior || isMoreRecent(window, prior)) {
      selected.set(key, window);
    }
  }

  const result: UsageMonitorQuotaWindow[] = [];
  for (const pool of ["gemini", "third-party"] as const) {
    for (const period of ["5h", "weekly"] as const) {
      const selectedWindow = selected.get(`${pool}:${period}`);
      result.push(selectedWindow ? {
        ...selectedWindow,
        remainingPercent: finitePercent(selectedWindow.remainingPercent),
        label: `${pool === "gemini" ? "Gemini Models" : "Third-Party Models"} · ${periodLabel(period)}`,
        window: period,
      } : {
        id: `antigravity:${pool}:${period}`,
        provider: "google-antigravity",
        providerKey: "google-antigravity",
        providerLabel: "Antigravity",
        sourceApp: "usage-monitor",
        label: `${pool === "gemini" ? "Gemini Models" : "Third-Party Models"} · ${periodLabel(period)}`,
        remainingPercent: null,
        resetAt: null,
        skip: false,
        status: "unknown",
        window: period,
      });
    }
  }
  return result;
}

function isExhausted(window: UsageMonitorQuotaWindow): boolean {
  return window.skip || finitePercent(window.remainingPercent) === 0;
}

function windowsForPool(
  windows: UsageMonitorQuotaWindow[],
  pool: AntigravityPool,
): UsageMonitorQuotaWindow[] {
  return antigravityQuotaWindows(windows).filter((window) => poolFor(window) === pool);
}

/** A pool is blocked when any of its reported periods is exhausted. */
export function antigravityPoolBlocked(
  windows: UsageMonitorQuotaWindow[],
  pool: AntigravityPool,
): boolean {
  return windowsForPool(windows, pool).some(isExhausted);
}

/** Both independent Antigravity pools must be blocked before the engine is capped. */
export function antigravityQuotaCapped(windows: UsageMonitorQuotaWindow[]): boolean {
  return antigravityPoolBlocked(windows, "gemini") && antigravityPoolBlocked(windows, "third-party");
}

/** MiniMax video/Hailuo limits remain available as secondary details. */
export function isMiniMaxVideoQuotaWindow(window: {
  provider: string;
  providerKey?: string | null;
  providerLabel?: string | null;
  label: string;
  modelId?: string | null;
}): boolean {
  const key = normalized(window.providerKey || window.provider);
  return key === "minimax" && /\bvideo\b|hailuo/i.test(`${window.label} ${window.providerLabel ?? ""} ${window.modelId ?? ""}`);
}

export function antigravityQuotaLines(windows: UsageMonitorQuotaWindow[]): QuotaDisplayLine[] {
  return antigravityQuotaWindows(windows).map((window) => ({
    label: window.label,
    value: finitePercent(window.remainingPercent) == null ? "not reported" : `${Math.round(window.remainingPercent!)}%`,
    exhausted: window.skip || finitePercent(window.remainingPercent) === 0,
    group: window.label.startsWith("Gemini") ? "gemini" : "external",
  }));
}

export function antigravityQuotaHeadlines(windows: UsageMonitorQuotaWindow[]): string[] {
  return antigravityQuotaWindows(windows).map((window) => {
    const percent = finitePercent(window.remainingPercent);
    const value = percent == null ? "not reported" : `${Math.round(percent)}% available`;
    const reset = window.resetAt ? Date.parse(window.resetAt) : Number.NaN;
    const countdown = Number.isFinite(reset) ? formatResetCountdown(reset) : null;
    return countdown ? `${window.label} ${value} · resets in ${countdown}` : `${window.label} ${value}`;
  });
}
