/** Settings → Usage quota row: full per-model / per-window lines for hover and click. */

export type QuotaDisplayModel = {
  label: string;
  modelId: string;
  remainingPercentage?: number;
  isExhausted: boolean;
  isAutocompleteOnly?: boolean;
  resetTime?: string;
  timeUntilResetMs?: number;
};

export type QuotaDisplayLine = {
  label: string;
  value: string;
  exhausted: boolean;
  group: "gemini" | "external" | "window";
};

export function isGeminiQuotaModel(model: Pick<QuotaDisplayModel, "label" | "modelId">): boolean {
  return /gemini/i.test(`${model.label} ${model.modelId}`);
}

export function isQuotaModelExhausted(model: QuotaDisplayModel): boolean {
  if (model.isAutocompleteOnly) return false;
  if (model.isExhausted) return true;
  if (typeof model.remainingPercentage !== "number") return true;
  return model.remainingPercentage <= 0;
}

export function remainingPercentLabel(model: QuotaDisplayModel): string {
  if (isQuotaModelExhausted(model)) return "exhausted";
  return `${Math.round((model.remainingPercentage ?? 0) * 100)}%`;
}

/** The two-line Antigravity chip the user actually reads: "Gemini" vs
 *  "Third-Party". Those two buckets each share one remaining-percent
 *  number, so per-model rows are noise. Hover and the expanded panel
 *  use the same two lines (`antigravityQuotaLines`).
 *
 *  Models with no reported remaining percentage are treated as unsampled
 *  (the local antigravity-usage CLI reports N/A until it has seen them).
 *  The group number is the most restrictive reported remaining in that
 *  bucket. The group is exhausted only when every model in it is. */
export type AntigravityGroupSummary = {
  group: "gemini" | "external";
  label: string;
  remainingPercent: number | null;
  exhausted: boolean;
  resetAtMs?: number | null;
  headline?: string;
};

export function antigravityGroupSummary(
  models: QuotaDisplayModel[],
  promptCredits?: { remainingPercentage?: number } | null,
): AntigravityGroupSummary[] {
  const groups: Record<"gemini" | "external", QuotaDisplayModel[]> = { gemini: [], external: [] };
  for (const model of models) {
    if (model.isAutocompleteOnly) continue;
    groups[isGeminiQuotaModel(model) ? "gemini" : "external"].push(model);
  }
  const out: AntigravityGroupSummary[] = [];
  const now = Date.now();
  for (const [group, list] of Object.entries(groups) as Array<["gemini" | "external", QuotaDisplayModel[]]>) {
    if (list.length === 0) continue;
    const reported = list
      .filter((m) => !isQuotaModelExhausted(m))
      .map((m) => m.remainingPercentage)
      .filter((value): value is number => typeof value === "number");
    const exhausted = list.every(isQuotaModelExhausted);
    const remainingPercent = exhausted
      ? 0
      : reported.length > 0
        ? Math.round(Math.min(...reported) * 100)
        : null;

    const resetMsOf = (m: QuotaDisplayModel): number | null => {
      if (m.resetTime) {
        const p = Date.parse(m.resetTime);
        if (Number.isFinite(p)) return p;
      }
      if (typeof m.timeUntilResetMs === "number" && m.timeUntilResetMs > 0) {
        return now + m.timeUntilResetMs;
      }
      return null;
    };

    // The displayed percentage is the most restrictive (lowest) remaining
    // reading in the group, not an average — so the reset countdown next to
    // it must come from the SAME model, not the earliest reset among every
    // model in the group. A model at 10% resetting in 4h alongside one at
    // 90% resetting in 1h must show "resets in 4h", not the unrelated 1h.
    // When every model is exhausted there is no single model behind the 0%,
    // so fall back to the earliest reset among them (whichever comes back
    // first still lifts the group off 0%).
    let earliestResetMs: number | null = null;
    if (exhausted) {
      for (const m of list) {
        const rMs = resetMsOf(m);
        if (rMs) earliestResetMs = earliestResetMs ? Math.min(earliestResetMs, rMs) : rMs;
      }
    } else if (reported.length > 0) {
      const minPercent = Math.min(...reported);
      for (const m of list) {
        if (isQuotaModelExhausted(m)) continue;
        if (m.remainingPercentage !== minPercent) continue;
        const rMs = resetMsOf(m);
        if (rMs) earliestResetMs = earliestResetMs ? Math.min(earliestResetMs, rMs) : rMs;
      }
    }

    const resetCountdown = earliestResetMs ? formatResetCountdown(earliestResetMs) : null;
    const groupName = group === "gemini" ? "Gemini" : "Third-Party";
    const entry: AntigravityGroupSummary = {
      group,
      label: groupName,
      remainingPercent,
      exhausted,
    };
    if (earliestResetMs != null) entry.resetAtMs = earliestResetMs;
    if (earliestResetMs != null || promptCredits?.remainingPercentage != null) {
      const pctStr = exhausted ? "0%" : remainingPercent != null ? `${remainingPercent}% available` : "not reported";
      let headline = `${groupName}: ${pctStr}`;
      if (resetCountdown) {
        headline += ` (5h window, resets in ${resetCountdown})`;
      } else {
        headline += ` (5h window)`;
      }
      if (group === "gemini" && promptCredits?.remainingPercentage != null) {
        const monthlyPct = Math.round(promptCredits.remainingPercentage * 100);
        headline += `; ${monthlyPct}% available (monthly pool, resets on ~17th)`;
      }
      entry.headline = headline;
    }

    out.push(entry);
  }
  // Gemini first — the group with the model name in the engine brand.
  out.sort((a, b) => (a.group === "gemini" ? -1 : 1) - (b.group === "gemini" ? -1 : 1));
  return out;
}

