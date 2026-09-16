// The shared-memory sentences a bot is given when its driver actually
// mounted the recall proxy.
//
// Twelve drivers mount `recall_search`, `recall_contribute` and
// `recall_stats`, and until now not one word of the assembled system prompt
// mentioned them — every other integration gets a sentence there (composio
// inline, the computer through its own prompt, peers through the
// coordination prompt).  A tool a model is never pointed at is one it calls
// by accident, if at all.
//
// The gate is the mounted integration, never the config: `cfg.qdrant` says
// the operator configured a corpus, not that THIS engine can reach it.  A
// bot on pi, MiniMax or Grok would otherwise be told about tools its driver
// cannot mount, which is the harness's own rule against describing a
// capability that is not there.

/** The mounted integrations of one turn.  Structural on purpose: both the
 * 1:1 and the room assembly sites pass their own turn-input integrations
 * object, and only the presence of the `qdrant` mount matters here. */
export interface RecallPromptIntegrations {
  qdrant?: unknown;
}

/**
 * The recall paragraph, or "" when this turn mounted no corpus.
 *
 * Leading space, no trailing punctuation quirks: it concatenates into the
 * same system string as the composio and coordination sentences.
 */
export function recallPromptFor(integrations?: RecallPromptIntegrations | null): string {
  if (!integrations?.qdrant) return "";
  return (
    " You share a memory corpus with the rest of the fleet — lessons, preferences, infrastructure facts, decisions," +
    " and runbooks written by other seats and bots.  Search it with recall_search before you re-derive a lesson," +
    " debug something that smells familiar, or ask a question a past ruling probably answers, and treat a hit as a" +
    " lead to verify rather than a verdict.  When you learn something reusable, save one paragraph with" +
    " recall_contribute under the category lesson, preference, infrastructure, decision, or runbook — never" +
    " secrets, and never a transcript."
  );
}
