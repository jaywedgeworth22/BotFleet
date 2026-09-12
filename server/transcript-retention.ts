// Bounds on the two per-thread transcript logs.  Both are append-only and,
// until this file, nothing ever trimmed them:
//
//   native/<threadId>.ndjson  — every provider protocol frame, verbatim
//                               (server/drivers/native.ts)
//   events/<threadId>.ndjson  — the normalized RuntimeEvent stream
//                               (server/harness/bus.ts)
//
// On the owner's Mac that reached 1.93 GB, 1.68 GB and 1.58 GB for three
// threads, roughly 6 GB across the directory, while the only reader —
// server/thread-events.ts, behind the Inspector panel — ever looks at the
// newest few hundred lines.  The rest is disk, backup volume and standing
// risk: a 35.7 MB routines.json rewritten on every save was enough to stall
// the harness event loop under swap pressure on 2026-09-12, and these files
// are two orders of magnitude larger than that one was.
//
// The rule is a byte cap per file, enforced by rotation.  When an append
// would carry the live log past its cap the log is renamed to
// `<threadId>.ndjson.1` and a fresh one starts, so a thread costs at most two
// caps on disk and the tail reader spans both generations.  A startup sweep
// applies the same cap to whatever the last run left behind, keeping the
// newest whole lines.  Nothing is deleted, no record shape changes, and a
// record written just after a rotation is byte-for-byte the record that would
// have been written without one.
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Cap for `native/<threadId>.ndjson`.  The native tee is the chatty half —
 * it carries every provider frame verbatim, whole file contents a tool read
 * included — and it is what the Inspector's raw lens reads.  64 MB is a few
 * hundred thousand frames, two orders of magnitude more than the panel's
 * 2,000-line ceiling will ever ask for, and caps a thread at 128 MB across
 * both generations. */
export const NATIVE_LOG_MAX_BYTES = 64 * 1024 * 1024;

/** Cap for `events/<threadId>.ndjson`.  The runtime stream is normalized and
 * several times smaller than the native tee beside it — the largest on the
 * owner's Mac is 22 MB against a 1.93 GB native sibling — so a quarter of the
 * native cap still keeps far more history than the panel shows. */
export const EVENTS_LOG_MAX_BYTES = 16 * 1024 * 1024;

/** The one rotated generation kept beside a live log. */
export const ROTATED_SUFFIX = ".1";

const COPY_CHUNK = 64 * 1024;

/** The positional five-argument `readSync`, the only form this module uses.
 * Named so the seam below is one concrete signature rather than the whole
 * overloaded builtin. */
