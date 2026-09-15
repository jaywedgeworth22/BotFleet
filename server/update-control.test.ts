// The four things that decide whether "install the update" is safe: the
// status shape both clients render, the refusals, what the launcher actually
// runs, and the reconcile that lets a run survive the restart it performs.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  availableIsStale,
  BUSY_REFUSAL,
  createUpdateControl,
  launchdJobIsAlive,
  launchPlanCommand,
  parseProgressRecord,
  runRefusal,
  stepLabel,
  type CommandResult,
  type LaunchPlan,
  type RuntimeReadiness,
  type UpdateControl,
  type UpdateStatus,
} from "./update-control.ts";

const INSTALLED_COMMIT = "a".repeat(40);
const NEW_COMMIT = "b".repeat(40);
const UNIT = "\u001f";

const roots: string[] = [];
const controls: UpdateControl[] = [];

afterEach(() => {
  for (const control of controls.splice(0)) control.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temp Mac: an always-on checkout with a `.git`, an updater script, and an
 * empty state directory. */
function rig() {
  const root = mkdtempSync(join(tmpdir(), "bf-update-control-"));
  roots.push(root);
  const checkout = join(root, "checkout");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  const scriptPath = join(root, "update-botfleet.sh");
  writeFileSync(scriptPath, "#!/bin/bash\n", { mode: 0o700 });
  return { root, checkout, scriptPath, stateDirectory: join(root, "state") };
}

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const fail = (): CommandResult => ({ code: 1, stdout: "", stderr: "boom" });

interface Harness {
  control: UpdateControl;
  launched: LaunchPlan[];
  emitted: UpdateStatus[];
  git: string[][];
}

function build(
  paths: ReturnType<typeof rig>,
  options: {
    platform?: string;
    git?: (args: string[]) => CommandResult;
    processAlive?: (pid: number) => boolean;
    updaterReportsProgress?: boolean;
    readiness?: RuntimeReadiness;
    launchDelay?: () => Promise<void>;
    installedAt?: string;
    writeState?: (path: string, value: unknown) => void;
    now?: () => Date;
    installedCommit?: string;
  } = {},
): Harness {
  const launched: LaunchPlan[] = [];
  const emitted: UpdateStatus[] = [];
  const git: string[][] = [];
  const control = createUpdateControl({
    installed: {
      version: "1.0.30",
      sourceCommit: options.installedCommit ?? INSTALLED_COMMIT,
      ...(options.installedAt ? { installedAt: options.installedAt } : {}),
    },
    checkout: paths.checkout,
    stateDirectory: paths.stateDirectory,
    scriptPath: paths.scriptPath,
    platform: options.platform ?? "darwin",
    nodeDirectory: "/opt/homebrew/bin",
    now: options.now ?? (() => new Date("2026-09-13T12:00:00.000Z")),
    git: async (args) => {
      git.push(args);
      return options.git ? options.git(args) : ok();
    },
    launch: async (plan) => {
      if (options.launchDelay) await options.launchDelay();
      launched.push(plan);
      return { launcher: "launchd" };
    },
    readiness: () => options.readiness ?? { safeToRestart: true, activeWorkCount: 0 },
    ...(options.writeState ? { writeState: options.writeState } : {}),
    processAlive: options.processAlive ?? (() => true),
    updaterReportsProgress: () => options.updaterReportsProgress ?? true,
    newRunId: () => "run_one",
    emit: (status) => emitted.push(status),
    pollIntervalMs: 50,
  });
  controls.push(control);
  return { control, launched, emitted, git };
}

/** One run's progress file, as `scripts/update-progress.mjs` writes it. */
function writeProgress(paths: ReturnType<typeof rig>, runId: string, patch: Record<string, unknown>) {
  const file = join(paths.stateDirectory, "runs", `${runId}.progress.json`);
  mkdirSync(join(paths.stateDirectory, "runs"), { recursive: true });
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    runId,
    command: "update",
    pid: 4321,
    startedAt: "2026-09-13T11:55:00.000Z",
    updatedAt: "2026-09-13T11:58:00.000Z",
    step: null,
    progress: null,
    targetCommit: NEW_COMMIT,
    receiptPath: null,
    finishedAt: null,
    outcome: null,
    message: null,
    ...patch,
  }));
  return file;
}

