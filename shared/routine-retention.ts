interface RetainedRun {
  id: string;
  status: string;
  createdAt: number;
  finishedAt?: number;
  coalescedInto?: string;
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "missed"]);

/** Runs that history bounds must never touch: work still awaiting a result,
 * the owner it folds into, and every run a run-now receipt still points at. */
function protectedRunIds(runs: readonly RetainedRun[], receiptResultIds: Iterable<string>): Set<string> {
  const protectedIds = new Set(receiptResultIds);
  for (const run of runs) {
    if (!TERMINAL.has(run.status)) {
      protectedIds.add(run.id);
      if (run.coalescedInto) protectedIds.add(run.coalescedInto);
    }
  }
  return protectedIds;
}

const settledAt = (run: RetainedRun) => run.finishedAt ?? run.createdAt;

/** Bound terminal history, never the work still awaiting a result.
 * Active groups are bounded by admission policy and leave this tail on settlement. */
export function retainRoutineRuns<T extends RetainedRun>(runs: T[], terminalLimit: number, receiptResultIds: Iterable<string> = []): T[] {
  if (!Number.isSafeInteger(terminalLimit) || terminalLimit < 1) throw new RangeError("Invalid history limit");
  const protectedIds = protectedRunIds(runs, receiptResultIds);
  const candidates = runs.filter((run) => !protectedIds.has(run.id));
  const excess = candidates.length - terminalLimit;
  if (excess <= 0) return runs;
  candidates.sort((a, b) => settledAt(a) - settledAt(b));
  const discard = new Set(candidates.slice(0, excess).map((run) => run.id));
  return runs.filter((run) => !discard.has(run.id));
}

/** Size bounds for a settled run's prompt snapshot.  `dataChars` is how much of
 * each untrusted event block (`[UNTRUSTED WEBHOOK EVENT DATA] … [/UNTRUSTED
 * WEBHOOK EVENT DATA]`) survives; `maxChars` caps the whole snapshot. */
export interface PromptSnapshotBounds {
  dataChars: number;
  maxChars: number;
}

export const PROMPT_SNAPSHOT_BOUNDS: PromptSnapshotBounds = { dataChars: 500, maxChars: 4_000 };

const UNTRUSTED_BLOCK = /\[(UNTRUSTED [A-Z ]+DATA)\]\n([\s\S]*?)\n\[\/\1\]/g;
const TRIMMED = /\n…\[\d+ more characters not kept in history\]$/;

function trimmed(kept: string, dropped: number): string {
  return `${kept}\n…[${dropped} more characters not kept in history]`;
}

/** Shrink a prompt snapshot for history: every untrusted event block keeps its
 * first `dataChars` characters, then the whole text is capped at `maxChars`.
 * Everything the UI parses stays where it is — the `Event:` line, the
 * user-configured instructions block, and the opening and closing markers of
 * the event block — so the Routines page and the webhook delivery list read a
 * bounded snapshot exactly as they read a full one.  Idempotent: a snapshot
 * that already carries the trim marker is left alone. */
export function boundPromptSnapshot(prompt: string, bounds: PromptSnapshotBounds = PROMPT_SNAPSHOT_BOUNDS): string {
  let out = prompt.replace(UNTRUSTED_BLOCK, (whole, name: string, body: string) =>
    body.length <= bounds.dataChars || TRIMMED.test(body)
      ? whole
      : `[${name}]\n${trimmed(body.slice(0, bounds.dataChars), body.length - bounds.dataChars)}\n[/${name}]`);
  if (out.length > bounds.maxChars && !TRIMMED.test(out)) {
    out = trimmed(out.slice(0, bounds.maxChars), out.length - bounds.maxChars);
  }
  return out;
}

/** Bound the prompt snapshot of settled runs older than the newest `keepNewest`.
 *
 * The snapshot is the bulk of a run receipt — a webhook run carries its whole
 * payload — and 2,000 of them made routines.json 35 MB, which every synchronous
 * save then re-serialized on the harness main thread.  Under memory pressure
 * that stalled the event loop for seconds at a time, the accept backlog filled,
 * and the desktop app's health probes saw resets.  Webhook and resource runs
 * have no routine to fall back to (their `routineId` is the trigger id), so the
 * snapshot is bounded, never dropped.  Protected runs (active, folded-into,
 * receipt-referenced) always keep the full text because dispatch still needs
 * it.  Mutates in place; returns the number of snapshots shortened. */
export function boundStalePromptSnapshots<T extends RetainedRun & { prompt?: string }>(
  runs: T[],
  keepNewest: number,
  receiptResultIds: Iterable<string> = [],
  bounds: PromptSnapshotBounds = PROMPT_SNAPSHOT_BOUNDS,
): number {
  if (!Number.isSafeInteger(keepNewest) || keepNewest < 0) throw new RangeError("Invalid prompt snapshot limit");
  const protectedIds = protectedRunIds(runs, receiptResultIds);
  const settled = runs.filter((run) => !protectedIds.has(run.id) && run.prompt !== undefined);
  settled.sort((a, b) => settledAt(b) - settledAt(a));
  let shortened = 0;
  for (const run of settled.slice(keepNewest)) {
    const bounded = boundPromptSnapshot(run.prompt as string, bounds);
    if (bounded !== run.prompt) {
      run.prompt = bounded;
      shortened += 1;
    }
  }
  return shortened;
}
