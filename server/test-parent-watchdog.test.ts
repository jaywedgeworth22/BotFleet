// Proves the backstop in server/test-parent-watchdog.ts against the exact
// scenario that orphaned six ~4.4 GB harness processes (parent pid 1, 0%
// CPU) on 2026-09-12: a parent that is SIGKILLed outright, with nobody left
// to signal the child it spawned.
//
// This does not boot the real harness — that would just re-run
// index.test.ts's own boot path under a second layer of process management,
// slowly. Instead it runs the watchdog module itself, for real, across a
// real three-process chain: this test spawns a stand-in "vitest worker"
// (via spawnDetached, the same helper every harness-spawning suite now
// uses) which spawns a stand-in "harness" that installs the watchdog and
// spawns its own grandchild. Killing only the stand-in worker — a single,
// un-interceptable SIGKILL, never the group helper this suite uses
// everywhere else — is what "the parent gives up" means in practice; there
// is deliberately no group signal reaching the stand-in harness at all.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { spawnDetached } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const WATCHDOG_MODULE = join(SERVER_DIR, "test-parent-watchdog.ts");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Stands in for the real harness: installs the exact watchdog server/index.ts
// wires up, at a short interval so the test does not sit around waiting for
// the production 2 s cadence. On "orphaned," it kills its own process group —
// the same shape of action index.ts takes by re-sending itself SIGTERM,
// simplified here to a direct group kill since there is no graceful-shutdown
// path to reuse in a two-line fixture.
const FIXTURE_CHILD_SOURCE = `
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const { installTestParentWatchdog } = await import(pathToFileURL(process.argv[2]).href);

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));

const parentPidAtBoot = Number(process.env.BOTFLEET_TEST_PARENT_PID);
installTestParentWatchdog(parentPidAtBoot, () => {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.exit(1);
  }
}, 200);

setInterval(() => {}, 1000);
`;

// Stands in for the vitest worker: spawns the fixture "harness" detached
// (its own process group, separate from this stand-in's own — mirroring
// spawnDetached exactly) and records its own pid as the parent the fixture
// should watch, then relays the fixture's one stdout line back up so the
// real test can read it.
const FAKE_PARENT_SOURCE = `
import { spawn } from "node:child_process";

const child = spawn(process.execPath, [process.argv[2], process.argv[3]], {
  detached: true,
  stdio: ["ignore", "pipe", "ignore"],
  env: { ...process.env, BOTFLEET_TEST_PARENT_PID: String(process.pid) },
});
child.stdout.pipe(process.stdout);

setInterval(() => {}, 1000);
`;

describe("installTestParentWatchdog", () => {
  it("takes its whole process group down when its recorded parent is gone, even though nothing signalled it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "botfleet-watchdog-test-"));
    const fixtureChildPath = join(dir, "fixture-child.mjs");
    const fakeParentPath = join(dir, "fake-parent.mjs");
    writeFileSync(fixtureChildPath, FIXTURE_CHILD_SOURCE);
    writeFileSync(fakeParentPath, FAKE_PARENT_SOURCE);

    const fakeParent = spawnDetached(process.execPath, [fakeParentPath, fixtureChildPath, WATCHDOG_MODULE], {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "ignore"],
    });

    let child = 0;
    let grandchild = 0;
    try {
      const line = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("fixture never reported its pids")), 10_000);
        let buf = "";
        fakeParent.stdout!.on("data", (chunk) => {
          buf += String(chunk);
          const newline = buf.indexOf("\n");
          if (newline !== -1) {
            clearTimeout(timer);
            resolve(buf.slice(0, newline));
          }
        });
      });
      ({ child, grandchild } = JSON.parse(line) as { child: number; grandchild: number });
      expect(alive(child)).toBe(true);
      expect(alive(grandchild)).toBe(true);

      // "The parent gives up": one un-interceptable SIGKILL on the stand-in
      // worker's own pid, nothing more — exactly what an OS-level SIGKILL of
      // a real vitest worker looks like from the outside, and exactly the
      // one thing a signal-based cleanup (afterAll, the exit guard, a group
      // kill aimed at the wrong pid) can never react to.
      expect(fakeParent.pid).toBeDefined();
      process.kill(fakeParent.pid!, "SIGKILL");

      const deadline = Date.now() + 10_000;
      while ((alive(child) || alive(grandchild)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(alive(child)).toBe(false);
      expect(alive(grandchild)).toBe(false);
      // Not just "no live members I happened to check" — signalling the
      // group at all must now fail.
      expect(() => process.kill(-child, 0)).toThrow();
    } finally {
      if (child && alive(child)) {
        try {
          process.kill(-child, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      if (grandchild && alive(grandchild)) {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      if (fakeParent.pid && alive(fakeParent.pid)) {
        try {
          process.kill(fakeParent.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
