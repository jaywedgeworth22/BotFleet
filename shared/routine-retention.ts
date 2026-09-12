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

/** Drop the prompt snapshot from settled runs older than the newest `keepNewest`.
 *
 * The snapshot is the bulk of a run receipt — a webhook run carries its whole
 * payload — and 2,000 of them made routines.json 35 MB, which every synchronous
 * save then re-serialized on the harness main thread.  Under memory pressure
 * that stalled the event loop for seconds at a time, the accept backlog filled,
 * and the desktop app's health probes saw resets.  Settled history keeps its
 * outcome, output and timings; readers fall back to the routine's current
 * prompt.  Protected runs (active, folded-into, receipt-referenced) always keep
 * theirs because dispatch still needs them.  Mutates in place; returns the
 * number of snapshots dropped. */
export function stripStalePromptSnapshots<T extends RetainedRun & { prompt?: string }>(
  runs: T[],
  keepNewest: number,
  receiptResultIds: Iterable<string> = [],
): number {
  if (!Number.isSafeInteger(keepNewest) || keepNewest < 0) throw new RangeError("Invalid prompt snapshot limit");
  const protectedIds = protectedRunIds(runs, receiptResultIds);
  const settled = runs.filter((run) => !protectedIds.has(run.id) && run.prompt !== undefined);
  settled.sort((a, b) => settledAt(b) - settledAt(a));
  let dropped = 0;
  for (const run of settled.slice(keepNewest)) {
    delete run.prompt;
    dropped += 1;
  }
  return dropped;
}
