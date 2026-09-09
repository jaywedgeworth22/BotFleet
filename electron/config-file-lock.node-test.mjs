// node:test coverage for the cross-process config.json lock.  The race
// tests spawn real Node processes: a synchronous lock cannot be raced from
// inside one event loop, and the bug it closes (PR #251 review, board
// a2a3a586) is between the harness server and the Electron main process --
// two OS processes -- so that is what gets exercised.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONFIG_LOCK_STALE_MS,
  acquireConfigFileLock,
  lockPathFor,
  readConfigFile,
  reclaimPathFor,
  updateConfigFile,
  withConfigFileLock,
  writeFileAtomic,
} from "./config-file-lock.mjs";

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(sleepCell, 0, 0, ms);

const MODULE_URL = new URL("./config-file-lock.mjs", import.meta.url).href;

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-config-lock-"));
  return { dir, path: join(dir, "config.json") };
}

/** Run an ES-module body in a fresh Node process with the lock module bound
 * as `mod` and `env` merged into its environment.  Resolves with stdout on
 * exit 0.  `onLine` sees each stdout line as it arrives, for handshakes. */
function runWorker(source, env, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", `import * as mod from ${JSON.stringify(MODULE_URL)};\n${source}`],
      { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (onLine) for (const line of String(chunk).split("\n")) if (line) onLine(line);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`worker exited ${code}: ${stderr}`));
    });
  });
}

/** A worker that takes the lock, announces it, holds it for CFL_HOLD_MS
 * while writing a marker straight into the file, then releases. */
const HOLDER_SOURCE = `
const path = process.env.CFL_PATH;
const lock = mod.acquireConfigFileLock(path);
console.log("locked");
await new Promise((r) => setTimeout(r, Number(process.env.CFL_HOLD_MS)));
mod.writeFileAtomic(path, JSON.stringify({ holder: "worker" }));
lock.release();
console.log("released");
`;

/** A worker that increments its own section's counter CFL_N times through
 * the locked read-modify-write -- the shape of every real config writer. */
const COUNTER_SOURCE = `
const path = process.env.CFL_PATH;
const section = process.env.CFL_SECTION;
const options = { timeoutMs: Number(process.env.CFL_TIMEOUT_MS ?? 5000) };
for (let i = 0; i < Number(process.env.CFL_N); i += 1) {
  mod.updateConfigFile(path, (disk) => {
    const current = disk[section] ?? { count: 0 };
    disk[section] = { count: current.count + 1 };
  }, options);
}
console.log("done");
`;

function waitForLine(wanted) {
  let resolveLine;
  const seen = new Promise((resolve) => {
    resolveLine = resolve;
  });
  return {
    seen,
    onLine: (line) => {
      if (line === wanted) resolveLine();
    },
  };
}