function writeCurrentRun(paths: ReturnType<typeof rig>, runId: string) {
  mkdirSync(paths.stateDirectory, { recursive: true });
  writeFileSync(join(paths.stateDirectory, "current-run.json"), JSON.stringify({
    runId,
    startedAt: "2026-09-13T11:55:00.000Z",
    progressPath: join(paths.stateDirectory, "runs", `${runId}.progress.json`),
    logPath: join(paths.stateDirectory, "runs", `${runId}.log`),
    launcher: "launchd",
    targetCommit: NEW_COMMIT,
  }));
}

describe("status", () => {
  it("describes a Mac that has never checked", () => {
    const paths = rig();
    const status = build(paths).control.status();
    expect(status).toMatchObject({
      installed: { version: "1.0.30", sourceCommit: INSTALLED_COMMIT },
      available: null,
      checkedAt: null,
      checkError: null,
      running: null,
      lastRun: null,
      capabilities: { canCheck: true, canRun: true, reasons: [] },
    });
  });

  it("says why it cannot, one reason at a time", () => {
    const paths = rig();
    expect(build(paths, { platform: "win32" }).control.status().capabilities).toEqual({
      canCheck: false,
      canRun: false,
      reasons: ["Updating from this computer is macOS only."],
    });

    const noCheckout = rig();
    rmSync(join(noCheckout.checkout, ".git"), { recursive: true, force: true });
    const capabilities = build(noCheckout).control.status().capabilities;
    expect(capabilities.canCheck).toBe(false);
    expect(capabilities.reasons[0]).toContain(noCheckout.checkout);

    const stale = build(rig(), { updaterReportsProgress: false }).control.status().capabilities;
    expect(stale).toMatchObject({ canCheck: true, canRun: false });
    expect(stale.reasons[0]).toContain("predates this build");

    const noScript = rig();
    rmSync(noScript.scriptPath, { force: true });
    const script = build(noScript).control.status().capabilities;
    expect(script).toMatchObject({ canCheck: true, canRun: false });
    expect(script.reasons[0]).toContain(noScript.scriptPath);
  });
});

describe("check", () => {
  const gitFor = (head: string) => (args: string[]): CommandResult => {
    if (args[0] === "rev-parse") return ok(`${head}\n`);
    if (args[0] === "rev-list") return ok("12\n");
    if (args[0] === "log") {
      return ok([
        `${NEW_COMMIT}${UNIT}feat(engines): room turns on the HTTP lane`,
        `${"c".repeat(40)}${UNIT}fix(usage): dual-window quota display`,
      ].join("\n"));
    }
    if (args[0] === "show") return ok(JSON.stringify({ version: "1.0.31" }));
    return ok();
  };

  it("reports what origin/main is ahead by, with subjects and a version", async () => {
    const paths = rig();
    const harness = build(paths, { git: gitFor(NEW_COMMIT) });
    const status = await harness.control.check();
    expect(harness.git[0]).toEqual(["fetch", "origin", "main"]);
    expect(status.checkedAt).toBe("2026-09-13T12:00:00.000Z");
    expect(status.available).toEqual({
      sourceCommit: NEW_COMMIT,
      version: "1.0.31",
      aheadBy: 12,
      commits: [
        { sha: NEW_COMMIT, subject: "feat(engines): room turns on the HTTP lane" },
        { sha: "c".repeat(40), subject: "fix(usage): dual-window quota display" },
      ],
    });
    // A second control reads the same answer back without a fetch.
    expect(build(paths).control.status().available?.sourceCommit).toBe(NEW_COMMIT);
  });

  it("clears the answer once the installed commit is origin/main", async () => {
    const paths = rig();
    const harness = build(paths, { git: gitFor(NEW_COMMIT) });
    await harness.control.check();
    const caughtUp = build(paths, { git: gitFor(NEW_COMMIT), installedCommit: NEW_COMMIT });
    expect((await caughtUp.control.check()).available).toBeNull();
  });

  it("keeps the previous answer when git cannot resolve origin/main", async () => {
    const paths = rig();
    const harness = build(paths, { git: gitFor(NEW_COMMIT) });
    await harness.control.check();
    const offline = build(paths, { git: () => fail() });
    const status = await offline.control.check();
    expect(status.available?.sourceCommit).toBe(NEW_COMMIT);
    expect(status.checkedAt).toBe("2026-09-13T12:00:00.000Z");
  });
});

