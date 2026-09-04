/** Settings → Usage quota row: full per-model / per-window lines for hover and click. */

export type QuotaDisplayModel = {
  label: string;
  modelId: string;
  remainingPercentage?: number;
  isExhausted: boolean;
  isAutocompleteOnly?: boolean;
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
 *  "Third Party". A four-name slice was misleading — all the third-party
 *  models share the same monthly % and Gemini sits alone, so two averages
 *  are the honest summary. The full per-model list still lives in the
 *  detail panel (`antigravityQuotaLines` → `quotaLinesSummary`).
 *
 *  Models with no reported remaining percentage are treated as exhausted
 *  (the local antigravity-usage CLI reports N/A for models it has not yet
 *  sampled). One exhausted model pulls its group to exhausted — the
 *  cap-on-the-plan rule the user is reading this chip for. */
export type AntigravityGroupSummary = {
  group: "gemini" | "external";
  label: string;
  remainingPercent: number | null;
  exhausted: boolean;
};

export function antigravityGroupSummary(models: QuotaDisplayModel[]): AntigravityGroupSummary[] {
  const groups: Record<"gemini" | "external", QuotaDisplayModel[]> = { gemini: [], external: [] };
  for (const model of models) {
    if (model.isAutocompleteOnly) continue;
    groups[isGeminiQuotaModel(model) ? "gemini" : "external"].push(model);
  }
  const out: AntigravityGroupSummary[] = [];
  for (const [group, list] of Object.entries(groups) as Array<["gemini" | "external", QuotaDisplayModel[]]>) {
    if (list.length === 0) continue;
    const reported = list.filter((m) => typeof m.remainingPercentage === "number" && !isQuotaModelExhausted(m));
    const avg = reported.length > 0
      ? reported.reduce((sum, m) => sum + (m.remainingPercentage as number), 0) / reported.length
      : null;
    const exhausted = list.every(isQuotaModelExhausted);
    out.push({
      group,
      label: group === "gemini" ? "Gemini" : "Third Party",
      remainingPercent: exhausted ? 0 : avg != null ? Math.round(avg * 100) : null,
      exhausted,
    });
  }
  // Gemini first — the group with the model name in the engine brand.
  out.sort((a, b) => (a.group === "gemini" ? -1 : 1) - (b.group === "gemini" ? -1 : 1));
  return out;
}

export function antigravityQuotaLines(models: QuotaDisplayModel[]): QuotaDisplayLine[] {
  const lines = models
    .filter((model) => !model.isAutocompleteOnly)
    .map((model) => {
      const exhausted = isQuotaModelExhausted(model);
      return {
        label: model.label,
        value: remainingPercentLabel(model),
        exhausted,
        group: isGeminiQuotaModel(model) ? "gemini" : "external",
      } as const;
    });
  return lines.sort((a, b) => {
    if (a.group !== b.group) return a.group === "gemini" ? -1 : 1;
    if (a.exhausted !== b.exhausted) return a.exhausted ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

export function quotaLinesSummary(lines: QuotaDisplayLine[]): string {
  return lines.map((line) => `${line.label}: ${line.value}`).join(" · ");
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