test("updateConfigFile starts from an empty object when the file is missing or not a JSON object", () => {
  const { dir, path } = tempConfig();
  try {
    let seen;
    updateConfigFile(path, (disk) => {
      seen = { ...disk };
      disk.first = true;
    });
    assert.deepEqual(seen, {});
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { first: true });

    writeFileSync(path, "{ not json");
    updateConfigFile(path, (disk) => {
      seen = { ...disk };
      disk.second = true;
    });
    assert.deepEqual(seen, {});
    assert.deepEqual(readConfigFile(path), { second: true });

    writeFileSync(path, "[1,2,3]");
    assert.deepEqual(readConfigFile(path), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateConfigFile leaves the file untouched when mutate returns null", () => {
  const { dir, path } = tempConfig();
  try {
    writeFileSync(path, '{"keep":1}');
    const result = updateConfigFile(path, () => null);
    assert.deepEqual(result, { keep: 1 });
    assert.equal(readFileSync(path, "utf8"), '{"keep":1}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateConfigFile accepts a replacement object and rejects an async mutate", () => {
  const { dir, path } = tempConfig();
  try {
    updateConfigFile(path, (disk) => ({ ...disk, replaced: true }));
    assert.deepEqual(readConfigFile(path), { replaced: true });
    assert.throws(() => updateConfigFile(path, async () => {}), /must be synchronous/);
    assert.equal(existsSync(lockPathFor(path)), false, "lock released after the rejected call");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the lock is released after the update, including when mutate throws", () => {
  const { dir, path } = tempConfig();
  try {
    updateConfigFile(path, (disk) => {
      disk.ok = true;
      assert.equal(existsSync(lockPathFor(path)), true, "lock held while mutating");
    });
    assert.equal(existsSync(lockPathFor(path)), false);
    assert.throws(
      () =>
        updateConfigFile(path, () => {
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(existsSync(lockPathFor(path)), false, "lock released after the throw");
    assert.deepEqual(readConfigFile(path), { ok: true }, "a throwing mutate writes nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFileAtomic runs beforeRename after staging and drops the staged file when it throws", () => {
  const { dir, path } = tempConfig();
  try {
    writeFileSync(path, '{"before":true}');
    let stagedSeen = false;
    assert.throws(
      () =>
        writeFileAtomic(path, '{"after":true}', {
          beforeRename: () => {
            // The temp file is fully written and fsynced by now; the target
            // is still the old contents.
            stagedSeen = readdirSync(dir).some((name) => name.startsWith("config.json.") && name.endsWith(".tmp"));
            assert.equal(readFileSync(path, "utf8"), '{"before":true}');
            throw new Error("fence says no");
          },
        }),
      /fence says no/,
    );
    assert.equal(stagedSeen, true, "the hook ran with the temp file staged");
    assert.equal(readFileSync(path, "utf8"), '{"before":true}', "the target was not replaced");
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "the staged file was removed");
    writeFileAtomic(path, '{"after":true}', { beforeRename: () => {} });
    assert.equal(readFileSync(path, "utf8"), '{"after":true}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-entering the lock from the process that holds it throws instead of hanging", () => {
  const { dir, path } = tempConfig();
  try {
    assert.throws(
      () => withConfigFileLock(path, () => updateConfigFile(path, () => null)),
      /re-entered by this process/,
    );
    assert.equal(existsSync(lockPathFor(path)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock left behind by a dead process is reclaimed", () => {
  const { dir, path } = tempConfig();
  try {
    // A child that has already exited: its pid is no longer alive, and pids
    // are not recycled quickly enough for this to be anything else.
    const gone = spawnSync(process.execPath, ["-e", "0"]);
    assert.equal(gone.status, 0);
    writeFileSync(lockPathFor(path), JSON.stringify({ pid: gone.pid, at: Date.now() }));
    const started = Date.now();
    updateConfigFile(path, (disk) => {
      disk.reclaimed = true;
    }, { timeoutMs: 2_000 });
    assert.ok(Date.now() - started < 1_500, "reclaimed without waiting out the timeout");
    assert.deepEqual(readConfigFile(path), { reclaimed: true });
    assert.equal(existsSync(lockPathFor(path)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a waiter that loses the reclaim election waits instead of touching the stale lock", () => {
  const { dir, path } = tempConfig();
  try {
    const gone = spawnSync(process.execPath, ["-e", "0"]);
    writeFileSync(lockPathFor(path), JSON.stringify({ pid: gone.pid, at: Date.now() }));
    const before = readFileSync(lockPathFor(path), "utf8");
    // A live reclaimer (this pid, fresh) already holds the election.
    writeFileSync(reclaimPathFor(path), JSON.stringify({ pid: process.pid, at: Date.now() }));
    assert.throws(() => acquireConfigFileLock(path, { timeoutMs: 150 }), /config lock held by pid \d+/);
    assert.equal(readFileSync(lockPathFor(path), "utf8"), before, "the loser left the lock exactly as it was");
    assert.equal(existsSync(reclaimPathFor(path)), true, "and did not clear a live reclaimer's marker");
    // Once the reclaimer is gone the next waiter wins the election and proceeds.
    rmSync(reclaimPathFor(path));
    updateConfigFile(path, (disk) => {
      disk.won = true;
    }, { timeoutMs: 1_000 });
    assert.deepEqual(readConfigFile(path), { won: true });
    assert.equal(existsSync(reclaimPathFor(path)), false, "the marker is released after reclaiming");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reclaim marker left by a dead reclaimer is cleared", () => {
  const { dir, path } = tempConfig();
  try {
    const gone = spawnSync(process.execPath, ["-e", "0"]);
    writeFileSync(lockPathFor(path), JSON.stringify({ pid: gone.pid, at: Date.now() }));
    writeFileSync(reclaimPathFor(path), JSON.stringify({ pid: gone.pid, at: Date.now() }));
    updateConfigFile(path, (disk) => {
      disk.cleared = true;
    }, { timeoutMs: 2_000 });
    assert.deepEqual(readConfigFile(path), { cleared: true });
    assert.equal(existsSync(lockPathFor(path)), false);
    assert.equal(existsSync(reclaimPathFor(path)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The P1 from review: several writers wake up behind one abandoned lock.
// Without the election, the second to judge it stale could remove the fresh
// lock the first had just created, and the two would overlap.
test("several writers behind one dead-pid lock all get through without losing an update", async () => {
  const { dir, path } = tempConfig();
  const N = 20;
  const sections = ["a", "b", "c", "d"];
  try {
    const gone = spawnSync(process.execPath, ["-e", "0"]);
    writeFileSync(lockPathFor(path), JSON.stringify({ pid: gone.pid, at: Date.now() }));
    const env = { CFL_PATH: path, CFL_N: String(N), CFL_TIMEOUT_MS: "30000" };
    await Promise.all(sections.map((section) => runWorker(COUNTER_SOURCE, { ...env, CFL_SECTION: section })));
    const final = readConfigFile(path);
    assert.deepEqual(final, Object.fromEntries(sections.map((section) => [section, { count: N }])));
    assert.equal(existsSync(lockPathFor(path)), false, "no lock left behind");
    assert.equal(existsSync(reclaimPathFor(path)), false, "no reclaim marker left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock older than staleMs is reclaimed even when its pid is alive", () => {
  const { dir, path } = tempConfig();
  try {
    assert.ok(CONFIG_LOCK_STALE_MS > 0);
    writeFileSync(lockPathFor(path), JSON.stringify({ pid: process.pid, at: Date.now() - 500 }));
    updateConfigFile(path, (disk) => {
      disk.aged = true;
    }, { staleMs: 100, timeoutMs: 1_000 });
    assert.deepEqual(readConfigFile(path), { aged: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The lease is what makes age-based reclaim safe.  A holder that was
// suspended past the stale window (system sleep, a debugger, a filesystem
// stall) must not land the snapshot it read before it was suspended.
test("a holder whose lease ran out refuses to write rather than land a stale snapshot", () => {
  const { dir, path } = tempConfig();
  try {
    writeFileSync(path, '{"fresh":true}');
    assert.throws(
      () =>
        updateConfigFile(
          path,
          (disk) => {
            sleepSync(120); // "suspended" inside the critical section
            disk.stale = true;
          },
          { staleMs: 50, timeoutMs: 500 },
        ),
      /lease expired/,
    );
    assert.deepEqual(readConfigFile(path), { fresh: true }, "nothing was written");
    // Past its lease the handle no longer unlinks by name (a reclaimer may
    // be replacing the lock); the lock is left for the election instead.
    assert.equal(existsSync(lockPathFor(path)), true, "the expired lock is left for the reclaim path");
    updateConfigFile(path, (disk) => {
      disk.later = true;
    }, { staleMs: 50, timeoutMs: 1_000 });
    assert.deepEqual(readConfigFile(path), { fresh: true, later: true });
    assert.equal(existsSync(lockPathFor(path)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a release inside the lease unlinks; one past the usable lease leaves the lock to the election", () => {
  const { dir, path } = tempConfig();
  try {
    acquireConfigFileLock(path, { staleMs: 400 }).release();
    assert.equal(existsSync(lockPathFor(path)), false, "released inside the lease");
    const late = acquireConfigFileLock(path, { staleMs: 400 });
    sleepSync(330); // inside staleMs but past the 100 ms margin
    late.release();
    assert.equal(existsSync(lockPathFor(path)), true, "left in place rather than unlinked by name");
    // Once the full lease is out the next writer reclaims it and proceeds.
    // (Waited out here because a same-process acquire inside the lease reads
    // as re-entry; another process would simply wait the margin out.)
    sleepSync(120);
    updateConfigFile(path, (disk) => {
      disk.next = true;
    }, { staleMs: 400, timeoutMs: 2_000 });
    assert.deepEqual(readConfigFile(path), { next: true });
    assert.equal(existsSync(lockPathFor(path)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a suspended holder whose lock a peer reclaimed cannot write over the peer or drop its lock", () => {
  const { dir, path } = tempConfig();
  try {
    const suspended = acquireConfigFileLock(path, { staleMs: 200 });
    sleepSync(400); // past its lease; nobody has touched the lock yet
    // A peer with the same stale window finds the lock past it and reclaims
    // it.  The same process stands in for the peer here: the record's
    // pid+at pair is what identifies a holder, and this is a fresh one.
    const peer = acquireConfigFileLock(path, { staleMs: 200, timeoutMs: 1_000 });
    writeFileAtomic(path, JSON.stringify({ holder: "peer" }));
    assert.throws(() => suspended.assertHeld(), /lease expired|reclaimed by another writer/);
    suspended.release();
    assert.equal(existsSync(lockPathFor(path)), true, "the peer's lock survives the stale holder's release");
    peer.release();
    assert.equal(existsSync(lockPathFor(path)), false);
    assert.deepEqual(readConfigFile(path), { holder: "peer" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable lock file older than staleMs is reclaimed, a fresh one is waited on", () => {
  const { dir, path } = tempConfig();
  try {
    writeFileSync(lockPathFor(path), "garbage");
    // Fresh garbage: nobody can prove it stale yet, so the writer times out.
    assert.throws(
      () => updateConfigFile(path, () => null, { staleMs: 10_000, timeoutMs: 150 }),
      /held by an unknown writer/,
    );
    // The same garbage once it is old enough (its mtime is all there is to
    // judge by): reclaimed and written through.
    const past = new Date(Date.now() - 10_000);
    utimesSync(lockPathFor(path), past, past);
    updateConfigFile(path, (disk) => {
      disk.after = true;
    }, { staleMs: 1_000, timeoutMs: 1_000 });
    assert.deepEqual(readConfigFile(path), { after: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a writer waits for a live lock held by another process instead of writing under it", async () => {
  const { dir, path } = tempConfig();
  try {
    const locked = waitForLine("locked");
    const holder = runWorker(HOLDER_SOURCE, { CFL_PATH: path, CFL_HOLD_MS: "400" }, locked.onLine);
    await locked.seen;
    // The peer holds the lock and has not written yet.  Without waiting this
    // update would read {} and its rename would erase the peer's marker.
    const result = updateConfigFile(path, (disk) => {
      disk.waiter = true;
    });
    await holder;
    assert.deepEqual(result, { holder: "worker", waiter: true });
    assert.deepEqual(readConfigFile(path), { holder: "worker", waiter: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a writer gives up with a clear error after timeoutMs while a peer holds the lock", async () => {
  const { dir, path } = tempConfig();
  try {
    const locked = waitForLine("locked");
    const holder = runWorker(HOLDER_SOURCE, { CFL_PATH: path, CFL_HOLD_MS: "700" }, locked.onLine);
    await locked.seen;
    assert.throws(
      () => acquireConfigFileLock(path, { timeoutMs: 100 }),
      /config lock held by pid \d+ for more than 100 ms/,
    );
    await holder;
    assert.deepEqual(readConfigFile(path), { holder: "worker" }, "the holder's write survived");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The regression test for the lost-update race itself.  Two processes hammer
// the same file with read-modify-writes of their own sections.  Without the
// lock, one side's stale snapshot regularly lands on top of the other's
// fresh write and a counter comes up short; with it, both reach N exactly.
test("two processes doing locked read-modify-writes on one file never lose an update", async () => {
  const { dir, path } = tempConfig();
  const N = 40;
  try {
    const env = { CFL_PATH: path, CFL_N: String(N) };
    await Promise.all([
      runWorker(COUNTER_SOURCE, { ...env, CFL_SECTION: "server" }),
      runWorker(COUNTER_SOURCE, { ...env, CFL_SECTION: "electron" }),
    ]);
    const final = readConfigFile(path);
    assert.deepEqual(final, { server: { count: N }, electron: { count: N } });
    assert.equal(existsSync(lockPathFor(path)), false, "no lock left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
