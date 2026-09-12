interface RetainedRun {
  id: string;
  status: string;
  createdAt: number;
  finishedAt?: number;
  coalescedInto?: string;
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "missed"]);

/** Bound terminal history, never the work still awaiting a result.
 * Active groups are bounded by admission policy and leave this tail on settlement. */
export function retainRoutineRuns<T extends RetainedRun>(runs: T[], terminalLimit: number, receiptResultIds: Iterable<string> = []): T[] {
  if (!Number.isSafeInteger(terminalLimit) || terminalLimit < 1) throw new RangeError("Invalid history limit");
  const protectedIds = new Set(receiptResultIds);
  for (const run of runs) {
    if (!TERMINAL.has(run.status)) {
      protectedIds.add(run.id);
      if (run.coalescedInto) protectedIds.add(run.coalescedInto);
    }
  }
  const candidates = runs.filter((run) => !protectedIds.has(run.id));
  const excess = candidates.length - terminalLimit;
  if (excess <= 0) return runs;
  candidates.sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));
  const discard = new Set(candidates.slice(0, excess).map((run) => run.id));
  return runs.filter((run) => !discard.has(run.id));
}
