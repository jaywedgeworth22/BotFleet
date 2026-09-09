// One writer at a time for ~/.botfleet/config.json, across processes.
//
// Two OS processes write that file: the harness server (server/config.ts's
// saveConfig) and the packaged Electron main process (the auto-updater's
// recordAutomaticCheck and the boot-time credential migrations in main.mjs).
// A second harness can appear too -- the packaged app forks its own when it
// cannot attach to the always-on one -- and it inherits the same data dir.
// Every one of them does a whole-file read-modify-write.  Temp-file-then-
// rename already makes each write atomic, so a reader sees the old file or
// the new one and never a torn one, but it does nothing for the lost-update
// race: a Settings save that lands between another writer's read and its
// rename is replaced by that writer's stale snapshot and silently reverts.
// (PR #251 review, board a2a3a586.)
//
// This module is the one door every writer goes through.  `updateConfigFile`
// takes an advisory lock, reads the file, hands the parsed object to the
// caller's `mutate`, writes the result atomically, and releases.  The lock is
// a sibling `config.json.lock` created with O_EXCL -- atomic on macOS, Linux
// and Windows -- holding the owner's pid so a lock left behind by a crashed
// process is recognised as stale and reclaimed instead of wedging every
// later save.  Reclaiming goes through an elected single reclaimer so a
// fresh lock is never removed by a waiter that judged its predecessor
// stale, and a holder that outlives its lease is fenced: it cannot write
// once the lock is no longer its own.  Readers never need the lock:
// the rename keeps reads consistent on their own.
//
// It lives under electron/ rather than shared/ because the packaged app
// ships only electron/** (electron-builder.yml `files`); the server imports
// it from here and its esbuild bundle inlines it.  Dependency-free on
// purpose: the packaged app carries no node_modules, so `proper-lockfile`
// and friends are not an option on the Electron side.  The server's
// TypeScript sees it through config-file-lock.d.mts.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** A lock older than this is reclaimed even when its owner pid still
 * answers: a healthy read-modify-write holds it for milliseconds, and pids
 * get reused, so an old lock with a live pid is usually a crashed writer
 * whose number came back around.  The other way to get here is a holder
 * suspended mid-update -- system sleep, a debugger pause, a filesystem
 * stall.  That holder is fenced, not trusted: `assertHeld` refuses its
 * write once the lease is past this age or the lock is someone else's, so
 * reclaiming can never let two writers land snapshots on one file. */
export const CONFIG_LOCK_STALE_MS = 30_000;

/** How long a writer waits for the lock before giving up with an error.
 * The wait is synchronous (the writers are), so this bounds how long a
 * stuck peer can stall the caller's event loop.  Well above any healthy
 * hold; the caller reports the failure instead of writing a stale
 * snapshot over whatever the holder is doing. */
export const CONFIG_LOCK_TIMEOUT_MS = 5_000;

const MAX_BACKOFF_MS = 50;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** The lock file that guards `configPath`. */
export function lockPathFor(configPath) {
  return `${configPath}.lock`;
}

/** Park this thread for `ms` without burning CPU.  Atomics.wait is
 * permitted on the main thread of every runtime this module runs in -- a
 * Node process, and the Electron main process is a Node isolate too.  The
 * writers are synchronous by design (the critical section is a
 * millisecond-scale read-modify-write), so a wait happens only under
 * contention and is capped by the acquire timeout. */
function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLockRecord(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
    if (isPlainObject(parsed) && Number.isInteger(parsed.pid) && Number.isFinite(parsed.at)) {
      return parsed;
    }
  } catch {
    /* missing, mid-write, or garbage -- handled by the caller */
  }
  return null;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: exists, but not ours to signal.  Only ESRCH means gone.
    return error?.code !== "ESRCH";
  }
}

function reclaimMarkerFor(lockPath) {
  return `${lockPath}.reclaim`;
}

/** The reclaim marker that guards `configPath`'s lock: waiters that judge
 * the lock stale elect one reclaimer through it (see reclaimStaleLock). */
