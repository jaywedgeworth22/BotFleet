import type { TurnUsage } from "./loop.ts";

/** Cached reads are included in prompt_tokens, never additional tokens. */
export function toTurnUsage(raw: any): TurnUsage {
  const finiteCount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
  const usage: TurnUsage = { input: finiteCount(raw?.prompt_tokens), output: finiteCount(raw?.completion_tokens) };
  const cached = raw?.prompt_tokens_details?.cached_tokens ?? raw?.prompt_cache_hit_tokens;
  if (typeof cached === "number" && Number.isFinite(cached) && cached >= 0) usage.cachedInput = Math.min(usage.input, Math.round(cached));
  return usage;
}

/** Sum completed request attempts without counting cache reads twice. */
export function addTurnUsage(total: TurnUsage | undefined, next: TurnUsage | null): TurnUsage | undefined {
  if (!next) return total;
  return {
    input: (total?.input ?? 0) + next.input,
    output: (total?.output ?? 0) + next.output,
    ...((total?.cachedInput != null || next.cachedInput != null)
      ? { cachedInput: (total?.cachedInput ?? 0) + (next.cachedInput ?? 0) }
      : {}),
  };
}
