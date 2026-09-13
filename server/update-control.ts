// "Is there a newer BotFleet, and install it" — from the desktop app or from
// a paired phone.
//
// The transactional Mac updater (`scripts/update-botfleet-mac.mjs`) stops
// this harness and quits the desktop app partway through, so it can be a
// child of neither: a child of the harness dies with the harness, and a
// child of the app dies with the app.  It therefore runs DETACHED, as a
// one-shot launchd job in the same GUI domain this harness runs in, and the
// only channel back is a progress file it writes as it goes plus the log
// launchd captures for it.  That is also why the status survives a restart:
// the run outlives us, so on boot we read the same files back and carry on
// describing a run we did not start in this process.
//
// Everything a test wants to drive — git, the launcher, the clock, the
// process check — arrives as an injected dependency.  The real ones are
// built in `createUpdateControl` from the environment.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const UPDATE_PROGRESS_SCHEMA_VERSION = 1;
export const UPDATE_LAUNCH_LABEL = "com.jay.botfleet-update";

/** Unit separator between a commit's sha and its subject in `git log`. */
const FIELD_SEPARATOR = "\u001f";
/** The gap protocol's wide sentence break, for text a person reads. */
const GAP = "\u00a0 ";

/** How many log lines the status carries.  A person watching wants the tail,
 * not the transcript; the whole log stays on disk next to the progress file. */
const LOG_TAIL_LINES = 24;
const LOG_TAIL_BYTES = 64 * 1024;
const LOG_LINE_MAX = 400;
/** Commit subjects shown in "what is new".  Beyond this the count carries it. */
const MAX_LISTED_COMMITS = 20;
/** A run with no progress file this long after launch never started. */
const LAUNCH_GRACE_MS = 120_000;

export interface UpdateCommit {
  sha: string;
  subject: string;
}

export interface UpdateAvailable {
  sourceCommit: string;
  version?: string;
  aheadBy: number;
  commits: UpdateCommit[];
}

export interface UpdateRunning {
  runId: string;
  startedAt: string;
  step: string;
  progress?: number;
  logTail: string[];
}

export type UpdateOutcome = "verified" | "rolled-back" | "failed" | "refused";

export interface UpdateLastRun {
  runId: string;
  startedAt: string;
  finishedAt: string;
  outcome: UpdateOutcome;
  message: string;
  receiptPath?: string;
}

export interface UpdateCapabilities {
  canCheck: boolean;
  canRun: boolean;
  reasons: string[];
}

/** What `currentRuntimeReadiness()` in the harness reports: whether any turn,
 * queued send, routine run or in-flight mutation would be interrupted. */
export interface RuntimeReadiness {
  safeToRestart: boolean;
  activeWorkCount: number | null;
}

/** The one refusal `force` is meant to override, so the capability reason and
 * the refusal are the same string and can be compared. */
export const BUSY_REFUSAL =
  "BotFleet is working right now.\u00a0 The updater will not interrupt a turn in flight.";

export interface UpdateInstalled {
  version: string;
  sourceCommit: string;
  installedAt?: string;
}