export function reclaimPathFor(configPath) {
  return reclaimMarkerFor(lockPathFor(configPath));
}

/** What is at `lockPath` right now -- its parsed record (null when
 * unreadable) plus the inode and mtime that identify that exact file -- or
 * null when there is no lock at all. */
function inspectLock(lockPath) {
  let stat;
  try {
    stat = statSync(lockPath);
  } catch {
    return null;
  }
  return { record: readLockRecord(lockPath), ino: stat.ino, mtimeMs: stat.mtimeMs };
}

function sameLock(a, b) {
  return (
    Boolean(a && b) &&
    a.ino === b.ino &&
    a.mtimeMs === b.mtimeMs &&
    JSON.stringify(a.record) === JSON.stringify(b.record)
  );
}

/** True when the inspected lock belongs to nobody who could still release
 * it.  A record with a dead pid is stale at once; a record (or an
 * unreadable file) older than `staleMs` is stale regardless. */
function isStaleLock(seen, nowMs, staleMs) {
  if (seen.record) {
    if (nowMs - seen.record.at > staleMs) return true;
    return !processAlive(seen.record.pid);
  }
  return nowMs - seen.mtimeMs > staleMs;
}

/** Remove the stale lock `seen` without ever removing a fresh one.
 *
 * Unlinking by name cannot be made conditional on POSIX, so if every waiter
 * that judged the lock stale simply removed it, the second could remove the
 * fresh lock the first had already created in its place and two writers
 * would overlap.  Instead the waiters elect one reclaimer: whoever creates
 * the `.reclaim` marker with O_EXCL.  The winner re-inspects the lock,
 * unlinks it only if it is still the exact file it judged (same inode,
 * mtime and record), and steps down.  A loser never touches the lock; it
 * keeps waiting, so a generation created meanwhile is safe from it.  A
 * marker left by a reclaimer that died mid-way is judged by the same
 * pid-and-age rule and cleared.
 *
 * Returns true when this process held the election (whether or not the
 * lock still needed removing), false when another reclaimer holds it. */
function reclaimStaleLock(lockPath, seen, nowMs, staleMs) {
  const marker = reclaimMarkerFor(lockPath);
  let fd = null;
  try {
    fd = openSync(marker, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: nowMs }));
    closeSync(fd);
    fd = null;
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
    if (error?.code !== "EEXIST") throw error;
    const other = inspectLock(marker);
    if (other && isStaleLock(other, nowMs, staleMs)) {
      try {
        unlinkSync(marker);
      } catch {
        /* the reclaimer finished or a peer cleared it first */
      }
    }
    return false;
  }
  try {
    if (sameLock(inspectLock(lockPath), seen)) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* gone already */
      }
    }
  } finally {
    try {
      unlinkSync(marker);
    } catch {
      /* best-effort */
    }
  }
  return true;
}

/** Acquire the advisory lock for `configPath`.  Returns a handle with
 * `release()` and `assertHeld()`.  Synchronous, like the writers that use
 * it: waits with short sleeps until the lock is free, reclaims a stale
 * one, and throws after `timeoutMs` so a wedged peer surfaces as an error
 * instead of a silent overwrite.  Re-entering from the process that
 * already holds the lock is a bug, not a wait, and throws immediately. */