export function antigravityQuotaLines(
  models: QuotaDisplayModel[],
  promptCredits?: { remainingPercentage?: number } | null,
): QuotaDisplayLine[] {
  return antigravityGroupSummary(models, promptCredits).map((group) => ({
    label: group.label,
    value: group.exhausted
      ? "exhausted"
      : group.remainingPercent == null
        ? "not reported"
        : `${group.remainingPercent}%`,
    exhausted: group.exhausted,
    group: group.group,
  }));
}

export function quotaLinesSummary(lines: QuotaDisplayLine[]): string {
  return lines.map((line) => `${line.label}: ${line.value}`).join(" · ");
}

/** Every driver's `snapshot()` reports `state: "unavailable"` for two very
 *  different situations, distinguishable only by `reason`'s wording:
 *   - never set up: the CLI binary isn't on PATH ("`codex` CLI not found"),
 *     or no credential was ever entered ("no xAI API key — add …", "no Box
 *     token — add …"). Hiding these rows is the Fleet Quotas table's whole
 *     point — a fresh install ships a dozen engines nobody has touched.
 *   - configured but currently broken: a Box token IS set but the API is
 *     unreachable, a CLI is installed but out of date, a login expired. The
 *     user relies on this engine and needs to SEE "Unavailable: <reason>",
 *     not have the row silently vanish as if it never existed.
 *  Match only the first shape's wording, so the second keeps its row. */
export function isEngineUnconfigured(reason: string | undefined | null): boolean {
  if (!reason) return false;
  if (/CLI not found/i.test(reason)) return true;
  if (/^no [\w .-]*\b(?:api key|token)\b/i.test(reason)) return true;
  if (reason === "Disabled in settings") return true;
  return false;
}

export type QuotaWindowDisplay = {
  label: string;
  window?: string | null;
  remainingPercent?: number | null;
  /** ISO timestamp from the upstream poller — when the cap resets. */
  resetAt?: string | null;
  skip: boolean;
};

export function usageWindowLines(windows: QuotaWindowDisplay[]): QuotaDisplayLine[] {
  return windows.map((window) => ({
    label: window.window ? `${window.label} (${window.window})` : window.label,
    value: window.remainingPercent == null ? "not reported" : `${window.remainingPercent}%`,
    exhausted: window.skip,
    group: "window" as const,
  }));
}

/** The user-visible "headline" per engine row: which windows matter for
 *  that engine, what % is left, when each one resets. The cap (chip) state
 *  is computed elsewhere — these are the numbers, not the verdict.
 *
 *  Multiple windows can share a `window` slot (Cursor Pro weekly + Cursor
 *  Hobby weekly); collapse to the most restrictive remaining so the chip
 *  does not look generous when the plan underneath it is spent. Order:
 *  weekly → monthly → 5h → everything else, alphabetic. */
export type WindowHeadline = {
  /** Short, chip-friendly bucket name. */
  bucket: "weekly" | "monthly" | "5h" | string;
  /** Display label: "Weekly", "5h", "Monthly", … */
  display: string;
  remainingPercent: number | null;
  /** epoch ms, or null when the upstream poller did not return a reset. */
  resetAtMs: number | null;
  exhausted: boolean;
  /** Original window that produced this headline (one of the collapsed set). */
  sourceWindow: string | null;
};

