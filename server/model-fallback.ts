// Shared gate for the advertised model-fallback chain.  A primary that
// merely *started* a tool (or showed a working/retry chip) has not produced
// assistant output, so the next saved engine must still be tried.
import type { ModelSelection } from "./contracts.ts";

export interface FallbackScanMessage {
  role: string;
  kind: string;
  text?: string;
  tool?: { name?: string; ok?: boolean };
}

const SHORT_PROVIDER_ERROR =
  /session limit|rate.?limit|too many requests|overloaded|capacity|internal server error|bad gateway|service unavailable|account_inactive/i;

/** Short error-chip text that must not count as a real assistant reply. */
export function isShortProviderErrorText(text: string): boolean {
  const trimmed = text.trim();
  return SHORT_PROVIDER_ERROR.test(trimmed) && trimmed.length < 300;
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

/** Next saved fallback engine, or undefined when this turn must not fail over. */
export function selectTurnFallback(input: {
  ok: boolean;
  stopReason?: string | null;
  produced: boolean;
  fallbacks?: ModelSelection[] | null;
  used: number;
}): ModelSelection | undefined {
  if (input.ok) return undefined;
  if (input.stopReason === "interrupted" || input.stopReason === "cancelled") return undefined;
  if (input.produced) return undefined;
  const chain = input.fallbacks;
  if (!chain?.length) return undefined;
  if (input.used < 0 || input.used >= chain.length) return undefined;
  const next = chain[input.used];
  if (!next?.instanceId) return undefined;
  return { instanceId: next.instanceId, model: next.model, effort: next.effort };
}