describe("refusals", () => {
  const capabilities = { canCheck: true, canRun: true, reasons: [] };
  const available = { sourceCommit: NEW_COMMIT, aheadBy: 3, commits: [] };
  const running = { runId: "run_one", startedAt: "", step: "Building", logTail: [] };
  const idle: RuntimeReadiness = { safeToRestart: true, activeWorkCount: 0 };
  const busy: RuntimeReadiness = { safeToRestart: false, activeWorkCount: 2 };
  const ask = (patch: Partial<Parameters<typeof runRefusal>[0]>) => runRefusal({
    capabilities,
    running: null,
    available,
    readiness: idle,
    dirty: false,
    force: false,
    ...patch,
  });

  it("names the one blocking reason", () => {
    expect(ask({ running })).toBe("An update is already running.");
    expect(ask({
      capabilities: { canCheck: false, canRun: false, reasons: ["Updating from this computer is macOS only."] },
    })).toBe("Updating from this computer is macOS only.");
    expect(ask({ dirty: true })).toContain("uncommitted changes");
    expect(ask({ available: null })).toBe("BotFleet is already on the newest build.");
    expect(ask({ available: null, force: true })).toBeNull();
    expect(ask({})).toBeNull();
  });

  it("will not re-offer the build that is already installed", () => {
    expect(ask({ available: null })).toBe("BotFleet is already on the newest build.");
    expect(ask({ available: null, force: true })).toBeNull();
  });

  it("calls an answer stale when it cannot describe anything newer", () => {
    const at = (iso: string) => iso;
    const answer = { sourceCommit: NEW_COMMIT, aheadBy: 3, commits: [] };
    const base = {
      available: answer,
      installedCommit: INSTALLED_COMMIT,
      checkedAt: at("2026-09-13T12:00:00.000Z"),
    };
    expect(availableIsStale(base)).toBe(false);
    expect(availableIsStale({ ...base, available: null })).toBe(true);
    // Names the commit now installed: this process IS the result.
    expect(availableIsStale({ ...base, installedCommit: NEW_COMMIT })).toBe(true);
    // Recorded before this build was installed, so it cannot describe
    // anything newer than it — the X-then-Y case, where check() saw X,
    // origin/main moved to Y, and Y is what got installed.
    expect(availableIsStale({ ...base, installedAt: at("2026-09-13T12:30:00.000Z") })).toBe(true);
    expect(availableIsStale({ ...base, installedAt: at("2026-09-13T11:30:00.000Z") })).toBe(false);
    // A source build has no installedAt; a VERIFIED run's finish is the same line.
    expect(availableIsStale({ ...base, verifiedRunFinishedAt: at("2026-09-13T12:30:00.000Z") })).toBe(true);
    // An answer with no usable timestamp cannot be placed, so it is not acted on.
    expect(availableIsStale({ ...base, checkedAt: null })).toBe(true);
    expect(availableIsStale({ ...base, checkedAt: "not a date" })).toBe(true);
  });

  it("will not interrupt a turn, and force is the one thing that talks past it", () => {
    expect(ask({ readiness: busy })).toBe(BUSY_REFUSAL);
    expect(ask({ readiness: busy, force: true })).toBeNull();
    // Busy closes canRun too, and forcing past busy must not then trip over
    // the reason busy itself put in the list.
    expect(ask({
      readiness: busy,
      capabilities: { canCheck: true, canRun: false, reasons: [BUSY_REFUSAL] },
      force: true,
    })).toBeNull();
    // A structural reason still wins, forced or not.
    expect(ask({
      readiness: busy,
      capabilities: { canCheck: true, canRun: false, reasons: [BUSY_REFUSAL, "The updater is not installed."] },
      force: true,
    })).toBe("The updater is not installed.");
  });

  it("refuses to launch with nothing to install, and force overrides it", async () => {
    const paths = rig();
    const harness = build(paths);
    const refused = await harness.control.start();
    expect(refused).toMatchObject({ ok: false, error: "BotFleet is already on the newest build." });
    expect(harness.launched).toHaveLength(0);

    const forced = await harness.control.start({ force: true });
    expect(forced.ok).toBe(true);
    expect(harness.launched).toHaveLength(1);
  });

  it("refuses while the always-on checkout is dirty", async () => {
    const paths = rig();
    const harness = build(paths, {
      git: (args) => (args[0] === "status" ? ok(" M electron/vendor/electron-updater.cjs\n") : ok()),
    });
    const refused = await harness.control.start({ force: true });
    expect(refused.ok).toBe(false);
    expect(harness.launched).toHaveLength(0);
  });

  it("refuses while a turn is in flight, and says so in the capabilities", async () => {
    const paths = rig();
    const harness = build(paths, { readiness: { safeToRestart: false, activeWorkCount: 3 } });
    const status = harness.control.status();
    expect(status.capabilities.canRun).toBe(false);
    expect(status.capabilities.reasons).toContain(BUSY_REFUSAL);
    expect(status.capabilities.canCheck).toBe(true);
    const refused = await harness.control.start({ force: true });
    // force is allowed past readiness; the refusal here is only that there is
    // nothing newer, which proves readiness was not the blocker.
    expect(refused.ok).toBe(true);

    const blocked = build(rig(), { readiness: { safeToRestart: false, activeWorkCount: 3 } });
    expect(await blocked.control.start()).toMatchObject({ ok: false, error: BUSY_REFUSAL });
    expect(blocked.launched).toHaveLength(0);
  });

  it("takes the caller's readiness over its own when one is given", async () => {
    const paths = rig();
    // The route excludes the admission it holds itself; without that override
    // every run would see its own request as work it must not interrupt.
    const harness = build(paths, { readiness: { safeToRestart: false, activeWorkCount: 1 } });
    const started = await harness.control.start({
      force: true,
      readiness: { safeToRestart: true, activeWorkCount: 0 },
    });
    expect(started.ok).toBe(true);
    expect(harness.launched).toHaveLength(1);
  });

  it("checks the checkout even on a busy machine a caller is forcing past", async () => {
    // `force` talks past readiness, which used to skip the dirty precheck
    // with it — so a forced run on a dirty checkout launched a whole
    // transaction for the updater to refuse a minute later.
    const paths = rig();
    const harness = build(paths, {
      readiness: { safeToRestart: false, activeWorkCount: 2 },
      git: (args) => (args[0] === "status" ? ok(" M electron/vendor/electron-updater.cjs\n") : ok()),
    });
    const refused = await harness.control.start({ force: true });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain("uncommitted changes");
    expect(harness.launched).toHaveLength(0);
  });

  it("refuses a second run while one is in flight", async () => {
    const paths = rig();
    const harness = build(paths);
    expect((await harness.control.start({ force: true })).ok).toBe(true);
    writeProgress(paths, "run_one", { step: "buildBundle", progress: 0.25 });
    const second = await harness.control.start({ force: true });
    expect(second).toMatchObject({ ok: false, error: "An update is already running." });
    expect(harness.launched).toHaveLength(1);
  });
});