const BUCKET_DISPLAY: Record<string, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  "5h": "5h",
  daily: "Daily",
  hourly: "Hourly",
};

function bucketFor(window: string | null | undefined): string {
  if (!window) return "other";
  const raw = window.toLowerCase();
  if (raw.includes("week")) return "weekly";
  if (raw.includes("month")) return "monthly";
  if (raw === "5h" || raw.includes("5-h") || raw.includes("5 hour") || raw.includes("session")) return "5h";
  if (raw.includes("day")) return "daily";
  if (raw.includes("hour")) return "hourly";
  return raw;
}

function remainingAsNumber(value: number | null | undefined, fallback: number): number {
  // Anti-slop `no-runtime-typeof` wants a parser at the I/O boundary; the
  // boundary is `quotaWindows` coming from the upstream poller, but we
  // always coerce `null`/`undefined` to a sentinel here so the comparator
  // below never has to type-check. The poller contract: number | null.
  if (value == null) return fallback;
  return value;
}

function pickMostRestrictive(group: QuotaWindowDisplay[]): QuotaWindowDisplay {
  // Sort ascending by remaining percent; nulls (no report) sort last so a
  // reported 80% beats an unreported one for "most restrictive".
  return [...group].sort((a, b) => {
    const ap = remainingAsNumber(a.remainingPercent, Number.POSITIVE_INFINITY);
    const bp = remainingAsNumber(b.remainingPercent, Number.POSITIVE_INFINITY);
    if (ap !== bp) return ap - bp;
    // Tie-break: a window that's marked skip (engine refuses to use it) is
    // more restrictive than one that merely reports low %.
    if (a.skip !== b.skip) return a.skip ? -1 : 1;
    return 0;
  })[0];
}

function parseResetAt(resetAt: string | null | undefined): number | null {
  if (!resetAt) return null;
  const ms = Date.parse(resetAt);
  return Number.isFinite(ms) ? ms : null;
}

export function windowHeadlines(windows: QuotaWindowDisplay[]): WindowHeadline[] {
  const grouped = new Map<string, QuotaWindowDisplay[]>();
  for (const window of windows) {
    const bucket = bucketFor(window.window);
    const list = grouped.get(bucket);
    if (list) list.push(window);
    else grouped.set(bucket, [window]);
  }
  const out: WindowHeadline[] = [];
  for (const [bucket, list] of grouped) {
    const pick = pickMostRestrictive(list);
    const remainingPercent = pick.remainingPercent == null ? null : pick.remainingPercent;
    const exhausted = pick.skip || (remainingPercent != null && remainingPercent <= 0);
    out.push({
      bucket,
      display: BUCKET_DISPLAY[bucket] ?? pick.window ?? bucket,
      remainingPercent: exhausted ? 0 : remainingPercent,
      resetAtMs: parseResetAt(pick.resetAt),
      exhausted,
      sourceWindow: pick.window ?? null,
    });
  }
  const order = (bucket: string): number => {
    if (bucket === "weekly") return 0;
    if (bucket === "monthly") return 1;
    if (bucket === "5h") return 2;
    if (bucket === "daily") return 3;
    if (bucket === "hourly") return 4;
    return 5;
  };
  out.sort((a, b) => order(a.bucket) - order(b.bucket) || a.display.localeCompare(b.display));
  return out;
}

/** "4d 12h" / "12h 14m" / "14m" — coarse on purpose, the chip is the
 *  at-a-glance answer. */
