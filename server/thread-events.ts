// The inspector's data: what a thread's turn actually looked like on the
// wire. Nothing new is captured here — the harness already tees two logs
// per thread, and this just reads them back:
//
//   events/<threadId>.ndjson  — the normalized RuntimeEvent stream the bus
//                               publishes (server/harness/bus.ts)
//   native/<threadId>.ndjson  — the provider's own protocol messages,
//                               verbatim and secret-redacted
//                               (server/drivers/native.ts)
//
// Each log is capped and rotated (server/transcript-retention.ts), so a
// thread's history is the live file plus at most one `.ndjson.1` beside it,
// and the tail read here spans both.
//
// Merged by timestamp so a tool call and the raw message behind it sit
// next to each other. Newest-`limit` only: a long-lived thread has
// thousands of native lines and the panel wants the recent ones first.
import { closeSync, fstatSync, openSync, readSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { RuntimeEvent } from "./contracts.ts";
import { rotatedPath } from "./transcript-retention.ts";

/** One line of native/<threadId>.ndjson (server/drivers/native.ts). */
export interface NativeRecord {
  at: string;
  dir: "in" | "out";
  source: string;
  msg: unknown;
}

export type InspectorEntry =
  | { kind: "runtime"; at: string; data: RuntimeEvent }
  | { kind: "native"; at: string; data: NativeRecord };

export interface InspectorPage {
  entries: InspectorEntry[];
  /** line counts before the cap, so the UI can say "showing 200 of 1,687" */
  total: { runtime: number; native: number };
}

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 2000;
const READ_CHUNK = 64 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
/** Ceiling on the single-record fallback below.  Matches the largest a log
 * can be after retention (server/transcript-retention.ts). */
const MAX_RECORD_BYTES = 64 * 1024 * 1024;

interface LineCount {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  complete: number;
  trailing: boolean;
}
type FileStat = Pick<Stats, "dev" | "ino" | "size" | "mtimeMs">;

// Counts are incremental per append-only log. The first request scans bytes
// once (without decoding or parsing every JSON record); later requests inspect
// only bytes appended since the cached size. Keep this bounded across threads.
const lineCounts = new Map<string, LineCount>();
const LINE_COUNT_CACHE_MAX = 256;

/** Thread ids are uuids the harness minted; anything else is not a file we
 * should be reading. */
function assertThreadId(threadId: string) {
  if (!/^[\w-]+$/.test(threadId)) throw new Error("invalid thread id");
}

function countLines(fd: number, file: string, stat: FileStat): number {
  const previous = lineCounts.get(file);
  const appended =
    previous &&
    previous.dev === stat.dev &&
    previous.ino === stat.ino &&
    stat.size >= previous.size &&
    (stat.size > previous.size || stat.mtimeMs === previous.mtimeMs);
  if (appended && stat.size === previous.size) return previous.complete + Number(previous.trailing);

  let offset = appended ? previous.size : 0;
  let complete = appended ? previous.complete : 0;
  let trailing = appended ? previous.trailing : false;
  while (offset < stat.size) {
    const length = Math.min(READ_CHUNK, stat.size - offset);
    const chunk = Buffer.allocUnsafe(length);
    const read = readSync(fd, chunk, 0, length, offset);
    if (read <= 0) break;
    for (let i = 0; i < read; i++) {
      if (chunk[i] === 0x0a) {
        if (trailing) complete++;
        trailing = false;
      } else if (chunk[i] !== 0x0d) {
        trailing = true;
      }
    }
    offset += read;
  }
  const next = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, complete, trailing };
  lineCounts.delete(file);
  lineCounts.set(file, next);
  while (lineCounts.size > LINE_COUNT_CACHE_MAX) lineCounts.delete(lineCounts.keys().next().value!);
  return complete + Number(trailing);
}

type RecordGuard<T> = (value: unknown) => value is T;

/** What one log file contributes to a page: its newest valid records, and how
 * many lines it holds in total. */
interface LogPage<T> {
  lines: T[];
  total: number;
}

interface LogTail<T> extends LogPage<T> {
  /** True when the backward scan reached byte zero — every line in the file
   * was considered.  False when it stopped at the tail window, which means
   * there are older records in THIS file that the page does not show. */
  exhausted: boolean;
}

function parseRecent<T>(text: string, includeFirst: boolean, limit: number, valid: RecordGuard<T>): T[] {
  const lines = text.split("\n");
  if (!includeFirst) lines.shift();
  const out: T[] = [];
  for (const raw of lines) {
    if (!raw) continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (valid(value)) out.push(value);
    } catch {
      // A torn line during a write, or a hand-edited record. Keep looking
      // farther back until we still have `limit` valid recent entries.
    }
  }
  return out.slice(-limit);
}

/** The newest `limit` valid records of ONE file, plus its line count.  A
 * `limit` of zero counts without parsing, which is how the rotated generation
 * is counted when the live file already filled the page. */
