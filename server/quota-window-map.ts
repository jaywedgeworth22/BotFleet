/** Pure mapping from Usage Monitor quota windows onto BotFleet engines.
 *  Kept off usage-quota.ts so the Settings UI can import it without the poller. */

export type QuotaWindowMatch = {
  provider: string;
  providerKey?: string | null;
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
  // Grok Bot has its own Cursor-hosted allowance and cannot run in BotFleet.
  if (/grok[-_ ]?bot/i.test(`${window.providerKey ?? ""} ${hay}`)) return [];
  if (hay.includes("cursor")) return ["cursorAgent"];
  if (hay.includes("antigravity") || hay.includes("gemini")) return ["antigravityAgent"];
  // "openai-compat" is the provider token Usage Monitor's own telemetry
  // ambiguity fallback emits for a custom OpenAI-compatible engine
  // (server/telemetry.ts's AMBIGUOUS_ENGINE, set when inferProviderAndService
  // can name no real vendor) — it contains "openai" as a literal substring,
  // so it must be excluded before any codex/openai check, or a skipped
  // monthly window on an unrelated custom engine would wildcard-cap the real
  // Codex instance, and an ordinary window would render under the wrong
  // engine's row. Custom instances share one driver kind ("openai-compat")
  // across possibly many instances, so there is no reliable way to attribute
  // this token to one specific instance from the label alone — it maps to
  // nothing here rather than to the wrong engine.
  if (hay.includes("openai-compat") || hay.includes("openai compatible")) return [];
  // The shipped fleet's default Codex instance rides driver kind "codex"
  // (server/drivers/codex.ts), not "codexAgent" — that name matches nothing
  // in instanceConfigs()'s DEFAULT_FLEET, so a Codex/OpenAI Usage Monitor
  // window was silently unreachable by windowsForDriver() for the one
  // instance most likely to want it.
  //
  // Deliberately "codex"/"chatgpt" (the PRODUCT), never a bare "openai"/
  // "gpt" (the VENDOR/model family): excluding the literal "openai-compat"
  // token above only catches the case where Usage Monitor could name no
  // vendor at all. When it CAN — because the custom engine's own model id
  // happens to look like a real OpenAI model ("gpt-4o" proxied through
  // OpenRouter, Azure, a self-hosted gateway, …) — its classification can
  // legitimately report provider "openai" for a window that has nothing to
  // do with the real app. A custom engine is free to proxy those same
  // models; only the product name is unique to the one BotFleet actually
  // ships as "codex".
  if (hay.includes("codex") || hay.includes("chatgpt")) return ["codex", "codexAgent"];
  if (hay.includes("anthropic") || hay.includes("claude")) return ["claudeAgent"];
  if (hay.includes("grok") || hay.includes("xai")) return ["grokAgent", "grok"];
  if (hay.includes("minimax")) return ["minimax"];
  // inferProviderAndService (server/telemetry.ts) reports Kimi/Moonshot
  // windows under provider "moonshot"; the shipped fleet's Kimi instance
  // rides driver kind "kimiAgent" (instanceConfigs()'s DEFAULT_FLEET). The
  // raw Usage Monitor windows table this PR removed was the only place a
  // Kimi window stayed visible without this mapping.
  if (hay.includes("kimi") || hay.includes("moonshot")) return ["kimiAgent"];
  if (hay.includes("dsh")) return ["dshAgent"];
  if (hay.includes("deepseek")) return ["deepseekAgent", "deepseek"];
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
  if (/deepseek|dsh/.test(raw)) return "deepseek";
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