export function acquireConfigFileLock(configPath, options = {}) {
  const lockPath = lockPathFor(configPath);
  const staleMs = options.staleMs ?? CONFIG_LOCK_STALE_MS;
  const timeoutMs = options.timeoutMs ?? CONFIG_LOCK_TIMEOUT_MS;
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  let backoffMs = 2;
  for (;;) {
    const ours = { pid: process.pid, at: Date.now() };
    let fd = null;
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(ours));
      closeSync(fd);
      fd = null;
      let released = false;
      const stillOurs = () => {
        const current = readLockRecord(lockPath);
        return Boolean(current && current.pid === ours.pid && current.at === ours.at);
      };
      return {
        /** Throw unless this handle still owns the lock and its lease has
         * not run out.  `updateConfigFile` calls it right before the rename,
         * so a holder that was suspended past the stale window (system
         * sleep, a debugger pause, a filesystem stall) and whose lock a peer
         * has since reclaimed can never land its stale snapshot on top of
         * the peer's write.  The lease is what makes reclaiming safe. */
        assertHeld() {
          if (released) throw new Error(`config lock already released: ${lockPath}`);
          if (Date.now() - ours.at > staleMs) {
            throw new Error(
              `config lock lease expired after ${staleMs} ms; refusing to write a stale snapshot: ${lockPath}`,
            );
          }
          if (!stillOurs()) {
            throw new Error(`config lock was reclaimed by another writer; refusing to write a stale snapshot: ${lockPath}`);
          }
        },
        release() {
          if (released) return;
          released = true;
          // Only remove what is still ours.  If we overran the lease a peer
          // has reclaimed this lock and written its own; deleting that would
          // hand the file to a third writer mid-update.
          if (!stillOurs()) return;
          try {
            unlinkSync(lockPath);
          } catch {
            /* already reclaimed -- nothing left to release */
          }
        },
      };
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* best-effort */
        }
      }
      if (error?.code !== "EEXIST") throw error;
    }
    const now = Date.now();
    const seen = inspectLock(lockPath);
    if (!seen) continue; // released between our attempt and this look
    const holder = seen.record;
    if (holder && holder.pid === process.pid && now - holder.at <= staleMs) {
      throw new Error(`config lock re-entered by this process: ${lockPath}`);
    }
    if (isStaleLock(seen, now, staleMs) && reclaimStaleLock(lockPath, seen, now, staleMs)) {
      continue; // we held the election: try the create again at once
    }
    if (now - startedAt >= timeoutMs) {
      const who = holder ? `pid ${holder.pid}` : "an unknown writer";
      throw new Error(`config lock held by ${who} for more than ${timeoutMs} ms: ${lockPath}`);
    }
    sleepSync(backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
}

/** Run `fn(lock)` while holding the lock for `configPath`. */
export function withConfigFileLock(configPath, fn, options = {}) {
  const lock = acquireConfigFileLock(configPath, options);
  try {
    return fn(lock);
  } finally {
    lock.release();
  }
}

/** The parsed config object on disk, or `{}` when the file is missing or
 * not a JSON object -- the state of a fresh install, not an error.  Every
 * writer treats that the same way, so it lives here once. */
export function readConfigFile(configPath) {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Durable, atomic file replace: write a sibling temp file, fsync it, rename
 * it over the target.  Mirrors server/atomic.ts, which the packaged Electron
 * process cannot import (only electron/** ships). */
export function writeFileAtomic(path, data, options = {}) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = openSync(temporary, "w", options.mode);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, path);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}

/** The locked read-modify-write every config.json writer must use.
 *
 * Under the lock: read the file (`{}` when absent), call `mutate(disk)`,
 * and write what it returns.  `mutate` may edit `disk` in place and return
 * nothing, return a replacement object, or return `null` to say the file is
 * already right and must not be rewritten.  It must be synchronous: the
 * lock is held for the duration of this call and released on the way out,
 * success or throw.  Returns the object now on disk.  Throws without
 * writing if the lease expired or a peer reclaimed the lock meanwhile. */
export function updateConfigFile(configPath, mutate, options = {}) {
  return withConfigFileLock(
    configPath,
    (lock) => {
      const disk = readConfigFile(configPath);
      const next = mutate(disk);
      if (next && typeof next.then === "function") {
        throw new TypeError("updateConfigFile: mutate must be synchronous");
      }
      if (next === null) return disk;
      const toWrite = next === undefined ? disk : next;
      // Fence: refuse to rename if this lease ran out or a peer reclaimed
      // the lock while `mutate` ran.  Nothing was written yet, so the peer's
      // file stays intact and the caller sees an error instead.
      lock.assertHeld();
      writeFileAtomic(configPath, JSON.stringify(toWrite, null, 2), { mode: options.mode ?? 0o600 });
      return toWrite;
    },
    options,
  );
}
