// A minimum gap between activations of one trigger, and one turn for
// everything that arrived during it.
//
// A webhook that fires every ninety seconds does not need a bot woken ninety
// seconds apart.  Left alone, an uptime monitor put a hundred one-message
// conversations on a bot in two days, each one a full turn's cost, and the
// person reading them had a hundred places to look instead of one.
//
// A gap says: after this trigger runs, do not run it again for N minutes.
// What arrives in the meantime is not dropped — it waits, and when the gap
// closes every waiting delivery goes into a single turn.  The bot sees all
// of it at once, which is also the more useful prompt: "these six checks
// failed" is a better question than six copies of "a check failed".

export interface GapCandidate {
  id: string;
  /** which trigger this belongs to, from `automationThreadKey` */
  key: string;
  /** when the delivery arrived */
  scheduledFor: number;
  prompt?: string;
}

export interface GapDecision {
  /** run now, with `folded` merged into it */
  run: GapCandidate;
  folded: GapCandidate[];
}

/** Milliseconds a trigger must stay quiet after it runs.  Absent, zero and
 * anything negative all mean "no gap" — run every delivery as it lands, the
 * behavior every trigger had before this existed. */
export function gapMs(minGapMinutes: number | undefined | null): number {
  // Number.isFinite is the whole check: it is false for null, undefined,
  // NaN and Infinity alike, so no separate shape test is needed.
  if (!Number.isFinite(minGapMinutes ?? Number.NaN)) return 0;
  const minutes = minGapMinutes ?? 0;
  return minutes > 0 ? Math.round(minutes * 60_000) : 0;
}

/** Is this trigger still inside its quiet period? */
export function withinGap(
  lastStartedAt: number | undefined,
  now: number,
  minGapMinutes: number | undefined | null,
): boolean {
  const gap = gapMs(minGapMinutes);
  if (!gap || lastStartedAt === undefined) return false;
  return now - lastStartedAt < gap;
}

/** When the quiet period ends, so a caller can say so in the transcript. */
export function gapEndsAt(
  lastStartedAt: number | undefined,
  minGapMinutes: number | undefined | null,
): number | null {
  const gap = gapMs(minGapMinutes);
  if (!gap || lastStartedAt === undefined) return null;
  return lastStartedAt + gap;
}

/** The oldest waiting delivery leads, and every other delivery of the same
 * trigger folds into it.
 *
 * Oldest-leads matters: the run that has been waiting longest is the one
 * whose receipt the person is looking at, and folding newer arrivals into it
 * keeps the calendar honest about when the work was asked for. */
export function coalesce(candidates: readonly GapCandidate[], key: string): GapDecision | null {
  const mine = candidates
    .filter((candidate) => candidate.key === key)
    .sort((a, b) => a.scheduledFor - b.scheduledFor || a.id.localeCompare(b.id));
  const [lead, ...rest] = mine;
  if (!lead) return null;
  return { run: lead, folded: rest };
}

/** The one prompt a folded batch runs.
 *
 * Identical prompts are the common case — one webhook, one template — so
 * repeating it N times would spend context saying nothing.  The count is
 * what carries the news. */
export function foldPrompts(decision: GapDecision): string {
  const prompts = [decision.run, ...decision.folded]
    .map((candidate) => (candidate.prompt ?? "").trim())
    .filter(Boolean);
  if (prompts.length === 0) return "";
  const distinct = [...new Set(prompts)];
  if (distinct.length === 1) {
    return prompts.length === 1
      ? distinct[0]!
      : `${distinct[0]}\n\n(${prompts.length} deliveries arrived while this trigger was waiting.  They are identical; handle them together.)`;
  }
  const header = `${prompts.length} deliveries arrived while this trigger was waiting.  Handle them together.`;
  return [header, ...distinct.map((prompt, index) => `--- ${index + 1} ---\n${prompt}`)].join("\n\n");
}