type ReadAt = (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
const DAILY_SWEEP_MS = 24 * 60 * 60 * 1000;

/** A trim writes its kept tail to `<file>.<pid>.<uuid>.tmp` and renames it
 * over the original.  A SIGKILL or a power loss between those two steps
 * leaves the temp file behind with nothing to reclaim it, so the sweep does:
 * a temp file whose writer is gone, or that is older than an hour, is not a
 * trim in flight. */
const TEMP_NAME = /^(?:.+)\.ndjson(?:\.1)?\.(\d+)\.[0-9a-f-]{36}\.tmp$/;
const STALE_TEMP_MS = 60 * 60 * 1000;

/** Live byte counts, so the cap costs an arithmetic compare per append rather
 * than a stat(2) per line.  The first append to a path pays one stat; every
 * one after that adds the bytes it just wrote.  Bounded like the reader's
 * line-count cache: a long-lived harness sees many threads, and a stale entry
 * costs one extra stat, never correctness. */
const liveSizes = new Map<string, number>();
const SIZE_CACHE_MAX = 512;

function rememberSize(file: string, size: number): void {
  liveSizes.delete(file);
  liveSizes.set(file, size);
  while (liveSizes.size > SIZE_CACHE_MAX) liveSizes.delete(liveSizes.keys().next().value!);
}

/** Path of the rotated generation of `file`. */
export function rotatedPath(file: string): string {
  return `${file}${ROTATED_SUFFIX}`;
}

/** Both generations of a thread's log, newest first. */
export function transcriptLogPaths(dir: string, threadId: string): string[] {
  const live = join(dir, `${threadId}.ndjson`);
  return [live, rotatedPath(live)];
}

/** True when `pid` names a process that still exists.  EPERM means it exists
 * and belongs to someone else, which is still alive. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // SAFETY: `process.kill` rejects only with a system error, whose `code` is
    // the string libuv set — reading it off a non-Error would give undefined,
    // which answers "not alive" rather than throwing.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Everything a thread owns in `dir` — both generations, plus any temp file a
 * trim of either left behind — so a deleted bot or room leaves nothing on
 * disk.  Best-effort per file: a delete never fails because a log was not
 * there.  Returns how many files were removed. */
export function removeTranscriptLogs(dir: string, threadIds: Iterable<string>): number {
  const ids = [...threadIds];
  let removed = 0;
  for (const threadId of ids) {
    for (const file of transcriptLogPaths(dir, threadId)) {
      liveSizes.delete(file);
      try {
        unlinkSync(file);
        removed += 1;
      } catch {
        // not there, which is the ordinary case for a rotated generation
      }
    }
  }
  // One listing for every thread being removed, not one per thread: a room
  // with many tasks deletes them all at once.
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  const prefixes = ids.map((threadId) => `${threadId}.ndjson`);
  for (const name of names) {
    if (!TEMP_NAME.test(name) || !prefixes.some((prefix) => name.startsWith(prefix))) continue;
    try {
      unlinkSync(join(dir, name));
      removed += 1;
    } catch {
      /* best-effort cleanup */
    }
  }
  return removed;
}

function currentSize(file: string): number {
  const cached = liveSizes.get(file);
  if (cached !== undefined) return cached;
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** Rename the live log over the one rotated generation.  Returns false when
 * the rename did not happen — a file deleted under us, or a platform that
 * refuses to replace an open target — in which case the caller keeps
 * appending to the file it has rather than losing the record. */
function rotate(file: string): boolean {
  try {
    renameSync(file, rotatedPath(file));
    liveSizes.delete(file);
    return true;
  } catch {
    return false;
  }
}

/** Append to a transcript log, rotating first when this write would carry it
 * past `maxBytes`.  The cap is checked BEFORE the write, so a generation only
 * exceeds it when a single record does — and then that record is alone in the
 * file, which is the one shape a cap cannot help.  `append` exists for the
 * event bus, which injects its writer to test disk failure; it is otherwise
 * `appendFileSync`. */
export function appendBounded(
  file: string,
  data: string,
  maxBytes: number,
  options: { mode?: number } = {},
  append: typeof appendFileSync = appendFileSync,
): void {
  const bytes = Buffer.byteLength(data);
  let size = currentSize(file);
  if (size > 0 && size + bytes > maxBytes && rotate(file)) size = 0;
  append(file, data, options);
  rememberSize(file, size + bytes);
}

/** Offset of the first byte after the first newline at or after `from`, or
 * null when there is none — meaning no whole line can be kept. */
function firstLineStart(fd: number, from: number, size: number, read: ReadAt): number | null {
  const buffer = Buffer.allocUnsafe(COPY_CHUNK);
  let offset = from;
  while (offset < size) {
    const scanned = read(fd, buffer, 0, Math.min(COPY_CHUNK, size - offset), offset);
    if (scanned <= 0) return null;
    const index = buffer.subarray(0, scanned).indexOf(0x0a);
    if (index !== -1) return offset + index + 1;
    offset += scanned;
  }
  return null;
}

/** Cut an oversized log down to its newest whole lines within `maxBytes`, and
 * return the bytes reclaimed (0 when there was nothing to do).
 *
 * Never reads the file into memory — a 1.9 GB log is seeked past, not loaded —
 * and never leaves a half-written file behind: the kept tail is copied to a
 * sibling temp file, fsynced, and renamed over the original, so a reader sees
 * either the whole old file or the whole new one.  A file whose last record is
 * itself larger than the cap is left exactly as it is: there is no line
 * boundary to cut on, and emptying it would throw away the only record it
 * has.  Idempotent — a file already within the cap is opened, stat'd and left
 * alone.
 *
 * `read` is the same seam `appendBounded` has for its writer: it is
 * `readSync` in production, and a counting wrapper in the test that asserts
 * the bytes leaving the disk are bounded by the cap rather than by the size
 * of the file. */
export function trimToTail(file: string, maxBytes: number, read: ReadAt = readSync): number {
  let fd: number | null = null;
  let tmp: string | null = null;
  let out: number | null = null;
  try {
    try {
      fd = openSync(file, "r");
    } catch {
      return 0;
    }
    const stat = fstatSync(fd);
    if (stat.size <= maxBytes) return 0;
    const start = firstLineStart(fd, stat.size - maxBytes, stat.size, read);
    if (start === null || start >= stat.size) return 0;
    tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    out = openSync(tmp, "w", 0o600);
    const buffer = Buffer.allocUnsafe(COPY_CHUNK);
    let offset = start;
    while (offset < stat.size) {
      const copied = read(fd, buffer, 0, Math.min(COPY_CHUNK, stat.size - offset), offset);
      if (copied <= 0) break;
      writeFileSync(out, buffer.subarray(0, copied));
      offset += copied;
    }
    fsyncSync(out);
    closeSync(out);
    out = null;
    // Both handles are released before the rename: Windows refuses to replace
    // a file something still holds open, and the read handle is ours.
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
    tmp = null;
    // The cached size belongs to the file that was just replaced; the next
    // append re-reads it from disk rather than counting from a stale number.
    liveSizes.delete(file);
    return start;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort cleanup */
      }
    }
    if (out !== null) {
      try {
        closeSync(out);
      } catch {
        /* best-effort cleanup */
      }
    }
    if (tmp !== null) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

export interface SweepResult {
  scanned: number;
  trimmed: number;
  bytesReclaimed: number;
  /** stale temp files from a trim that was killed mid-copy */
  tempRemoved: number;
  failed: number;
}

const isTranscriptLogName = (name: string) => name.endsWith(".ndjson") || name.endsWith(`.ndjson${ROTATED_SUFFIX}`);

/** Apply the cap to every log already in `dir`.  This is what trims the files
 * an older build left behind; from then on rotation keeps them bounded and
 * the sweep finds nothing to do.
 *
 * A log this process is already appending to is skipped: rotation bounds it,
 * and trimming under the writer would drop whatever landed between the copy
 * and the rename.  At startup nothing is being appended to yet, which is when
 * the sweep that matters runs. */
export function sweepTranscriptLogs(dir: string, maxBytes: number, now: number = Date.now()): SweepResult {
  const result: SweepResult = { scanned: 0, trimmed: 0, bytesReclaimed: 0, tempRemoved: 0, failed: 0 };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return result;
  }
  for (const name of names) {
    const temp = TEMP_NAME.exec(name);
    if (temp) {
      if (reapStaleTemp(join(dir, name), Number(temp[1]), now)) result.tempRemoved += 1;
      continue;
    }
    if (!isTranscriptLogName(name)) continue;
    const file = join(dir, name);
    if (liveSizes.has(file)) continue;
    result.scanned += 1;
    try {
      const reclaimed = trimToTail(file, maxBytes);
      if (reclaimed > 0) {
        result.trimmed += 1;
        result.bytesReclaimed += reclaimed;
      }
    } catch {
      // A log that cannot be trimmed is a log that stays large — never a boot
      // that fails.  Counted so the boot line can say so.
      result.failed += 1;
    }
  }
  return result;
}

/** Remove one temp file when the trim that wrote it cannot still be running.
 * A live harness cannot meet its own temp file here — a trim is synchronous
 * and the ownership fence keeps a second harness off this directory — but the
 * rule is "its writer is gone, or it is older than an hour" rather than "any
 * temp file I find", so a future concurrent writer is not robbed mid-copy. */
function reapStaleTemp(file: string, pid: number, now: number): boolean {
  try {
    if (isProcessAlive(pid) && now - statSync(file).mtimeMs < STALE_TEMP_MS) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export interface TranscriptDirs {
  eventsDir: string;
  nativeDir: string;
}

/** Both directories at their own caps, summed. */
export function sweepTranscriptRetention(dirs: TranscriptDirs): SweepResult {
  const events = sweepTranscriptLogs(dirs.eventsDir, EVENTS_LOG_MAX_BYTES);
  const native = sweepTranscriptLogs(dirs.nativeDir, NATIVE_LOG_MAX_BYTES);
  return {
    scanned: events.scanned + native.scanned,
    trimmed: events.trimmed + native.trimmed,
    bytesReclaimed: events.bytesReclaimed + native.bytesReclaimed,
    tempRemoved: events.tempRemoved + native.tempRemoved,
    failed: events.failed + native.failed,
  };
}

/** One line for the boot log, or null when there was nothing to say. */
export function describeSweep(result: SweepResult): string | null {
  if (result.trimmed === 0 && result.failed === 0 && result.tempRemoved === 0) return null;
  const mb = (result.bytesReclaimed / (1024 * 1024)).toFixed(1);
  const temps = result.tempRemoved > 0 ? `, ${result.tempRemoved} stale temp files removed` : "";
  const failed = result.failed > 0 ? `, ${result.failed} could not be trimmed` : "";
  return `[transcripts] trimmed ${result.trimmed} of ${result.scanned} thread logs to their size cap, reclaiming ${mb} MB${temps}${failed}`;
}

/** Re-run the sweep once a day, for a harness that stays up long enough to
 * outlive the boot one.  Unref'd: it must never be the reason the process
 * stays alive.  Returns the stopper. */
export function startTranscriptRetentionSweeps(
  dirs: TranscriptDirs,
  log: (line: string) => void = console.log,
): () => void {
  const timer = setInterval(() => {
    const line = describeSweep(sweepTranscriptRetention(dirs));
    if (line) log(line);
  }, DAILY_SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