export interface UpdateStatus {
  installed: UpdateInstalled;
  available: UpdateAvailable | null;
  checkedAt: string | null;
  running: UpdateRunning | null;
  lastRun: UpdateLastRun | null;
  capabilities: UpdateCapabilities;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface LaunchPlan {
  runId: string;
  progressPath: string;
  logPath: string;
  scriptPath: string;
  label: string;
  /** Prepended to PATH for the detached job.  launchd hands a job the system
   * PATH, which on this Mac does not include Homebrew — so the wrapper's
   * `exec node` would not resolve without it. */
  nodeDirectory: string;
}

export interface LaunchResult {
  launcher: "launchd" | "detached";
  pid?: number;
}

export interface UpdateControlDeps {
  installed: UpdateInstalled;
  checkout: string;
  stateDirectory: string;
  scriptPath: string;
  label: string;
  platform: string;
  nodeDirectory: string;
  now: () => Date;
  git: (args: string[]) => Promise<CommandResult>;
  launch: (plan: LaunchPlan) => Promise<LaunchResult>;
  processAlive: (pid: number) => boolean;
  /** Whether this harness has work in flight.  The route passes its own,
   * admission-adjusted reading when it starts a run; this one answers the
   * status route, which holds no mutating admission of its own. */
  readiness: () => RuntimeReadiness;
  /** How a state file reaches disk.  A seam rather than a detail: the
   * behaviour that matters here is what happens when it THROWS, and a test
   * that arranged that with directory permissions would only be testing them
   * on the platforms where they work that way. */
  writeState: (path: string, value: unknown) => void;
  /** Does the tracked updater in the checkout accept `--progress`?  The
   * harness and the updater advance together (both live in the always-on
   * checkout), so this is only ever false on a Mac whose checkout was moved
   * back by hand — but without the flag there is no channel to report on the
   * run at all, and a run nobody can describe is worse than a refusal. */
  updaterReportsProgress: (checkout: string) => boolean;
  newRunId: () => string;
  emit: (status: UpdateStatus) => void;
  pollIntervalMs: number;
}

/** What one run's progress file holds, once validated. */
export interface ProgressRecord {
  schemaVersion: number;
  runId: string;
  command: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  step: string | null;
  progress: number | null;
  targetCommit: string | null;
  receiptPath: string | null;
  finishedAt: string | null;
  outcome: UpdateOutcome | null;
  message: string | null;
}

interface CurrentRunRecord {
  runId: string;
  startedAt: string;
  progressPath: string;
  logPath: string;
  launcher: string;
  targetCommit: string | null;
}

const OUTCOMES: readonly UpdateOutcome[] = ["verified", "rolled-back", "failed", "refused"];

function isOutcome(value: unknown): value is UpdateOutcome {
  return typeof value === "string" && (OUTCOMES as readonly string[]).includes(value);
}

/** Read JSON that another process writes.  Anything unreadable, torn, or the
 * wrong shape is "no record", never a throw: this file is a courtesy channel
 * and a bad one must not take the status route down with it. */
function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Validate a progress file written by `scripts/update-progress.mjs`. */
export function parseProgressRecord(value: unknown): ProgressRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== UPDATE_PROGRESS_SCHEMA_VERSION) return null;
  if (typeof raw.runId !== "string" || !raw.runId) return null;
  if (typeof raw.startedAt !== "string") return null;
  const progress = typeof raw.progress === "number" && Number.isFinite(raw.progress)
    ? Math.min(1, Math.max(0, raw.progress))
    : null;
  return {
    schemaVersion: UPDATE_PROGRESS_SCHEMA_VERSION,
    runId: raw.runId,
    command: typeof raw.command === "string" ? raw.command : "update",
    pid: Number.isInteger(raw.pid) ? (raw.pid as number) : 0,
    startedAt: raw.startedAt,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : raw.startedAt,
    step: typeof raw.step === "string" ? raw.step : null,
    progress,
    targetCommit: typeof raw.targetCommit === "string" ? raw.targetCommit : null,
    receiptPath: typeof raw.receiptPath === "string" ? raw.receiptPath : null,
    finishedAt: typeof raw.finishedAt === "string" ? raw.finishedAt : null,
    outcome: isOutcome(raw.outcome) ? raw.outcome : null,
    message: typeof raw.message === "string" ? raw.message : null,
  };
}

/** Sentences a person reads while they wait.  Kept here rather than in the
 * renderer so the phone and the Mac say the same thing. */
export const UPDATE_STEP_LABELS: Record<string, string> = {
  acquireLock: "Taking the update lock",
  resolveTarget: "Finding the newest build",
  prepareSource: "Staging a copy of the new source",
  assertStagingSource: "Checking the staged copy is separate",
  installDependencies: "Installing dependencies",
  buildBundle: "Building and signing the app",
  validateBundle: "Verifying the signature and identity",
  persistPrepared: "Recording the prepared build",
  validatePrepared: "Re-checking the prepared build",
  preflight: "Checking for work in flight",
  capturePrevious: "Snapshotting what is installed now",
  materializeCandidate: "Placing the new build alongside",
  fence: "Holding new work",
  quiesce: "Letting BotFleet finish and stop",
  assertQuiesced: "Confirming BotFleet stopped",
  advanceCheckout: "Advancing the checkout",
  installCandidate: "Installing the new build",
  prepareCredentials: "Preparing credentials",
  startHarness: "Starting the harness",
  verifyHarness: "Verifying the harness",
  startApplication: "Reopening BotFleet",
  verifySingleOwner: "Confirming a single owner",
  finish: "Finishing up",
  rollback: "Rolling back",
  cleanupCandidate: "Cleaning up the staged build",
  releaseSource: "Releasing the staged source",
};

export function stepLabel(step: string | null): string {
  if (!step) return "Working";
  return UPDATE_STEP_LABELS[step] ?? step;
}

