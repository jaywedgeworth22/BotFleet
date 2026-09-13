// Typed HTTP-error classification for chat-completions drivers (MiniMax
// today; openai-compat and grok once they land on the shared base in a
// later PR).  A raw `HTTP 401` string tells a user nothing actionable —
// mapping it onto the same ProviderErrorCode union the ACP drivers already
// use (see server/drivers/acp/dsh.ts's classifyDshError for the reference
// mapping) is what lets a revoked key reach the setup affordance instead of
// a red chip mid-turn, and lets model-fallback.ts consult the failover
// chain on a real outage instead of only on a regex match over chip prose.
import type { ProviderErrorCode } from "../../contracts.ts";
import { ProviderError } from "../../contracts.ts";

export interface HttpErrorClassification {
  code: ProviderErrorCode;
  /** A failure the user fixes by reconfiguring credentials, not by
   *  retrying.  Only true for invalid_credentials — matching the ACP
   *  drivers' `needsAuth` convention in acp/core.ts — so `runtime.error`
   *  carries `setup: true` and the bot goes dead with a setup affordance
   *  instead of idling behind a red chip. */
  setup: boolean;
}

/** Maps an HTTP status from a chat-completions endpoint onto the shared
 *  ProviderErrorCode union.  Returns undefined for a status this driver
 *  family has no opinion on (400, 422, a stray 3xx, …) — those keep
 *  today's generic "error" exit rather than being force-fit into a code. */
export function classifyHttpError(status: number): HttpErrorClassification | undefined {
  if (status === 401 || status === 403) return { code: "invalid_credentials", setup: true };
  if (status === 402 || status === 429) return { code: "quota_or_region_restriction", setup: false };
  if (status === 404) return { code: "model_catalog_outage", setup: false };
  if (status >= 500 && status <= 599) return { code: "upstream_outage", setup: false };
  return undefined;
}

/** Builds the error a driver's `complete()` throws for a non-2xx chat-
 *  completions response.  A classified status becomes a `ProviderError`
 *  loop.ts keys off of — `error:<code>` as the terminal stopReason, and
 *  `runtime.error.setup` for invalid_credentials.  An unmapped status stays
 *  a plain Error, exactly like before this file existed. */
export function httpErrorFor(status: number, body: string): Error {
  const message = `HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`;
  const classification = classifyHttpError(status);
  return classification ? new ProviderError(classification.code, message) : new Error(message);
}