function readTail<T>(file: string, limit: number, valid: RecordGuard<T>, maxTailBytes: number): LogTail<T> {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return { lines: [], total: 0, exhausted: true };
  }
  try {
    const stat = fstatSync(fd);
    const total = countLines(fd, file, stat);
    if (limit <= 0) return { lines: [], total, exhausted: stat.size === 0 };
    let position = stat.size;
    let bytes = Buffer.alloc(0);
    let lines: T[] = [];
    while (position > 0 && bytes.length < maxTailBytes) {
      const remaining = maxTailBytes - bytes.length;
      const start = Math.max(0, position - Math.min(READ_CHUNK, remaining));
      const length = position - start;
      const chunk = Buffer.allocUnsafe(length);
      const read = readSync(fd, chunk, 0, length, start);
      if (read <= 0) break;
      bytes = Buffer.concat([chunk.subarray(0, read), bytes]);
      position = start;
      // The first line is partial until we reach byte zero. Parse only once
      // enough complete candidates exist; corrupt candidates make us keep
      // walking backwards rather than returning fewer valid rows.
      const text = bytes.toString("utf8");
      if (position === 0 || text.split("\n").length - 1 >= limit) {
        lines = parseRecent(text, position === 0, limit, valid);
        if (lines.length >= limit || position === 0) break;
      }
    }
    if (lines.length === 0 && bytes.length > 0) {
      lines = parseRecent(bytes.toString("utf8"), position === 0, limit, valid);
    }
    // A record wider than the window leaves the scan above with no newline to
    // cut on, so it returns nothing at all against a nonzero total — the
    // panel goes blank for the one thread whose newest message is the reason
    // anyone opened it.  Walk back past the window to that record's own
    // boundary instead.
    if (lines.length === 0 && position > 0) lines = readNewestRecord(fd, stat.size, valid);
    return { lines, total, exhausted: position === 0 };
  } finally {
    closeSync(fd);
  }
}

/** The newest complete record of a file, whatever its width — the fallback
 * for a record too wide for the tail window.  Bounded by MAX_RECORD_BYTES:
 * a log is capped at 64 MB by server/transcript-retention.ts, and a single
 * record wider than that is the one shape nothing here can help. */
function readNewestRecord<T>(fd: number, size: number, valid: RecordGuard<T>): T[] {
  if (size === 0) return [];
  const scan = Buffer.allocUnsafe(READ_CHUNK);
  // the record ends at the final newline, or at EOF when the last write was
  // torn before its terminator
  let end = size;
  if (readSync(fd, scan, 0, 1, size - 1) === 1 && scan[0] === 0x0a) end = size - 1;
  if (end === 0) return [];
  let position = end;
  let start = 0;
  while (position > 0 && end - position < MAX_RECORD_BYTES) {
    const from = Math.max(0, position - READ_CHUNK);
    const read = readSync(fd, scan, 0, position - from, from);
    if (read <= 0) return [];
    const index = scan.subarray(0, read).lastIndexOf(0x0a);
    if (index !== -1) {
      start = from + index + 1;
      break;
    }
    position = from;
  }
  const length = end - start;
  if (length <= 0 || length > MAX_RECORD_BYTES) return [];
  const record = Buffer.allocUnsafe(length);
  const read = readSync(fd, record, 0, length, start);
  if (read <= 0) return [];
  try {
    const value: unknown = JSON.parse(record.subarray(0, read).toString("utf8"));
    return valid(value) ? [value] : [];
  } catch {
    return [];
  }
}

/** A thread's log spans at most two files: the live one and the single
 * rotated generation beside it (server/transcript-retention.ts).  Rotation is
 * what keeps either from growing without bound, so the panel reads across the
 * seam — the newest lines come from the live file, and the rotated one both
 * completes a short page and keeps the "showing 200 of 1,687" count honest
 * about what is still on disk.
 *
 * The rotated file is spliced on ONLY when the live file was read to its
 * first byte.  A live file short of `limit` for any other reason — it hit the
 * tail window, or its own records failed the guard — still holds records
 * between what came back and where the rotated file ends, and splicing across
 * that would hand the panel a page with a silent gap in the middle of it,
 * looking for all the world like a contiguous history. */
