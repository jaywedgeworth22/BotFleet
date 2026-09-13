// The four things that decide whether "install the update" is safe: the
// status shape both clients render, the refusals, what the launcher actually
// runs, and the reconcile that lets a run survive the restart it performs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createUpdateControl,
  launchPlanCommand,
  parseProgressRecord,
  runRefusal,
  stepLabel,
  type CommandResult,
  type LaunchPlan,
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
    now?: () => Date;
    installedCommit?: string;
  } = {},
): Harness {
  const launched: LaunchPlan[] = [];
  const emitted: UpdateStatus[] = [];
  const git: string[][] = [];
  const control = createUpdateControl({
    installed: { version: "1.0.30", sourceCommit: options.installedCommit ?? INSTALLED_COMMIT },
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
      launched.push(plan);
      return { launcher: "launchd" };
    },
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

  it("names the one blocking reason", () => {
    expect(runRefusal({ capabilities, running, available, dirty: false, force: false }))
      .toBe("An update is already running.");
    expect(runRefusal({
      capabilities: { canCheck: false, canRun: false, reasons: ["Updating from this computer is macOS only."] },
      running: null,
      available,
      dirty: false,
      force: false,
    })).toBe("Updating from this computer is macOS only.");
    expect(runRefusal({ capabilities, running: null, available, dirty: true, force: false }))
      .toContain("uncommitted changes");
    expect(runRefusal({ capabilities, running: null, available: null, dirty: false, force: false }))
      .toBe("BotFleet is already on the newest build.");
    expect(runRefusal({ capabilities, running: null, available: null, dirty: false, force: true })).toBeNull();
    expect(runRefusal({ capabilities, running: null, available, dirty: false, force: false })).toBeNull();
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