/** The tail of the detached job's own output.  Bounded at both ends: the
 * last chunk of the file, the last few lines of that chunk, each clipped. */
export function readLogTail(path: string, lines = LOG_TAIL_LINES): string[] {
  let handle: number | null = null;
  try {
    handle = openSync(path, "r");
    const size = fstatSync(handle).size;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    readSync(handle, buffer, 0, length, size - length);
    return buffer
      .toString("utf8")
      .split("\n")
      .map((line) => line.replace(/\s+$/, "").slice(0, LOG_LINE_MAX))
      .filter((line) => line.length > 0)
      .slice(-lines);
  } catch {
    return [];
  } finally {
    if (handle !== null) {
      try {
        closeSync(handle);
      } catch {
        /* already gone */
      }
    }
  }
}

/** The running half of the status, from one progress record. */
export function runningFrom(record: ProgressRecord, logTail: string[]): UpdateRunning {
  const running: UpdateRunning = {
    runId: record.runId,
    startedAt: record.startedAt,
    step: stepLabel(record.step),
    logTail,
  };
  if (record.progress !== null) running.progress = record.progress;
  return running;
}

/** The finished half, from a progress record that carries an outcome. */
export function lastRunFrom(record: ProgressRecord): UpdateLastRun | null {
  if (!record.finishedAt || !record.outcome) return null;
  const lastRun: UpdateLastRun = {
    runId: record.runId,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    outcome: record.outcome,
    message: record.message ?? "",
  };
  if (record.receiptPath) lastRun.receiptPath = record.receiptPath;
  return lastRun;
}

/** Is this remembered "available" answer still worth offering?
 *
 * The answer is persisted, so it outlives the harness that wrote it — and the
 * usual reason it outlives one is that the update it described succeeded.
 * Two ways it goes wrong, and the inequality alone catches only the first:
 *
 *   - it names the commit now installed (this process IS the result);
 *   - it names an OLDER commit than the one installed.  `check()` recorded X,
 *     `origin/main` moved on to Y, the install that ran took Y, and X is now
 *     behind us — different from the installed commit, and still nothing to
 *     install.
 *
 * The second is caught by time: the answer was recorded before this build was
 * installed, so it cannot describe anything newer than it.  `installedAt`
 * dates a packaged build; a source run has none, and the last run's finish is
 * the same boundary.  `start()` confirms with `git merge-base` before it
 * launches anything, which is the authoritative check — this one is the cheap
 * synchronous one that keeps a stale answer off every status response. */
export function availableIsStale(input: {
  available: UpdateAvailable | null;
  installedCommit: string;
  checkedAt: string | null;
  installedAt?: string;
  lastRunFinishedAt?: string;
}): boolean {
  if (!input.available) return true;
  if (input.available.sourceCommit === input.installedCommit) return true;
  const recorded = input.checkedAt ? Date.parse(input.checkedAt) : Number.NaN;
  // An answer with no readable timestamp cannot be placed relative to the
  // install, and an unplaceable answer is not one to act on.
  if (!Number.isFinite(recorded)) return true;
  for (const boundary of [input.installedAt, input.lastRunFinishedAt]) {
    const at = boundary ? Date.parse(boundary) : Number.NaN;
    if (Number.isFinite(at) && recorded <= at) return true;
  }
  return false;
}

/** Why `POST /api/update/run` will not start, or null when it will.
 *
 * Pure so the refusal rules can be read and tested in one place — they are
 * the whole safety surface of a route that restarts this computer's BotFleet
 * from a phone. */
export function runRefusal(input: {
  capabilities: UpdateCapabilities;
  running: UpdateRunning | null;
  available: UpdateAvailable | null;
  readiness: RuntimeReadiness;
  dirty: boolean;
  force: boolean;
}): string | null {
  if (input.running) return "An update is already running.";
  // Readiness comes before the structural reasons because it is the one
  // `force` is meant to override.  Forcing does not make it safe: the
  // updater's own preflight refuses a busy machine too, and the run then
  // ends `refused` rather than interrupting a turn.
  if (!input.readiness.safeToRestart && !input.force) return BUSY_REFUSAL;
  const structural = input.capabilities.reasons.find((reason) => reason !== BUSY_REFUSAL);
  if (!input.capabilities.canRun && structural) return structural;
  if (input.dirty) {
    return "The always-on checkout has uncommitted changes, so the updater would refuse.";
  }
  if (!input.force && !input.available) return "BotFleet is already on the newest build.";
  return null;
}

