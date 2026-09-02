// Shared gate for the advertised model-fallback chain.  A primary that
// merely *started* a tool (or showed a working/retry chip) has not produced
// assistant output, so the next saved engine must still be tried.  Quota,
// usage-cap, and session-limit chips force the saved chain even when tools
// already ran — those turns did not finish the user's request.
import type { ModelSelection } from "./contracts.ts";

export interface FallbackScanMessage {
  role: string;
  kind: string;
  text?: string;
  tool?: { name?: string; ok?: boolean };
}

export interface TurnFallbackPick extends ModelSelection {
  /** Index in the saved chain to start from on the next failure. */
  nextUsed: number;
}

const SHORT_PROVIDER_ERROR =
  /session limit|rate.?limit|too many requests|overloaded|capacity|internal server error|bad gateway|service unavailable|account_inactive|quota|usage cap|credits exhausted/i;

const QUOTA_OR_CAP =
  /session limit|hit your session limit|usage cap|quota exceeded|insufficient.?quota|resource.?exhausted|credits exhausted|\bbilling\b|\bsubscription\b|rate.?limit|too many requests|overloaded|capacity|account_inactive/i;

const QUOTA_TEXT_MAX = 500;

/** Short error-chip text that must not count as a real assistant reply. */
export function isShortProviderErrorText(text: string): boolean {
  const trimmed = text.trim();
  return SHORT_PROVIDER_ERROR.test(trimmed) && trimmed.length < 300;
}

/** Quota, usage-cap, or session-limit chip — including Grok's
 * "You've hit your session limit · resets …" line. */
export function isQuotaOrCapText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length >= QUOTA_TEXT_MAX) return false;
  return QUOTA_OR_CAP.test(trimmed);
}

export function lastUserTextIndex(messages: FallbackScanMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && messages[i].kind === "text") return i;
  }
  return -1;
}

/** True when the only bot text after the user is a short provider error chip. */
export function sliceIsShortProviderError(messagesAfterUser: FallbackScanMessage[]): boolean {
  const botReplies = messagesAfterUser.filter(
    (message) => message.role === "bot" && message.kind === "text" && typeof message.text === "string",
  );
  if (botReplies.length !== 1 || typeof botReplies[0].text !== "string") return false;
  return isShortProviderErrorText(botReplies[0].text);
}

/** True when this turn ended on a quota / usage-cap / session-limit chip. */
export function turnHitQuotaOrCap(messagesAfterUser: FallbackScanMessage[]): boolean {
  const botTexts = messagesAfterUser.filter(
    (message) => message.role === "bot" && message.kind === "text" && typeof message.text === "string",
  );
  if (botTexts.length > 0) {
    const last = botTexts[botTexts.length - 1];
    if (typeof last.text === "string" && isQuotaOrCapText(last.text)) return true;
  }
  return messagesAfterUser.some((message) => {
    if (message.role !== "bot" || message.kind !== "activity") return false;
    const name = message.tool?.name ?? "";
    return /error:/i.test(name) && isQuotaOrCapText(name);
  });
}

/**
 * Whether this user turn already produced real assistant output.
 * Counts only non-error text and terminal tool results (`tool.ok === true`).
 * Tool-start chips (`ok` undefined), failed tools, screens, and working/retry
 * activity never count — those are how a 401 after a tool-start used to
 * skip the fallback chain.
 */
export function turnProducedAssistantOutput(
  messagesAfterUser: FallbackScanMessage[],
  opts: { textIsError?: boolean } = {},
): boolean {
  const textIsError = opts.textIsError === true;
  return messagesAfterUser.some((message) => {
    if (message.role !== "bot") return false;
    if (message.kind === "text") return !textIsError;
    if (message.kind !== "activity") return false;
    if (message.tool?.ok !== true) return false;
    const name = message.tool.name ?? "";
    if (/^(retrying|working)\b/i.test(name)) return false;
    return true;
  });
}

function sameEngine(a: { instanceId: string; model: string }, b: { instanceId: string; model: string }): boolean {
  return a.instanceId === b.instanceId && a.model === b.model;
}

/** Next saved fallback engine, or undefined when this turn must not fail over.
 * Quota/cap chips ignore prior tool activity.  Chain entries that match the
 * current primary are skipped so a same-model fallback cannot loop. */
export function selectTurnFallback(input: {
  ok: boolean;
  stopReason?: string | null;
  produced: boolean;
  quotaOrCap?: boolean;
  fallbacks?: ModelSelection[] | null;
  used: number;
  current?: { instanceId: string; model: string } | null;
}): TurnFallbackPick | undefined {
  if (input.ok) return undefined;
  if (input.stopReason === "interrupted" || input.stopReason === "cancelled") return undefined;
  if (input.produced && !input.quotaOrCap) return undefined;
  const chain = input.fallbacks;
  if (!chain?.length) return undefined;
  const start = Math.max(0, input.used);
  for (let i = start; i < chain.length; i++) {
    const next = chain[i];
    if (!next?.instanceId) continue;
    if (input.current && sameEngine(next, input.current)) continue;
    return { instanceId: next.instanceId, model: next.model, effort: next.effort, nextUsed: i + 1 };
  }
  return undefined;
}