export function formatResetCountdown(resetAtMs: number | null, now = Date.now()): string | null {
  if (resetAtMs == null) return null;
  const diffMs = resetAtMs - now;
  if (diffMs <= 0) return "resetting now";
  const diffSec = Math.floor(diffMs / 1000);
  const days = Math.floor(diffSec / 86_400);
  const hours = Math.floor((diffSec % 86_400) / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${Math.max(minutes, 1)}m`;
}

export type MiniMaxQuotaStatus = "ok" | "near_cap" | "capped" | "unknown";

/** Structural subset of server/minimax-balance.ts's MiniMaxBalanceSnapshot —
 *  redeclared rather than imported so this stays a dependency-free pure
 *  module other UI surfaces can use without pulling in the server client. */
export type MiniMaxQuotaView = {
  source: "account-balance" | "token-plan" | "unavailable";
  status: MiniMaxQuotaStatus;
  balanceUsd: number | null;
  remainingPercent: number | null;
  secondaryRemainingPercent: number | null;
  resetsAt: number | null;
};

/** One status vocabulary for MiniMax's quota row, whichever of the two
 *  undocumented endpoints answered (server/minimax-balance.ts). Null when
 *  there is nothing worth a line (unavailable source, or a response with no
 *  usable figures) — the caller falls back to its own generic "Active and
 *  ready for turns" line, exactly like deepseek-balance.ts's contract: an
 *  absent/errored figure hides the line, it never fabricates one.
 *
 *  Live-verified 2026-09-13: the Token Plan sentence is "N% left this week,
 *  N% left in the current 5 h window, resets at H:MM" — weekly first, then
 *  the 5-hour figure, then when the 5-hour window (the recurring, actionable
 *  one) comes back, as a clock time rather than a countdown, matching the
 *  "resets at H:MM" convention server/index.ts's own quota line already
 *  uses. `row.resetsAt` here is specifically the 5-hour window's own reset
 *  (server/minimax-balance.ts keeps it separate from the "soonest of either
 *  window" figure the registry.ts per-model merge uses instead). A weekly
 *  figure above 100% (MiniMax's own boosted-allowance scaling,
 *  server/minimax-balance.ts's parseWeeklyPercent) says so explicitly
 *  rather than reading like a typo. `now` defaults to the real clock and
 *  exists so a test can pin it; when the cached snapshot has outlived its
 *  own window (the 5-minute balance cache can outlive a 5-hour window's
 *  reset), a reset time already in the past reads "resets soon" instead of
 *  a stale clock time. */
export function minimaxQuotaLine(row: MiniMaxQuotaView, now: number = Date.now()): string | null {
  if (row.source === "unavailable") return null;
  if (row.source === "account-balance") {
    if (row.balanceUsd == null) return null;
    const amount = row.balanceUsd <= 0 ? "$0.00 remaining" : `$${row.balanceUsd.toFixed(2)} remaining`;
    if (row.status === "capped") return "at usage cap — balance exhausted";
    if (row.status === "near_cap") return `${amount} · near cap`;
    return amount;
  }
  const parts: string[] = [];
  if (row.secondaryRemainingPercent != null) {
    const boosted = row.secondaryRemainingPercent > 100 ? " of a boosted allowance" : "";
    parts.push(`${Math.round(row.secondaryRemainingPercent)}% left this week${boosted}`);
  }
  if (row.remainingPercent != null) parts.push(`${Math.round(row.remainingPercent)}% left in the current 5 h window`);
  if (parts.length === 0) return null;
  let line = parts.join(", ");
  if (row.resetsAt != null) {
    line += row.resetsAt <= now
      ? ", resets soon"
      : `, resets at ${new Date(row.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  return line;
}

/** Generalizes the "5hr" / "5hr/Week" dual-window badge — previously
 *  computed only for Antigravity (antigravity-quota.ts) and, since MiniMax's
 *  Token Plan quota client shipped, MiniMax (server/minimax-balance.ts,
 *  merged in server/harness/registry.ts) — to any engine whose Usage
 *  Monitor headlines include a 5h and/or a weekly bucket: Claude, Codex,
 *  Cursor, Kimi, Grok, DSH and DeepSeek only ever get windows through
 *  quota-window-map.ts's mapping (established fact, not this file's own
 *  data), and had no equivalent combined label at all before this. */
export function windowsLabelFromHeadlines(headlines: WindowHeadline[]): string | undefined {
  const has5h = headlines.some((h) => h.bucket === "5h");
  const hasWeekly = headlines.some((h) => h.bucket === "weekly");
  if (has5h && hasWeekly) return "5hr/Week";
  if (has5h) return "5hr";
  if (hasWeekly) return "Week";
  return undefined;
}

/** Formats dual-window quota percentage for ModelPicker row.
 *  When both primary (5h) and secondary (weekly/monthly) percentages exist: "(XX%/YY%)".
 *  When only primary exists: "(XX%)" if a windows label exists, or "XX% left" otherwise. */
export function formatDualQuotaBadge(
  remainingPercent?: number | null,
  secondaryRemainingPercent?: number | null,
  options?: { windowsLabel?: string },
): string | null {
  if (remainingPercent == null && secondaryRemainingPercent == null) return null;
  const p1 = remainingPercent != null ? Math.round(remainingPercent) : null;
  const p2 = secondaryRemainingPercent != null ? Math.round(secondaryRemainingPercent) : null;
  if (p1 != null && p2 != null) {
    return `(${p1}%/${p2}%)`;
  }
  if (p1 != null) {
    return options?.windowsLabel ? `(${p1}%)` : `${p1}% left`;
  }
  if (p2 != null) {
    return `(${p2}%)`;
  }
  return null;
}