describe("checking when the fetch does not work", () => {
  it("reports the failure instead of reading a stale origin/main as up to date", async () => {
    const paths = rig();
    // Offline: `git fetch` fails, but `origin/main` is still on disk from the
    // last time it worked — and it happens to equal what is installed.
    const harness = build(paths, {
      git: (args) => {
        if (args[0] === "fetch") return { code: 1, stdout: "", stderr: "fatal: unable to access 'https://…': could not resolve host\n" };
        if (args[0] === "rev-parse") return ok(`${INSTALLED_COMMIT}\n`);
        return ok();
      },
    });
    const status = await harness.control.check();
    expect(status.checkedAt).toBeNull();
    expect(status.checkError).toContain("Could not reach the update source.");
    expect(status.checkError).toContain("could not resolve host");
    expect(status.available).toBeNull();
  });

  it("keeps the previous answer, and its timestamp, when a check fails", async () => {
    const paths = rig();
    const online = (args: string[]): CommandResult => {
      if (args[0] === "rev-parse") return ok(`${NEW_COMMIT}\n`);
      if (args[0] === "rev-list") return ok("4\n");
      if (args[0] === "log") return ok(`${NEW_COMMIT}${UNIT}feat: something`);
      if (args[0] === "show") return ok(JSON.stringify({ version: "1.0.31" }));
      return ok();
    };
    let offline = false;
    const harness = build(paths, {
      git: (args) => (offline && args[0] === "fetch" ? fail() : online(args)),
    });
    const good = await harness.control.check();
    expect(good.checkedAt).toBe("2026-09-13T12:00:00.000Z");
    expect(good.checkError).toBeNull();
    offline = true;
    const bad = await harness.control.check();
    expect(bad.checkedAt).toBe("2026-09-13T12:00:00.000Z");
    expect(bad.checkError).toContain("Could not reach the update source.");
    expect(bad.available?.sourceCommit).toBe(NEW_COMMIT);
  });

  it("says so when origin/main cannot be resolved even after a good fetch", async () => {
    const paths = rig();
    const harness = build(paths, {
      git: (args) => (args[0] === "rev-parse" ? fail() : ok()),
    });
    const status = await harness.control.check();
    expect(status.checkedAt).toBeNull();
    expect(status.checkError).toContain("Could not read origin/main");
  });

  it("clears the failure once a check works again", async () => {
    const paths = rig();
    let offline = true;
    const harness = build(paths, {
      git: (args) => {
        if (args[0] === "fetch") return offline ? fail() : ok();
        if (args[0] === "rev-parse") return ok(`${INSTALLED_COMMIT}\n`);
        return ok();
      },
    });
    expect((await harness.control.check()).checkError).not.toBeNull();
    offline = false;
    const recovered = await harness.control.check();
    expect(recovered.checkError).toBeNull();
    expect(recovered.checkedAt).toBe("2026-09-13T12:00:00.000Z");
  });
});

