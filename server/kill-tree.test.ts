// The drivers spawn their CLI detached so that stopping a turn also stops
// whatever the CLI started (its MCP servers). That guarantee is the whole
// contract of killCliTree, so it is what gets tested: a grandchild must not
// survive the kill on either platform.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { killCliTree, killCliTreeHard, spawnCli } from "./procs.ts";

// execFile is only intercepted for the Windows describe below; every other
// call passes straight through, so the POSIX trees are still real processes.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((...args: Parameters<typeof actual.execFile>) => (actual.execFile as (...a: unknown[]) => unknown)(...args)),
  };
});

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
/** A leader that spawns `grandchildScript`, runs `afterSpawn` once the
 *  grandchild says ready, and only then reports the grandchild's pid: the
 *  test's kill follows the pid, so whatever `afterSpawn` installs (a SIGTERM
 *  handler) is in place before the signal can land. */
function spawnLeader(grandchildScript: string, afterSpawn: string) {
  return spawn(
    process.execPath,
    [
      "-e",
      `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: ["ignore", "pipe", "ignore"] });` +
        // the leading newline keeps the pid on its own line after anything
        // afterSpawn wrote (STUBBORN's "ready" has no newline of its own)
        `c.stdout.once("data", () => { ${afterSpawn}; console.log("\\n" + c.pid); });`,
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

// Windows has no process groups; the hard kill goes through `taskkill /T /F`.
// The platform is stubbed and taskkill intercepted, so this runs everywhere
// and covers the crashed-leader case that a real win32 CI would otherwise
// be the only place to catch.
describe("killCliTreeHard on Windows", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const taskkill = vi.mocked(execFile);
  type TaskkillCallback = (err: Error | null, stdout: string, stderr: string) => void;
  const fakeChild = (exited: boolean) =>
    ({ pid: 4242, exitCode: exited ? 1 : null, signalCode: null, kill: vi.fn(() => true) }) as unknown as ChildProcess & {
      kill: ReturnType<typeof vi.fn>;
    };
  const taskkillArgs = () => taskkill.mock.calls.map((c) => [c[0], c[1]]);

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    taskkill.mockClear();
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
  });

  it("still runs taskkill /T after the leader exited, where the plain kill gives up", () => {
    // A crashed claude.exe leaves its MCP proxies behind just as on POSIX;
    // only the tree walk can reach them once the leader's pid is dead.
    const child = fakeChild(true);
    taskkill.mockImplementationOnce(((_cmd: string, _args: string[], _opts: unknown, cb: TaskkillCallback) => {
      cb(Object.assign(new Error("not found"), { code: 128 }), "", 'ERROR: The process "4242" not found.');
      return undefined as never;
    }) as never);

    killCliTree(child);
    expect(taskkillArgs()).toEqual([]);

    killCliTreeHard(child);
    expect(taskkillArgs()).toEqual([["taskkill", ["/PID", "4242", "/T", "/F"]]]);
    // "not found" means the tree is gone; nothing is left to fall back on
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to killing a live leader when taskkill itself fails", () => {
    const child = fakeChild(false);
    taskkill.mockImplementationOnce(((_cmd: string, _args: string[], _opts: unknown, cb: TaskkillCallback) => {
      cb(Object.assign(new Error("spawn taskkill ENOENT"), { code: "ENOENT" }), "", "");
      return undefined as never;
    }) as never);

    killCliTreeHard(child);
    expect(taskkillArgs()).toEqual([["taskkill", ["/PID", "4242", "/T", "/F"]]]);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
