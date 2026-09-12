// The rule these cover: a transcript log never grows past its cap, and what
// the cap displaces is still readable until the generation after next. The
// caps themselves are 64 MB and 16 MB in production; every test here passes
// its own small cap, so the behaviour is pinned without writing megabytes.
import { type appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendBounded,
  EVENTS_LOG_MAX_BYTES,
  NATIVE_LOG_MAX_BYTES,
  describeSweep,
  rotatedPath,
  sweepTranscriptLogs,
  transcriptLogPaths,
  trimToTail,
} from "./transcript-retention.ts";

const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "omb-transcript-retention-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A record of a FIXED width, so a cap can be expressed in whole lines — the
 * two-digit `n` is what keeps every line the same number of bytes. */
const record = (n: number) => JSON.stringify({ n: String(n).padStart(2, "0"), pad: "x".repeat(20) }) + "\n";
const lines = (text: string) => text.split("\n").filter(Boolean);
const ns = (text: string) => lines(text).map((l) => Number(JSON.parse(l).n));

describe("appendBounded", () => {
  it("rotates when the next append would cross the cap", () => {
    const dir = tmp();
    const file = join(dir, "t1.ndjson");
    const width = Buffer.byteLength(record(1));
    const cap = width * 3;

    for (let n = 1; n <= 3; n++) appendBounded(file, record(n), cap);
    // three records fit exactly; nothing has rotated yet
    expect(existsSync(rotatedPath(file))).toBe(false);
    expect(lines(readFileSync(file, "utf8"))).toHaveLength(3);

    appendBounded(file, record(4), cap);
    expect(ns(readFileSync(rotatedPath(file), "utf8"))).toEqual([1, 2, 3]);
    expect(ns(readFileSync(file, "utf8"))).toEqual([4]);
    expect(statSync(file).size).toBeLessThanOrEqual(cap);
  });

  it("keeps exactly one rotated generation", () => {
    const dir = tmp();
    const file = join(dir, "t2.ndjson");
    const cap = Buffer.byteLength(record(1)) * 2;
    for (let n = 1; n <= 7; n++) appendBounded(file, record(n), cap);

    expect(readdirSync(dir).sort()).toEqual(["t2.ndjson", "t2.ndjson.1"]);
    // two caps' worth on disk, never more, whatever the thread has run
    expect(statSync(file).size + statSync(rotatedPath(file)).size).toBeLessThanOrEqual(cap * 2);
    expect([...ns(readFileSync(rotatedPath(file), "utf8")), ...ns(readFileSync(file, "utf8"))]).toEqual([5, 6, 7]);
  });

  it("writes a record larger than the cap rather than dropping it", () => {
    const dir = tmp();
    const file = join(dir, "t3.ndjson");
    const huge = JSON.stringify({ big: "y".repeat(500) }) + "\n";
    appendBounded(file, huge, 64);
    expect(readFileSync(file, "utf8")).toBe(huge);
    expect(existsSync(rotatedPath(file))).toBe(false);
  });

  it("counts the file it found on disk, so a restart does not forget its size", () => {
    const dir = tmp();
    const file = join(dir, "t4.ndjson");
    const width = Buffer.byteLength(record(1));
    // written by an "earlier run": nothing is cached for this path
    writeFileSync(file, record(1) + record(2));
    appendBounded(file, record(3), width * 2);
    expect(ns(readFileSync(rotatedPath(file), "utf8"))).toEqual([1, 2]);
    expect(ns(readFileSync(file, "utf8"))).toEqual([3]);
  });

  it("uses the writer it is handed and applies the file mode", () => {
    const dir = tmp();
    const file = join(dir, "t5.ndjson");
    const seen: Array<{ file: string; data: string }> = [];
    const append: typeof appendFileSync = (path, data) => {
      seen.push({ file: String(path), data: String(data) });
    };
    appendBounded(file, record(1), 1024, { mode: 0o600 }, append);
    // the injected writer is the one that touches disk — the event bus tests
    // fail the write there, and must keep failing there
    expect(seen).toEqual([{ file, data: record(1) }]);
    expect(existsSync(file)).toBe(false);

    appendBounded(file, record(2), 1024, { mode: 0o600 });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("trimToTail", () => {
  it("keeps the newest whole lines and cuts on a line boundary", () => {
    const dir = tmp();
    const file = join(dir, "t1.ndjson");
    const width = Buffer.byteLength(record(1));
    let body = "";
    for (let n = 1; n <= 10; n++) body += record(n);
    writeFileSync(file, body);

    // a cap of three and a half records: the window opens inside record 7,
    // and the cut moves forward to the boundary rather than keeping half of it
    const cap = width * 3 + Math.floor(width / 2);
    const reclaimed = trimToTail(file, cap);
    // every kept line parses: no half record at the head
    expect(ns(readFileSync(file, "utf8"))).toEqual([8, 9, 10]);
    expect(reclaimed).toBe(width * 7);
    expect(statSync(file).size).toBeLessThanOrEqual(cap);
    // the copy left nothing behind
    expect(readdirSync(dir)).toEqual(["t1.ndjson"]);
  });

  it("is idempotent: a file already inside the cap is untouched", () => {
    const dir = tmp();
    const file = join(dir, "t2.ndjson");
    const width = Buffer.byteLength(record(1));
    let body = "";
    for (let n = 1; n <= 10; n++) body += record(n);
    writeFileSync(file, body);

    expect(trimToTail(file, width * 4)).toBeGreaterThan(0);
    const once = readFileSync(file, "utf8");
    expect(trimToTail(file, width * 4)).toBe(0);
    expect(trimToTail(file, width * 4)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(once);
  });

  it("leaves a file whose last record is bigger than the cap exactly as it is", () => {
    const dir = tmp();
    const file = join(dir, "t3.ndjson");
    const body = record(1) + JSON.stringify({ big: "z".repeat(400) }) + "\n";
    writeFileSync(file, body);
    // there is no line boundary inside the window, and emptying the file
    // would throw away the only record it has
    expect(trimToTail(file, 100)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(body);
  });

  it("does nothing for a file that is not there", () => {
    expect(trimToTail(join(tmp(), "missing.ndjson"), 10)).toBe(0);
  });
});

describe("sweepTranscriptLogs", () => {
  it("trims every oversized log in the directory, both generations", () => {
    const dir = tmp();
    const width = Buffer.byteLength(record(1));
    let body = "";
    for (let n = 1; n <= 10; n++) body += record(n);
    writeFileSync(join(dir, "a.ndjson"), body);
    writeFileSync(join(dir, "a.ndjson.1"), body);
    writeFileSync(join(dir, "b.ndjson"), record(1));
    writeFileSync(join(dir, "notes.txt"), body);

    const result = sweepTranscriptLogs(dir, width * 2 + Math.floor(width / 2));
    expect(result).toEqual({ scanned: 3, trimmed: 2, bytesReclaimed: width * 8 * 2, failed: 0 });
    expect(ns(readFileSync(join(dir, "a.ndjson"), "utf8"))).toEqual([9, 10]);
    expect(ns(readFileSync(join(dir, "a.ndjson.1"), "utf8"))).toEqual([9, 10]);
    expect(readFileSync(join(dir, "b.ndjson"), "utf8")).toBe(record(1));
    // a file that is not a transcript log is not this sweep's business
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe(body);
  });

  it("is idempotent across runs", () => {
    const dir = tmp();
    const width = Buffer.byteLength(record(1));
    let body = "";
    for (let n = 1; n <= 10; n++) body += record(n);
    writeFileSync(join(dir, "a.ndjson"), body);

    const cap = width * 3 + Math.floor(width / 2);
    expect(sweepTranscriptLogs(dir, cap).trimmed).toBe(1);
    const once = readFileSync(join(dir, "a.ndjson"), "utf8");
    // a second and third pass find a file already inside the cap: no trim, no
    // rewrite, and — the part the boot sweep depends on — no growth in state
    expect(sweepTranscriptLogs(dir, cap)).toEqual({ scanned: 1, trimmed: 0, bytesReclaimed: 0, failed: 0 });
    expect(sweepTranscriptLogs(dir, cap)).toEqual({ scanned: 1, trimmed: 0, bytesReclaimed: 0, failed: 0 });
    expect(readFileSync(join(dir, "a.ndjson"), "utf8")).toBe(once);
  });

  it("skips a log this process is appending to, because rotation already bounds it", () => {
    const dir = tmp();
    const file = join(dir, "live.ndjson");
    appendBounded(file, record(1), 1024);
    expect(sweepTranscriptLogs(dir, 1)).toEqual({ scanned: 0, trimmed: 0, bytesReclaimed: 0, failed: 0 });
    expect(readFileSync(file, "utf8")).toBe(record(1));
  });

  it("says nothing when there was nothing to do", () => {
    expect(describeSweep({ scanned: 4, trimmed: 0, bytesReclaimed: 0, failed: 0 })).toBeNull();
    expect(describeSweep({ scanned: 4, trimmed: 2, bytesReclaimed: 3 * 1024 * 1024, failed: 1 })).toContain("3.0 MB");
  });

  it("survives a directory that does not exist", () => {
    expect(sweepTranscriptLogs(join(tmp(), "nope"), 10)).toEqual({ scanned: 0, trimmed: 0, bytesReclaimed: 0, failed: 0 });
  });
});

describe("caps and paths", () => {
  it("names both generations of a thread's log", () => {
    expect(transcriptLogPaths("/data/native", "t-1")).toEqual([join("/data/native", "t-1.ndjson"), join("/data/native", "t-1.ndjson.1")]);
  });

  it("caps the chattier native tee higher than the normalized event stream", () => {
    expect(NATIVE_LOG_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(EVENTS_LOG_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(EVENTS_LOG_MAX_BYTES).toBeLessThan(NATIVE_LOG_MAX_BYTES);
  });
});