describe("an unsuccessful run", () => {
  const seedLastRun = (paths: ReturnType<typeof rig>, outcome: string) => {
    mkdirSync(paths.stateDirectory, { recursive: true });
    writeFileSync(join(paths.stateDirectory, "last-run.json"), JSON.stringify({
      runId: "run_prior",
      startedAt: "2026-09-13T12:20:00.000Z",
      finishedAt: "2026-09-13T12:30:00.000Z",
      outcome,
      message: "whatever happened",
    }));
    writeFileSync(join(paths.stateDirectory, "available.json"), JSON.stringify({
      checkedAt: "2026-09-13T12:00:00.000Z",
      available: { sourceCommit: NEW_COMMIT, version: "1.0.31", aheadBy: 4, commits: [] },
    }));
  };

  it("leaves the available answer alone — it installed nothing", () => {
    // Refused, failed and rolled-back runs all have a finishedAt, and none of
    // them changed what is installed.  Treating them as the staleness
    // boundary threw away a good answer every time a run was declined.
    for (const outcome of ["refused", "failed", "rolled-back"]) {
      const paths = rig();
      seedLastRun(paths, outcome);
      const status = build(paths).control.status();
      expect(status.lastRun?.outcome, outcome).toBe(outcome);
      expect(status.available?.sourceCommit, outcome).toBe(NEW_COMMIT);
    }
  });

  it("but a verified one does move the line", () => {
    const paths = rig();
    seedLastRun(paths, "verified");
    const status = build(paths).control.status();
    expect(status.available).toBeNull();
  });
});

describe("the launcher", () => {
  it("submits a one-shot launchd job that outlives both parents", () => {
    const { command, args } = launchPlanCommand({
      runId: "run_one",
      progressPath: "/tmp/state/runs/run_one.progress.json",
      logPath: "/tmp/state/runs/run_one.log",
      scriptPath: "/Users/jay/apps/update-botfleet.sh",
      label: "com.jay.botfleet-update",
      nodeDirectory: "/opt/homebrew/bin",
    });
    expect(command).toBe("/bin/launchctl");
    expect(args.slice(0, 8)).toEqual([
      "submit",
      "-l",
      "com.jay.botfleet-update",
      "-o",
      "/tmp/state/runs/run_one.log",
      "-e",
      "/tmp/state/runs/run_one.log",
      "--",
    ]);
    expect(args[8]).toBe("/bin/bash");
    expect(args[9]).toBe("-c");
    // launchd hands a job the system PATH, which has no Homebrew on it.
    expect(args[10]).toContain("export PATH='/opt/homebrew/bin'");
    expect(args[10]).toContain("--progress '/tmp/state/runs/run_one.progress.json'");
    expect(args[10]).toContain("--run-id 'run_one'");
  });

  it("records the run before launching it, and launches nothing it cannot record", async () => {
    const paths = rig();
    const order: string[] = [];
    const harness = build(paths, {
      writeState: (path, value) => {
        order.push(`write:${path.endsWith("current-run.json") ? "current-run" : "other"}`);
        mkdirSync(join(paths.stateDirectory, "runs"), { recursive: true });
        writeFileSync(path, JSON.stringify(value));
      },
      launchDelay: async () => void order.push("launch"),
    });
    expect((await harness.control.start({ force: true })).ok).toBe(true);
    // Written afterwards, a failed write left a real updater running that no
    // harness knew about.
    expect(order.indexOf("write:current-run")).toBeLessThan(order.indexOf("launch"));

    const refusing = build(rig(), {
      writeState: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    const blocked = await refusing.control.start({ force: true });
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.error).toContain("could not be recorded");
    expect(refusing.launched).toHaveLength(0);
  });

  it("does not leave a record behind when the launch itself fails", async () => {
    const paths = rig();
    const harness = build(paths, {
      launchDelay: async () => {
        throw new Error("A com.jay.botfleet-update job is already running on this Mac.");
      },
    });
    const failed = await harness.control.start({ force: true });
    expect(failed.ok).toBe(false);
    expect(failed.ok === false && failed.error).toContain("could not be started");
    expect(harness.control.status().running).toBeNull();
    expect(existsSync(join(paths.stateDirectory, "current-run.json"))).toBe(false);
    // And a later harness does not find a phantom run either.
    expect(build(paths).control.status().running).toBeNull();
  });

  it("starts exactly one job when two callers race", async () => {
    const paths = rig();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = build(paths, { launchDelay: () => gate });
    // Both land before either has written current-run.json.  Without a
    // synchronous guard both would launch, and the second submit's
    // `launchctl remove` would SIGTERM the first mid-install.
    const first = harness.control.start({ force: true });
    const second = await harness.control.start({ force: true });
    expect(second).toMatchObject({ ok: false, error: "An update is already running." });
    release!();
    expect((await first).ok).toBe(true);
    expect(harness.launched).toHaveLength(1);
  });

  it("reads a live launchd job as alive, and a merely registered one as not", () => {
    const listed = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });
    expect(launchdJobIsAlive(listed('{\n\t"PID" = 4321;\n\t"Label" = "com.jay.botfleet-update";\n};'))).toBe(true);
    // Registered, already exited — safe to clear before the next submit.
    expect(launchdJobIsAlive(listed('{\n\t"LastExitStatus" = 0;\n\t"Label" = "com.jay.botfleet-update";\n};')))
      .toBe(false);
    // No such label at all.
    expect(launchdJobIsAlive(listed("Could not find service\n", 113))).toBe(false);
  });

  it("hands the run its own progress file and log, and remembers it", async () => {
    const paths = rig();
    const harness = build(paths);
    const started = await harness.control.start({ force: true });
    expect(started.ok && started.runId).toBe("run_one");
    expect(harness.launched[0]).toMatchObject({
      runId: "run_one",
      scriptPath: paths.scriptPath,
      label: "com.jay.botfleet-update",
    });
    // A fresh control — a restarted harness — still sees the run.
    const reborn = build(paths);
    expect(reborn.control.status().running?.runId).toBe("run_one");
  });
});

