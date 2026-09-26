// The drivers spawn their CLI detached so that stopping a turn also stops
// whatever the CLI started (its MCP servers). That guarantee is the whole
// contract of killCliTree, so it is what gets tested: a grandchild must not
// survive the kill on either platform.
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { killCliTree, killCliTreeHard, spawnCli } from "./procs.ts";

const IDLE = "setInterval(() => {}, 1000)";
/** Idles and shrugs off SIGTERM, like an MCP proxy mid-request.  Says
 *  "ready" on stdout once the handler is installed: under a heavy host load
 *  a signal can land before a fresh node has run its first line, and the
 *  default disposition would then end it and prove nothing. */
const STUBBORN = "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("killCliTree", () => {
  it("owns stdin pipe errors before a CLI can be force-stopped", async () => {
    const child = spawnCli(process.execPath, ["-e", IDLE], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);
    } finally {
      killCliTree(child);
      await Promise.race([
        new Promise<void>((resolve) => child.once("close", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  });

  it("reaps a grandchild, not just the process it was handed", async () => {
    // a stand-in CLI: spawns one helper, reports its pid, then idles
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(IDLE)}], { stdio: "ignore" });` +
          `console.log(c.pid); ${IDLE}`,
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
        // Node 26 prints "NO_COLOR is ignored due to FORCE_COLOR" on stdout
        // when both are set, which used to make Number(first-chunk) NaN.
        env: (() => {
          const env = { ...process.env };
          delete env.FORCE_COLOR;
          delete env.NO_COLOR;
          return env;
        })(),
      },
    );
    let grandchild = 0;
    try {
      grandchild = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("helper did not report its pid")), 5_000);
        let buf = "";
        parent.stdout!.on("data", (chunk) => {
          buf += String(chunk);
          for (const line of buf.split(/\r?\n/)) {
            const pid = Number(line.trim());
            if (Number.isInteger(pid) && pid > 0) {
              clearTimeout(timer);
              resolve(pid);
              return;
            }
          }
        });
      });
      expect(grandchild).toBeGreaterThan(0);
      expect(alive(grandchild)).toBe(true);

      killCliTree(parent);

      // Read the parent's death off the child object: a POSIX parent stays a
      // live pid as a zombie until Node reaps it. The grandchild has no Child
      // object here, so wait until its pid disappears as the observable proof.
      const exited = () => parent.exitCode !== null || parent.signalCode !== null;
      const deadline = Date.now() + 10_000;
      while ((alive(grandchild) || !exited()) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(alive(grandchild)).toBe(false);
      expect(exited()).toBe(true);
    } finally {
      killCliTree(parent);
      if (grandchild && alive(grandchild)) {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }, 20_000);
});

const spawnEnv = () => {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
};

/** Spawns a detached group leader that starts `grandchildScript`, prints
 *  the grandchild's pid once it has said "ready", then runs `afterSpawn`. */
function spawnLeader(grandchildScript: string, afterSpawn: string) {
  return spawn(
    process.execPath,
    [
      "-e",
      `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: ["ignore", "pipe", "ignore"] });` +
        `c.stdout.once("data", () => { console.log(c.pid); ${afterSpawn} });`,
    ],
    { stdio: ["ignore", "pipe", "ignore"], detached: true, env: spawnEnv() },
  );
}

function readPid(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    // two node boots in series; a saturated host can take seconds for each
    const timer = setTimeout(() => reject(new Error("helper did not report its pid")), 15_000);
    let buf = "";
    child.stdout!.on("data", (chunk) => {
      buf += String(chunk);
      for (const line of buf.split(/\r?\n/)) {
        const pid = Number(line.trim());
        if (Number.isInteger(pid) && pid > 0) {
          clearTimeout(timer);
          resolve(pid);
          return;
        }
      }
    });
  });
}

async function waitUntil(condition: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const reap = (pid: number) => {
  if (pid && alive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
};

describe.skipIf(process.platform === "win32")("killCliTreeHard", () => {
  it("still reaches the group after the leader exited, escalating to SIGKILL", async () => {
    // A crashed claude/codex leaves its MCP proxies alive in the group it
    // led; the plain kill sees exitCode set and walks past them.
    const leader = spawnLeader(STUBBORN, "setTimeout(() => process.exit(0), 50)");
    let grandchild = 0;
    try {
      grandchild = await readPid(leader);
      await waitUntil(() => leader.exitCode !== null, 5_000);
      expect(leader.exitCode).toBe(0);
      expect(alive(grandchild)).toBe(true);

      killCliTree(leader); // the plain kill is a no-op once the leader is gone
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(alive(grandchild)).toBe(true);

      killCliTreeHard(leader, 100);
      await waitUntil(() => !alive(grandchild), 5_000);
      expect(alive(grandchild)).toBe(false);
    } finally {
      killCliTreeHard(leader, 0);
      reap(grandchild);
    }
  }, 30_000);

  it("SIGKILLs a tree that ignores SIGTERM once the grace period passes", async () => {
    const leader = spawnLeader(STUBBORN, STUBBORN);
    const leaderPid = leader.pid!;
    let grandchild = 0;
    try {
      grandchild = await readPid(leader);
      killCliTreeHard(leader, 100);
      // neither the leader nor the grandchild honours SIGTERM
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(alive(grandchild)).toBe(true);
      const exited = () => leader.exitCode !== null || leader.signalCode !== null;
      await waitUntil(() => !alive(grandchild) && exited(), 5_000);
      expect(alive(grandchild)).toBe(false);
      expect(leader.signalCode).toBe("SIGKILL");
    } finally {
      reap(leaderPid);
      reap(grandchild);
    }
  }, 30_000);
});