function readRecentLines<T>(file: string, limit: number, valid: RecordGuard<T>, maxTailBytes: number): LogPage<T> {
  const live = readTail(file, limit, valid, maxTailBytes);
  const need = live.exhausted ? limit - live.lines.length : 0;
  // `need` of zero still counts the rotated file's lines, so the footer
  // describes the history that exists rather than the page that was built.
  const rotated = readTail(rotatedPath(file), need, valid, maxTailBytes);
  return { lines: [...rotated.lines, ...live.lines], total: live.total + rotated.total };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringOrMissing = (value: unknown) => value === undefined || typeof value === "string";
const stringOrNullOrMissing = (value: unknown) => value === undefined || value === null || typeof value === "string";
const numberOrNullOrMissing = (value: unknown) => value === undefined || value === null || typeof value === "number";
const stringsOrMissing = (value: unknown) => value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (
    !isRecord(value) ||
    typeof value.eventId !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.threadId !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.type !== "string" ||
    !stringOrMissing(value.providerInstanceId) ||
    !stringOrMissing(value.turnId) ||
    !stringOrMissing(value.itemId) ||
    !stringOrMissing(value.requestId)
  ) return false;
  switch (value.type) {
    case "session.started":
      return (value.sessionId === null || typeof value.sessionId === "string") && stringOrNullOrMissing(value.model);
    case "session.exited":
      return stringOrMissing(value.reason);
    case "turn.started":
      return true;
    case "turn.retrying":
      return (
        typeof value.attempt === "number" &&
        Number.isInteger(value.attempt) &&
        value.attempt >= 1 &&
        typeof value.delayMs === "number" &&
        Number.isFinite(value.delayMs) &&
        value.delayMs >= 0 &&
        typeof value.reason === "string"
      );
    case "turn.completed":
      return (
        typeof value.ok === "boolean" &&
        stringOrNullOrMissing(value.stopReason) &&
        numberOrNullOrMissing(value.cost) &&
        stringsOrMissing(value.denials) &&
        (value.usage === undefined ||
          (isRecord(value.usage) && typeof value.usage.input === "number" && typeof value.usage.output === "number"))
      );
    case "item.started":
      return (value.itemType === "tool" || value.itemType === "reasoning") && stringOrMissing(value.title);
    case "item.updated":
      return (value.itemType === "tool" || value.itemType === "reasoning") && numberOrNullOrMissing(value.tokens);
    case "item.completed":
      return value.itemType === "assistant_text" ? typeof value.text === "string" : value.itemType === "tool" && typeof value.ok === "boolean";
    case "content.delta":
      return (value.streamKind === "assistant_text" || value.streamKind === "reasoning_text") && typeof value.delta === "string";
    case "request.opened":
      return (
        (value.requestType === "permission" || value.requestType === "question") &&
        typeof value.tool === "string" &&
        typeof value.summary === "string" &&
        stringsOrMissing(value.choices)
      );
    case "request.resolved":
      return (
        (value.behavior === "allow" || value.behavior === "deny" || value.behavior === "answer") &&
        (value.source === "user" ||
          value.source === "auto" ||
          value.source === "timeout" ||
          value.source === "system" ||
          value.source === "unavailable" ||
          value.source === "peer")
      );
    case "thread.token-usage.updated":
      return typeof value.input === "number" && typeof value.output === "number";
    case "runtime.error":
      return typeof value.message === "string" && (value.setup === undefined || typeof value.setup === "boolean");
    default:
      return false;
  }
}

function isNativeRecord(value: unknown): value is NativeRecord {
  return (
    isRecord(value) &&
    typeof value.at === "string" &&
    (value.dir === "in" || value.dir === "out") &&
    typeof value.source === "string" &&
    Object.hasOwn(value, "msg")
  );
}

export function readThreadEvents(input: {
  eventsDir: string;
  nativeDir: string;
  threadId: string;
  limit?: number;
  /** How far back either file is read before the page is called done.
   * Defaults to MAX_TAIL_BYTES; tests set it small so the window's edge can
   * be exercised without an 8 MB fixture. */
  maxTailBytes?: number;
}): InspectorPage {
  const { eventsDir, nativeDir, threadId } = input;
  assertThreadId(threadId);
  const requested = input.limit ?? DEFAULT_LIMIT;
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(Math.trunc(requested), MAX_LIMIT)) : DEFAULT_LIMIT;
  const window = Number.isFinite(input.maxTailBytes) ? Math.max(1, Math.trunc(input.maxTailBytes!)) : MAX_TAIL_BYTES;

  const runtime = readRecentLines(join(eventsDir, `${threadId}.ndjson`), limit, isRuntimeEvent, window);
  const native = readRecentLines(join(nativeDir, `${threadId}.ndjson`), limit, isNativeRecord, window);

  // cap each log on its own, then merge: the native tee is several times
  // chattier than the runtime stream, and one shared cap would leave the
  // Events lens with a handful of rows behind hundreds of raw ones
  const merged: InspectorEntry[] = [
    ...runtime.lines.map((data): InspectorEntry => ({ kind: "runtime", at: data.createdAt, data })),
    ...native.lines.map((data): InspectorEntry => ({ kind: "native", at: data.at, data })),
  ];
  // stable sort: ties keep file order, which is emit order
  merged.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return {
    entries: merged,
    total: { runtime: runtime.total, native: native.total },
  };
}
