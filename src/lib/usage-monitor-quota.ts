import { formatResetCountdown, type QuotaDisplayLine } from "./quota-display";

export type UsageMonitorQuotaWindow = {
  id: string;
  provider: string;
  providerKey?: string | null;
  providerLabel?: string | null;
  sourceApp?: string | null;
  label: string;
  remainingPercent?: number | null;
  resetAt?: string | null;
  skip: boolean;
  status?: string | null;
  window?: string | null;
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
  const key = normalized(window.providerKey || window.provider);
  if (key === "antigravity") return "google-antigravity";
  return key;
}

/** Only providers with a BotFleet engine may appear in its quota section. */
export function isBotFleetQuotaWindow(window: UsageMonitorQuotaWindow): boolean {
  const key = providerKey(window);
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
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function periodLabel(period: AntigravityPeriod): string {
  return period === "5h" ? "5-hour" : "Weekly";
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
    if (!prior || (finitePercent(window.remainingPercent) ?? 101) < (finitePercent(prior.remainingPercent) ?? 101)) {
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
