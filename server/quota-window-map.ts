/** Pure mapping from Usage Monitor quota windows onto BotFleet engines.
 *  Kept off usage-quota.ts so the Settings UI can import it without the poller. */

export type QuotaWindowMatch = {
  provider: string;
  sourceApp?: string | null;
  label: string;
  modelId?: string | null;
  modelType?: string | null;
  window?: string | null;
  skip: boolean;
  skipReason?: string | null;
  remainingPercent?: number | null;
};

export type QuotaPollerInstanceLike = {
  instanceId: string;
  driverKind: string;
  models?: { options?: Array<{ id: string }> };
};

export function driverKindsForWindow(window: QuotaWindowMatch): string[] {
  const hay = `${window.provider} ${window.sourceApp ?? ""} ${window.label}`.toLowerCase();
  if (hay.includes("cursor")) return ["cursorAgent"];
  if (hay.includes("antigravity") || hay.includes("gemini")) return ["antigravityAgent"];
  if (hay.includes("codex") || hay.includes("openai")) return ["codexAgent"];
  if (hay.includes("anthropic") || hay.includes("claude")) return ["claudeAgent"];
  if (hay.includes("grok") || hay.includes("xai")) return ["grokAgent", "grok"];
  if (hay.includes("minimax")) return ["minimax"];
  return [];
}

export function familiesForWindow(window: QuotaWindowMatch): string[] {
  const label = window.label.toLowerCase();
  if (label.includes("claude and gpt")) return ["claude-opus", "claude-sonnet", "claude-haiku", "claude", "gpt"];
  if (label.includes("gemini")) return ["gemini-pro", "gemini-flash", "gemini"];
  if (label.includes("cursor")) return ["cursor"];
  return window.modelType ? [window.modelType] : [];
}

export function modelTypeFromId(modelId: string): string {
  const raw = modelId.toLowerCase();
  if (/opus/.test(raw)) return "claude-opus";
  if (/sonnet/.test(raw)) return "claude-sonnet";
  if (/haiku/.test(raw)) return "claude-haiku";
  if (/claude/.test(raw)) return "claude";
  if (/gemini/.test(raw) && /pro/.test(raw)) return "gemini-pro";
  if (/gemini/.test(raw) && /flash/.test(raw)) return "gemini-flash";
  if (/gemini/.test(raw)) return "gemini";
  if (/gpt|codex/.test(raw)) return "gpt";
  if (/grok/.test(raw)) return "grok";
  if (/cursor|composer/.test(raw)) return "cursor";
  return raw;
}

/** Monthly / plan-limit windows cap the whole engine, not one model.
 *  A 5-hour or weekly remainder must not hide a spent monthly bar. */
export function isPlanLevelSkip(window: QuotaWindowMatch): boolean {
  if (!window.skip) return false;
  const hay = `${window.window ?? ""} ${window.label} ${window.skipReason ?? ""}`.toLowerCase();
  return window.window === "monthly" || /monthly|upgrade your plan|plan limit/.test(hay);
}

export function modelsToSkip(window: QuotaWindowMatch, instance: QuotaPollerInstanceLike): string[] {
  if (!window.skip) return [];
  if (isPlanLevelSkip(window)) return ["*"];
  if (window.modelId) return [window.modelId];
  const families = new Set(familiesForWindow(window));
  const options = instance.models?.options ?? [];
  return options.map((row) => row.id).filter((id) => families.has(modelTypeFromId(id)));
}

export function windowsForDriver(
  windows: QuotaWindowMatch[],
  driverKind: string,
): QuotaWindowMatch[] {
  return windows.filter((window) => driverKindsForWindow(window).includes(driverKind));
}