describe("reconcile on boot", () => {
  it("describes a run started before this process existed", () => {
    const paths = rig();
    writeCurrentRun(paths, "run_prior");
    writeProgress(paths, "run_prior", { step: "startHarness", progress: 0.8 });
    writeFileSync(join(paths.stateDirectory, "runs", "run_prior.log"), "Prepared bbbbbbbbbbbb\nstarting harness\n");
    const status = build(paths).control.status();
    expect(status.running).toMatchObject({
      runId: "run_prior",
      step: "Starting the harness",
      progress: 0.8,
    });
    expect(status.running?.logTail).toEqual(["Prepared bbbbbbbbbbbb", "starting harness"]);
    // A run in flight closes the door on a second one.
    expect(status.capabilities.canRun).toBe(false);
  });

  /** A state directory carrying an answer this process must drop — the case
   * that used to write during construction. */
  function seedStaleAnswer(paths: ReturnType<typeof rig>) {
    mkdirSync(paths.stateDirectory, { recursive: true });
    writeFileSync(join(paths.stateDirectory, "available.json"), JSON.stringify({
      checkedAt: "2026-09-13T11:00:00.000Z",
      available: { sourceCommit: INSTALLED_COMMIT, version: "1.0.30", aheadBy: 1, commits: [] },
    }));
  }

  async function expectSurvivesUnwritableState(harness: Harness, paths: ReturnType<typeof rig>) {
    const status = harness.control.status();
    expect(status.available).toBeNull();
    expect(status.installed.version).toBe("1.0.30");
    expect(status.capabilities.canRun).toBe(true);
    // A run still refuses for the right reason rather than throwing.
    expect(await harness.control.start()).toMatchObject({
      ok: false,
      error: "BotFleet is already on the newest build.",
    });
    // The write really did fail — the stale answer is still on disk.
    const onDisk = JSON.parse(readFileSync(join(paths.stateDirectory, "available.json"), "utf8"));
    expect(onDisk.available?.sourceCommit).toBe(INSTALLED_COMMIT);
  }

  it("still boots and answers when a state write throws", async () => {
    // `createUpdateControl` runs at module scope in server/index.ts, so a
    // throw on this path is a harness that does not start.  The failure is
    // injected rather than arranged with directory permissions: what matters
    // is that a throwing write is survived, and `chmod 0o500` does not deny
    // a directory write on Windows at all.
    const paths = rig();
    seedStaleAnswer(paths);
    const warnings: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      const harness = build(paths, {
        writeState: () => {
          throw Object.assign(new Error("EACCES: permission denied, open 'available.json'"), { code: "EACCES" });
        },
      });
      await expectSurvivesUnwritableState(harness, paths);
      expect(warnings.length).toBeGreaterThan(0);
    } finally {
      console.warn = warn;
    }
  });

  // The same property against the real filesystem, where permissions mean
  // what this asks of them.  Windows ignores the mode, and root is not
  // denied by it either.
  const permissionsApply = process.platform !== "win32" && process.getuid?.() !== 0;
  it.skipIf(!permissionsApply)("survives a state directory the OS will not let it write", async () => {
    const paths = rig();
    seedStaleAnswer(paths);
    const warn = console.warn;
    console.warn = () => {};
    chmodSync(paths.stateDirectory, 0o500);
    try {
      await expectSurvivesUnwritableState(build(paths), paths);
    } finally {
      console.warn = warn;
      chmodSync(paths.stateDirectory, 0o700);
    }
  });

  it("refuses to start a run it would not be able to describe", async () => {
    // The runs directory is the one write that IS load-bearing: with nowhere
    // to put the progress file the run would be one nothing could report on,
    // which is the failure this whole module exists to prevent.  A plain file
    // where the state directory should be denies the mkdir on every platform.
    const base = rig();
    const blocker = join(base.root, "blocked");
    writeFileSync(blocker, "not a directory");
    const harness = build({ ...base, stateDirectory: blocker });
    const started = await harness.control.start({ force: true });
    expect(started.ok).toBe(false);
    expect(started.ok === false && started.error).toContain("could not be recorded");
    expect(harness.launched).toHaveLength(0);
  });

  it("drops an available answer that names the commit now installed", async () => {
    const paths = rig();
    const gitFor = (args: string[]): CommandResult => {
      if (args[0] === "rev-parse") return ok(`${NEW_COMMIT}\n`);
      if (args[0] === "rev-list") return ok("4\n");
      if (args[0] === "log") return ok(`${NEW_COMMIT}${UNIT}feat: something`);
      if (args[0] === "show") return ok(JSON.stringify({ version: "1.0.31" }));
      return ok();
    };
    const before = build(paths, { git: gitFor });
    expect(before.control.status().available).toBeNull();
    expect((await before.control.check()).available?.sourceCommit).toBe(NEW_COMMIT);

    // Now the harness restarts, running the build that was on offer.
    const after = build(paths, { git: gitFor, installedCommit: NEW_COMMIT });
    expect(after.control.status().available).toBeNull();
    // And the invalidation reaches disk, so the next boot never sees it.
    const third = build(paths, { git: gitFor, installedCommit: NEW_COMMIT });
    expect(third.control.status().available).toBeNull();
    // Install must not start a whole transaction to arrive where it is.
    expect(await after.control.start()).toMatchObject({
      ok: false,
      error: "BotFleet is already on the newest build.",
    });
    expect(after.launched).toHaveLength(0);
  });

  it("drops an answer recorded before the build that is now installed", async () => {
    // check() records X.  origin/main moves on to Y.  The install that runs
    // takes Y, and X is now BEHIND us — a different commit from the installed
    // one, and still nothing to install.
    const paths = rig();
    const OLDER = "d".repeat(40);
    const gitForX = (args: string[]): CommandResult => {
      if (args[0] === "rev-parse") return ok(`${OLDER}\n`);
      if (args[0] === "rev-list") return ok("2\n");
      if (args[0] === "log") return ok(`${OLDER}${UNIT}feat: x`);
      if (args[0] === "show") return ok(JSON.stringify({ version: "1.0.31" }));
      return ok();
    };
    const early = build(paths, {
      git: gitForX,
      now: () => new Date("2026-09-13T12:00:00.000Z"),
    });
    expect((await early.control.check()).available?.sourceCommit).toBe(OLDER);

    // The harness comes back as Y, installed after that answer was recorded.
    const gitCalls: string[][] = [];
    const later = build(paths, {
      installedCommit: NEW_COMMIT,
      installedAt: "2026-09-13T12:30:00.000Z",
      git: (args) => {
        gitCalls.push(args);
        return args[0] === "merge-base" ? ok() : gitForX(args);
      },
    });
    expect(later.control.status().available).toBeNull();
    expect(await later.control.start()).toMatchObject({
      ok: false,
      error: "BotFleet is already on the newest build.",
    });
    expect(later.launched).toHaveLength(0);
  });

  it("asks git before launching, and refuses an answer already contained in this build", async () => {
    const paths = rig();
    const OLDER = "d".repeat(40);
    // Timestamps say the answer is fresh, so only git can catch this one.
    const harness = build(paths, {
      git: (args) => {
        if (args[0] === "rev-parse") return ok(`${OLDER}\n`);
        if (args[0] === "rev-list") return ok("2\n");
        if (args[0] === "log") return ok(`${OLDER}${UNIT}feat: x`);
        if (args[0] === "show") return ok(JSON.stringify({ version: "1.0.31" }));
        // `merge-base --is-ancestor` exits 0: already in this build.
        if (args[0] === "merge-base") return ok();
        return ok();
      },
    });
    await harness.control.check();
    expect(harness.control.status().available?.sourceCommit).toBe(OLDER);
    const refused = await harness.control.start();
    expect(refused).toMatchObject({ ok: false, error: "BotFleet is already on the newest build." });
    expect(harness.launched).toHaveLength(0);
    // And the answer is gone afterwards, not re-offered on the next status.
    expect(harness.control.status().available).toBeNull();
  });

  it("folds a finished run into lastRun and forgets the current one", () => {
    const paths = rig();
    writeCurrentRun(paths, "run_prior");
    writeProgress(paths, "run_prior", {
      finishedAt: "2026-09-13T11:59:00.000Z",
      outcome: "verified",
      message: "The update installed and verified.",
      receiptPath: "/Users/jay/Library/Caches/BotFleet/updates/bbbb-1/prepared.json",
    });
    const status = build(paths).control.status();
    expect(status.running).toBeNull();
    expect(status.lastRun).toEqual({
      runId: "run_prior",
      startedAt: "2026-09-13T11:55:00.000Z",
      finishedAt: "2026-09-13T11:59:00.000Z",
      outcome: "verified",
      message: "The update installed and verified.",
      receiptPath: "/Users/jay/Library/Caches/BotFleet/updates/bbbb-1/prepared.json",
    });
    expect(status.capabilities.canRun).toBe(true);
    // And it stays folded for the next harness after this one.
    expect(build(paths).control.status().lastRun?.outcome).toBe("verified");
  });

  it("closes out a run whose process is gone without an outcome", () => {
    const paths = rig();
    writeCurrentRun(paths, "run_prior");
    writeProgress(paths, "run_prior", { step: "buildBundle" });
    const status = build(paths, { processAlive: () => false }).control.status();
    expect(status.running).toBeNull();
    expect(status.lastRun?.outcome).toBe("failed");
    expect(status.lastRun?.message).toContain("without recording an outcome");
  });

  it("gives a just-launched run time to write its first record", () => {
    const paths = rig();
    writeCurrentRun(paths, "run_prior");
    const young = build(paths, { now: () => new Date("2026-09-13T11:55:30.000Z") });
    expect(young.control.status().running?.step).toBe("Starting the updater");

    const old = build(paths, { now: () => new Date("2026-09-13T12:05:00.000Z") });
    expect(old.control.status().running).toBeNull();
    expect(old.control.status().lastRun?.message).toContain("never started");
  });

  it("pushes a status only when it changed", async () => {
    const paths = rig();
    const harness = build(paths);
    expect(harness.emitted).toHaveLength(0);
    await harness.control.start({ force: true });
    expect(harness.emitted).toHaveLength(1);
    harness.control.reconcile();
    expect(harness.emitted).toHaveLength(1);
    writeProgress(paths, "run_one", { step: "buildBundle", progress: 0.25 });
    harness.control.reconcile();
    expect(harness.emitted).toHaveLength(2);
    expect(harness.emitted[1].running?.step).toBe("Building and signing the app");
  });
});

describe("reading what another process wrote", () => {
  it("refuses a record it does not recognise, rather than throwing", () => {
    expect(parseProgressRecord(null)).toBeNull();
    expect(parseProgressRecord("{}")).toBeNull();
    expect(parseProgressRecord({ schemaVersion: 99, runId: "x", startedAt: "t" })).toBeNull();
    expect(parseProgressRecord({ schemaVersion: 1, runId: "", startedAt: "t" })).toBeNull();
    expect(parseProgressRecord({ schemaVersion: 1, runId: "x", startedAt: "t", outcome: "exploded" }))
      .toMatchObject({ outcome: null });
    expect(parseProgressRecord({ schemaVersion: 1, runId: "x", startedAt: "t", progress: 7 }))
      .toMatchObject({ progress: 1 });
  });

  it("names a step in words, and falls back to the raw name", () => {
    expect(stepLabel("installDependencies")).toBe("Installing dependencies");
    expect(stepLabel("somethingNew")).toBe("somethingNew");
    expect(stepLabel(null)).toBe("Working");
  });
});