/** The exact command that starts the detached updater.
 *
 * `launchctl submit` puts the job in the same GUI domain this harness runs
 * in, which is the point: launchd owns it, so it survives both the harness
 * stopping and the desktop app quitting — and those are two of the steps.  A
 * plain detached spawn would survive the app but is still reparented out of
 * a process tree launchd is about to restart, so it is only the fallback. */
export function launchPlanCommand(plan: LaunchPlan): { command: string; args: string[] } {
  const quote = (value: string) => `'${value.split("'").join(`'\\''`)}'`;
  const script = [
    `export PATH=${quote(plan.nodeDirectory)}:"$PATH"`,
    `exec /bin/bash ${quote(plan.scriptPath)} --progress ${quote(plan.progressPath)} --run-id ${quote(plan.runId)}`,
  ].join("\n");
  return {
    command: "/bin/launchctl",
    args: [
      "submit",
      "-l",
      plan.label,
      "-o",
      plan.logPath,
      "-e",
      plan.logPath,
      "--",
      "/bin/bash",
      "-c",
      script,
    ],
  };
}

function execCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const numeric = error && typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : null;
        resolve({
          code: numeric ?? (error ? 1 : 0),
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

/** Is a job with this label registered AND running right now?
 *
 * `launchctl list <label>` exits 0 for a label that is merely registered and
 * prints `"PID" = <n>;` only while it actually has a process.  The
 * distinction matters: removing a finished label is housekeeping, removing a
 * live one SIGTERMs an update mid-install. */
export function launchdJobIsAlive(listed: CommandResult): boolean {
  return listed.code === 0 && /"PID"\s*=\s*\d+;/.test(listed.stdout);
}

async function defaultLaunch(plan: LaunchPlan): Promise<LaunchResult> {
  const listed = await execCommand("/bin/launchctl", ["list", plan.label]);
  if (launchdJobIsAlive(listed)) {
    throw new Error(`A ${plan.label} job is already running on this Mac.`);
  }
  mkdirSync(dirname(plan.logPath), { recursive: true, mode: 0o700 });
  writeFileSync(plan.logPath, "", { mode: 0o600, flag: "a" });
  // A finished label stays registered and makes the next `submit` fail
  // outright, so it is cleared — but only now that it is known to be dead.
  await execCommand("/bin/launchctl", ["remove", plan.label]);
  const { command, args } = launchPlanCommand(plan);
  const submitted = await execCommand(command, args);
  if (submitted.code === 0) return { launcher: "launchd" };
  // launchd refused (an old label still settling, a sandboxed domain).  A
  // detached, session-leading child is still better than not updating: it
  // outlives the desktop app, and the harness restart it performs is a
  // launchd kickstart, not a signal to this process group.
  const log = openSync(plan.logPath, "a");
  try {
    const child = spawn(
      "/bin/bash",
      [plan.scriptPath, "--progress", plan.progressPath, "--run-id", plan.runId],
      {
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...process.env, PATH: `${plan.nodeDirectory}:${process.env.PATH ?? ""}` },
      },
    );
    child.unref();
    return { launcher: "detached", pid: child.pid };
  } finally {
    closeSync(log);
  }
}

function defaultDeps(overrides: Partial<UpdateControlDeps>): UpdateControlDeps {
  const checkout = overrides.checkout
    ?? process.env.BOTFLEET_CHECKOUT
    ?? join(homedir(), "apps", "botfleet-server");
  // Beside the updater's own stages rather than in the data directory: this
  // is machine state about an install, not fleet data, and the updater
  // already owns that cache.  The test/soak data-directory override isolates
  // a rig here the same way it isolates everything else.
  const dataOverride = process.env.OMB_DATA_DIR;
  const stateDirectory = overrides.stateDirectory
    ?? process.env.BOTFLEET_UPDATE_CONTROL_DIR
    ?? (dataOverride
      ? join(dataOverride, "update-control")
      : join(homedir(), "Library", "Caches", "BotFleet", "update-control"));
  const scriptPath = overrides.scriptPath
    ?? process.env.BOTFLEET_UPDATER_SCRIPT
    ?? join(homedir(), "apps", "update-botfleet.sh");
  return {
    installed: overrides.installed ?? { version: "0.0.0", sourceCommit: "0".repeat(40) },
    checkout,
    stateDirectory,
    scriptPath,
    label: overrides.label ?? UPDATE_LAUNCH_LABEL,
    platform: overrides.platform ?? process.platform,
    nodeDirectory: overrides.nodeDirectory ?? dirname(process.execPath),
    now: overrides.now ?? (() => new Date()),
    git: overrides.git ?? ((args) => execCommand("git", ["-C", checkout, ...args])),
    launch: overrides.launch ?? defaultLaunch,
    readiness: overrides.readiness ?? (() => ({ safeToRestart: true, activeWorkCount: 0 })),
    writeState: overrides.writeState ?? writeJsonFile,
    processAlive: overrides.processAlive ?? ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // An inaccessible or reused pid is treated as alive: calling a live
        // updater dead would let a second one start on top of it.
        return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
      }
    }),
    updaterReportsProgress: overrides.updaterReportsProgress ?? ((root) => {
      try {
        return readFileSync(join(root, "scripts", "update-botfleet-mac.mjs"), "utf8").includes("--progress");
      } catch {
        // An unreadable implementation is not evidence against it; the launch
        // itself will fail loudly enough.
        return true;
      }
    }),
    newRunId: overrides.newRunId ?? (() => randomUUID().split("-").join("").slice(0, 24)),
    emit: overrides.emit ?? (() => {}),
    pollIntervalMs: overrides.pollIntervalMs ?? 2_000,
  };
}

export interface UpdateControl {
  status(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  start(options?: { force?: boolean; readiness?: RuntimeReadiness }): Promise<
    { ok: true; runId: string; status: UpdateStatus } | { ok: false; error: string; status: UpdateStatus }
  >;
  reconcile(): void;
  dispose(): void;
}

export function createUpdateControl(overrides: Partial<UpdateControlDeps> = {}): UpdateControl {
  const deps = defaultDeps(overrides);
  const paths = {
    available: join(deps.stateDirectory, "available.json"),
    currentRun: join(deps.stateDirectory, "current-run.json"),
    lastRun: join(deps.stateDirectory, "last-run.json"),
  };
  const runPaths = (runId: string) => ({
    progress: join(deps.stateDirectory, "runs", `${runId}.progress.json`),
    log: join(deps.stateDirectory, "runs", `${runId}.log`),
  });

  let available: UpdateAvailable | null = null;
  let checkedAt: string | null = null;
  let current: CurrentRunRecord | null = null;
  let lastRun: UpdateLastRun | null = null;
  let lastEmitted = "";
  let starting = false;
  /** An invalidation worked out in memory that disk has not heard about yet.
   * Never written during construction: `createUpdateControl` runs at module
   * scope in server/index.ts, so a throw here is a harness that does not
   * boot — and an unwritable cache directory must never be that. */
  let availableNeedsWrite = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** Persist, or carry on without it.  Every file this module writes is a
   * convenience for the NEXT process; none of them is load-bearing for this
   * one, whose state is already in memory. */
  const persist = (path: string, value: unknown): boolean => {
    try {
      deps.writeState(path, value);
      return true;
    } catch (error) {
      console.warn(`BotFleet could not record update state at ${path}: ${(error as Error)?.message ?? error}`);
      return false;
    }
  };

  const flushAvailable = () => {
    if (!availableNeedsWrite) return;
    if (persist(paths.available, { checkedAt, available })) availableNeedsWrite = false;
  };

  /** Is the remembered answer one this process should still offer? */
  const staleAvailable = (candidate: UpdateAvailable | null) => availableIsStale({
    available: candidate,
    installedCommit: deps.installed.sourceCommit,
    checkedAt,
    installedAt: deps.installed.installedAt,
    lastRunFinishedAt: lastRun?.finishedAt,
  });

  /** What this Mac is equipped to do, before anything about what it is doing
   * right now.  Separated from `capabilities` because the dirty-checkout
   * precheck has to run on a busy machine too: `force` talks past readiness,
   * and a forced run on a dirty checkout must be refused here rather than
   * launched for the updater to refuse a minute later. */
  const structural = () => {
    const darwin = deps.platform === "darwin";
    const checkoutPresent = darwin && existsSync(join(deps.checkout, ".git"));
    const scriptPresent = existsSync(deps.scriptPath);
    const reportsProgress = !darwin || !checkoutPresent || deps.updaterReportsProgress(deps.checkout);
    return {
      darwin,
      checkoutPresent,
      scriptPresent,
      reportsProgress,
      canCheck: darwin && checkoutPresent,
      canRun: darwin && checkoutPresent && scriptPresent && reportsProgress,
    };
  };

  const capabilities = (running: boolean): UpdateCapabilities => {
    const able = structural();
    const reasons: string[] = [];
    if (!able.darwin) reasons.push("Updating from this computer is macOS only.");
    if (able.darwin && !able.checkoutPresent) {
      reasons.push(`The always-on checkout is not at ${deps.checkout}.`);
    }
    if (able.darwin && able.checkoutPresent && !able.scriptPresent) {
      reasons.push(`The updater is not installed at ${deps.scriptPath}.`);
    }
    if (able.darwin && able.checkoutPresent && able.scriptPresent && !able.reportsProgress) {
      reasons.push(
        `The updater in ${deps.checkout} predates this build.${GAP}Run it once from a terminal to pick up the new one.`,
      );
    }
    if (running) reasons.push("An update is already running.");
    // Listed last, and the only reason `force` can talk past — see runRefusal.
    const idle = deps.readiness().safeToRestart;
    if (!idle) reasons.push(BUSY_REFUSAL);
    return { canCheck: able.canCheck, canRun: able.canRun && !running && idle, reasons };
  };

  const loadAvailable = () => {
    const raw = readJsonFile(paths.available);
    if (!raw || typeof raw !== "object") return;
    const record = raw as Record<string, unknown>;
    checkedAt = typeof record.checkedAt === "string" ? record.checkedAt : null;
    const candidate = record.available;
    if (!candidate || typeof candidate !== "object") {
      available = null;
      return;
    }
    const value = candidate as Record<string, unknown>;
    if (typeof value.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(value.sourceCommit)) {
      available = null;
      return;
    }
    const restored: UpdateAvailable = {
      sourceCommit: value.sourceCommit,
      version: typeof value.version === "string" ? value.version : undefined,
      aheadBy: Number.isInteger(value.aheadBy) ? (value.aheadBy as number) : 0,
      commits: Array.isArray(value.commits)
        ? (value.commits as unknown[])
            .filter((one): one is UpdateCommit =>
              Boolean(one)
              && typeof (one as UpdateCommit).sha === "string"
              && typeof (one as UpdateCommit).subject === "string")
            .slice(0, MAX_LISTED_COMMITS)
        : [],
    };
    if (!staleAvailable(restored)) {
      available = restored;
      return;
    }
    // Drop it, and remember that disk still says otherwise.  The write itself
    // waits for the first status or check, because this runs on the
    // constructor path and an EACCES here would stop the harness booting.
    available = null;
    availableNeedsWrite = true;
  };

  const loadLastRun = () => {
    const raw = readJsonFile(paths.lastRun);
    if (!raw || typeof raw !== "object") return;
    const record = raw as Record<string, unknown>;
    if (typeof record.runId !== "string" || !isOutcome(record.outcome)) return;
    lastRun = {
      runId: record.runId,
      startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
      finishedAt: typeof record.finishedAt === "string" ? record.finishedAt : "",
      outcome: record.outcome,
      message: typeof record.message === "string" ? record.message : "",
      ...(typeof record.receiptPath === "string" ? { receiptPath: record.receiptPath } : {}),
    };
  };

  const loadCurrent = () => {
    const raw = readJsonFile(paths.currentRun);
    if (!raw || typeof raw !== "object") return;
    const record = raw as Record<string, unknown>;
    if (typeof record.runId !== "string" || !record.runId) return;
    current = {
      runId: record.runId,
      startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
      progressPath: typeof record.progressPath === "string"
        ? record.progressPath
        : runPaths(record.runId).progress,
      logPath: typeof record.logPath === "string" ? record.logPath : runPaths(record.runId).log,
      launcher: typeof record.launcher === "string" ? record.launcher : "launchd",
      targetCommit: typeof record.targetCommit === "string" ? record.targetCommit : null,
    };
  };

  const settle = (record: ProgressRecord | null, fallbackMessage: string) => {
    const finished = record ? lastRunFrom(record) : null;
    lastRun = finished ?? {
      runId: current?.runId ?? record?.runId ?? "unknown",
      startedAt: current?.startedAt ?? record?.startedAt ?? "",
      finishedAt: deps.now().toISOString(),
      outcome: "failed",
      message: fallbackMessage,
    };
    persist(paths.lastRun, lastRun);
    current = null;
    try {
      rmSync(paths.currentRun, { force: true });
    } catch {
      /* already gone, or a cache directory we cannot write — neither matters
       * here: `current` is null in memory and that is what answers callers. */
    }
  };

  /** Fold whatever the detached run has written into our view of it.  Called
   * on boot and on every poll, so a run that started before this process
   * existed is described exactly like one we launched ourselves — which is
   * the normal case, because the updater restarts this harness mid-run. */
  const reconcile = () => {
    if (!current) return;
    const record = parseProgressRecord(readJsonFile(current.progressPath));
    if (record?.finishedAt && record.outcome) {
      settle(record, record.message ?? "");
      return;
    }
    if (record && record.pid > 0 && !deps.processAlive(record.pid)) {
      settle(null, `The updater stopped without recording an outcome.${GAP}Its log is beside the receipt.`);
      return;
    }
    if (!record) {
      // No progress file yet is normal for the first second of a run; no
      // progress file long after the start means the job never began.
      const startedMs = Date.parse(current.startedAt);
      const ageMs = Number.isFinite(startedMs) ? deps.now().getTime() - startedMs : 0;
      if (ageMs > LAUNCH_GRACE_MS) {
        settle(null, `The updater never started.${GAP}Check the launchd job log.`);
      }
    }
  };

  const buildStatus = (): UpdateStatus => {
    let running: UpdateRunning | null = null;
    if (current) {
      const record = parseProgressRecord(readJsonFile(current.progressPath));
      running = record
        ? runningFrom(record, readLogTail(current.logPath))
        : {
            runId: current.runId,
            startedAt: current.startedAt,
            step: "Starting the updater",
            logTail: readLogTail(current.logPath),
          };
    }
    return {
      installed: deps.installed,
      // Belt and braces: an answer recorded before this build was installed
      // never reaches a client, whichever commit it names.
      available: staleAvailable(available) ? null : available,
      checkedAt,
      running,
      lastRun,
      capabilities: capabilities(Boolean(running)),
    };
  };

  const emitIfChanged = () => {
    const status = buildStatus();
    const serialized = JSON.stringify(status);
    if (serialized === lastEmitted) return;
    lastEmitted = serialized;
    deps.emit(status);
  };

  const ensureTimer = () => {
    if (timer || !current) return;
    timer = setInterval(() => {
      reconcile();
      emitIfChanged();
      if (!current && timer) {
        clearInterval(timer);
        timer = null;
      }
    }, deps.pollIntervalMs);
    timer.unref?.();
  };

  const dirtyCheckout = async (): Promise<boolean> => {
    const result = await deps.git(["status", "--porcelain"]);
    return result.code !== 0 || result.stdout.trim().length > 0;
  };

  const check = async (): Promise<UpdateStatus> => {
    reconcile();
    if (!capabilities(Boolean(current)).canCheck) return buildStatus();
    await deps.git(["fetch", "origin", "main"]);
    const head = await deps.git(["rev-parse", "--verify", "origin/main^{commit}"]);
    const target = head.stdout.trim();
    // A failed fetch with no usable origin/main leaves the previous answer in
    // place rather than claiming there is nothing new.
    if (head.code !== 0 || !/^[a-f0-9]{40}$/.test(target)) return buildStatus();
    checkedAt = deps.now().toISOString();
    if (target === deps.installed.sourceCommit) {
      available = null;
    } else {
      const range = `${deps.installed.sourceCommit}..${target}`;
      const counted = await deps.git(["rev-list", "--count", range]);
      const listed = await deps.git([
        "log",
        `--format=%H%x1f%s`,
        "-n",
        String(MAX_LISTED_COMMITS),
        range,
      ]);
      const manifest = await deps.git(["show", `${target}:package.json`]);
      let version: string | undefined;
      if (manifest.code === 0) {
        try {
          const parsed = JSON.parse(manifest.stdout) as { version?: unknown };
          if (typeof parsed.version === "string") version = parsed.version;
        } catch {
          /* an unreadable manifest just means no version label */
        }
      }
      const aheadBy = Number.parseInt(counted.stdout.trim(), 10);
      available = {
        sourceCommit: target,
        version,
        aheadBy: Number.isFinite(aheadBy) ? aheadBy : 0,
        commits: listed.code === 0
          ? listed.stdout
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line) => {
                const parts = line.split(FIELD_SEPARATOR);
                return { sha: parts[0] ?? "", subject: parts.slice(1).join(FIELD_SEPARATOR) };
              })
              .filter((commit) => /^[a-f0-9]{40}$/.test(commit.sha))
          : [],
      };
    }
    availableNeedsWrite = true;
    flushAvailable();
    emitIfChanged();
    return buildStatus();
  };

  const start: UpdateControl["start"] = async (options = {}) => {
    // Set before the first await, and released only once `current` is
    // written.  Two `POST /api/update/run` landing together would otherwise
    // both pass the refusal check — they interleave across `dirtyCheckout()`
    // and `launch()`, neither of which has published a run yet — and the
    // second launch would take the label out from under the first.
    if (starting) return { ok: false, error: "An update is already running.", status: buildStatus() };
    starting = true;
    try {
      return await beginRun(options);
    } finally {
      starting = false;
    }
  };

  const beginRun = async (options: { force?: boolean; readiness?: RuntimeReadiness }) => {
    reconcile();
    flushAvailable();
    const before = buildStatus();
    const force = options.force === true;
    const refusal = runRefusal({
      capabilities: before.capabilities,
      running: before.running,
      available: before.available,
      // The caller's reading wins: the route holds a mutating admission of
      // its own, which it must not count as work it would be interrupting.
      readiness: options.readiness ?? deps.readiness(),
      // Asked whenever this Mac is equipped to run one at all, not only when
      // it is free to: `force` talks past readiness, and a forced run on a
      // dirty checkout has to be refused here rather than launched for the
      // updater to refuse a minute later.
      dirty: structural().canRun ? await dirtyCheckout() : false,
      force,
    });
    if (refusal) return { ok: false as const, error: refusal, status: buildStatus() };

    // The authoritative staleness check, and the last thing before a launch.
    // `availableIsStale` is a timestamp heuristic; git knows.  An `available`
    // that is an ancestor of what is installed is already in this build.
    if (!force && before.available) {
      const contained = await deps.git([
        "merge-base", "--is-ancestor", before.available.sourceCommit, deps.installed.sourceCommit,
      ]);
      if (contained.code === 0) {
        available = null;
        availableNeedsWrite = true;
        flushAvailable();
        emitIfChanged();
        return {
          ok: false as const,
          error: "BotFleet is already on the newest build.",
          status: buildStatus(),
        };
      }
    }

    const runId = deps.newRunId();
    const files = runPaths(runId);
    try {
      mkdirSync(join(deps.stateDirectory, "runs"), { recursive: true, mode: 0o700 });
    } catch (error) {
      // Unlike the bookkeeping files, this one IS load-bearing: without a
      // place for the progress file the run would be one nothing could
      // describe, which is the thing this module exists to prevent.
      const detail = String((error as Error)?.message ?? error).slice(0, 200);
      return {
        ok: false as const,
        error: `The update could not be recorded, so it was not started.${GAP}${detail}`,
        status: buildStatus(),
      };
    }
    const startedAt = deps.now().toISOString();
    let result: LaunchResult;
    try {
      result = await deps.launch({
        runId,
        progressPath: files.progress,
        logPath: files.log,
        scriptPath: deps.scriptPath,
        label: deps.label,
        nodeDirectory: deps.nodeDirectory,
      });
    } catch (error) {
      const detail = String((error as Error)?.message ?? error).slice(0, 200);
      return { ok: false as const, error: `The updater could not be started.${GAP}${detail}`, status: buildStatus() };
    }
    current = {
      runId,
      startedAt,
      progressPath: files.progress,
      logPath: files.log,
      launcher: result.launcher,
      targetCommit: before.available?.sourceCommit ?? null,
    };
    persist(paths.currentRun, current);
    ensureTimer();
    emitIfChanged();
    return { ok: true as const, runId, status: buildStatus() };
  };

  // Order matters: the remembered "available" answer is judged against the
  // last run's finish, so that has to be read first.
  loadLastRun();
  loadAvailable();
  loadCurrent();
  reconcile();
  ensureTimer();

  return {
    status: () => {
      reconcile();
      flushAvailable();
      return buildStatus();
    },
    check,
    start,
    reconcile: () => {
      reconcile();
      emitIfChanged();
    },
    dispose: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/** When the app is packaged, its build manifest's mtime is the closest thing
 * to "when this was installed".  Source runs have no manifest and no date. */
export function installedAtFor(manifestPath: string): string | undefined {
  try {
    return statSync(manifestPath).mtime.toISOString();
  } catch {
    return undefined;
  }
}

/** Packaged builds ship `build-identity.json` beside the bundled harness, so
 * its mtime dates this install.  A source run has no manifest and no date. */
export function packagedInstalledAt(): string | undefined {
  return installedAtFor(join(dirname(fileURLToPath(import.meta.url)), "build-identity.json"));
}
