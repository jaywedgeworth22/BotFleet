// In-app auto-updater (electron-updater). Downloads are user-driven; macOS
// stages the downloaded ZIP immediately and the explicit restart applies it.
// One state object is broadcast on every transition.
//
// Only runs in the packaged, signed+notarized app (mac auto-update requires
// signing). In dev it's a no-op so the browser/dev shell is unaffected.
// electron-updater is vendored (electron/vendor/electron-updater.cjs) because
// the packaged app ships no node_modules.
import { app, ipcMain } from "electron";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import {
  AUTO_CHECK_THROTTLE_MS,
  macAppFingerprint,
  nextAutoUpdateRecord,
  readAutoUpdateConfig,
  shouldRunAutomaticCheck,
} from "./updater-throttle.mjs";

const require = createRequire(import.meta.url);

// Throttle window: the auto-check interval is a poll, not a contract.  The
// user-visible cadence is "no more than once per 6 hours", so the timers
// stay short (so the user sees a fresh result quickly after turning the
// setting on) but every tick consults `shouldRunAutomaticCheck` first.
const POLL_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15_000;

let autoUpdater = null;
let win = null;
// status: idle | checking | available | downloading | downloaded | installing | error
let state = { status: "idle" };
let updaterCoordinator = null;
let autoUpdateEnabled = false;

function updaterLogger() {
  const directory = app.getPath("logs");
  const file = join(directory, "updater.log");
  const write = (level, values) => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const message = values
        .map((value) => (value instanceof Error ? value.stack ?? value.message : String(value)))
        .join(" ");
      appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${message}\n`, { mode: 0o600 });
    } catch {
      // Logging must never make updating unavailable.
    }
  };
  return Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, (...values) => write(level, values)]));
}

function setState(patch) {
  state = { ...state, ...patch };
  try {
    win?.webContents?.send("update:state", state);
  } catch {
    /* window gone */
  }
}

function configPath() {
  return join(
    process.env.OMB_DATA_DIR || process.env.BOTFLEET_DATA_DIR || join(homedir(), ".botfleet"),
    "config.json",
  );
}

function recordSuccessfulAutoCheck() {
  if (!autoUpdateEnabled) return;
  // PATCH the same file the harness reads so the next tick and the next
  // launch agree.  Read-modify-write, not a full config save: this module
  // never touches anything other than `autoUpdate`.
  try {
    const path = configPath();
    let disk = {};
    try {
      disk = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      /* first write */
    }
    const fingerprint = macAppFingerprint();
    disk.autoUpdate = nextAutoUpdateRecord(disk.autoUpdate ?? {}, { fingerprint });
    // preserve the live enabled state — the helper does not know about it
    disk.autoUpdate.enabled = autoUpdateEnabled;
    const directory = join(path, "..");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendFileSync(path, ""); // touch if missing
  } catch {
    /* never let the check fail because we could not persist */
  }
}

export function registerUpdaterIpc() {
  ipcMain.handle("update:get-state", () => state);
  // Manual check always bypasses the 6-hour throttle — the whole point
  // of the button is "ask now", and the Settings copy says so.
  ipcMain.handle("update:check", () => updaterCoordinator?.check(true));
  ipcMain.handle("update:download", () => updaterCoordinator?.download());
  ipcMain.handle("update:install", () => updaterCoordinator?.install());
  ipcMain.handle("update:set-enabled", (_event, enabled) => {
    autoUpdateEnabled = Boolean(enabled);
    if (autoUpdateEnabled) void updaterCoordinator?.check();
  });
}

export function startUpdater(mainWindow) {
  win = mainWindow;
  // dev / unsigned builds can't auto-update — leave the banner dormant
  if (!app.isPackaged) {
    updaterCoordinator = null;
    setState({ status: "idle" });
    return;
  }

  try {
    const config = readAutoUpdateConfig(configPath());
    // Always wire the coordinator in packaged apps so enabling the setting
    // or pressing Check for updates works without a restart. Automatic
    // periodic checks still honor autoUpdate.enabled below.
    autoUpdateEnabled = config.enabled === true;
  } catch (e) {
    autoUpdateEnabled = false;
  }

  try {
    ({ autoUpdater } = require("./vendor/electron-updater.cjs"));
  } catch {
    updaterCoordinator = null;
    setState({ status: "error", message: "updater unavailable" });
    return;
  }
  autoUpdater.autoDownload = false; // button-driven download
  // Squirrel.Mac has a second, native staging pass after the ZIP download.
  // Start it immediately so "Restart to update" never has to begin that slow
  // pass and wait indefinitely. Windows keeps the explicit installer click.
  autoUpdater.autoInstallOnAppQuit = process.platform === "darwin";
  autoUpdater.logger = updaterLogger();

  updaterCoordinator = createUpdaterCoordinator(autoUpdater, setState);

  // Wrap the coordinator so a successful check is what actually counts
  // as "last checked".  The coordinator's `check` returns the in-flight
  // promise; we hook .then so the timestamp and fingerprint get
  // persisted only on the success path.  Both manual and automatic
  // checks persist a timestamp — only the throttle consults it, and the
  // throttle ignores manual checks, so recording both is correct and
  // lets the next auto-tick honour the full window.
  const trackedCheck = (manual) => {
    const promise = updaterCoordinator?.check(manual);
    if (promise && typeof promise.then === "function") {
      promise.then(() => recordSuccessfulAutoCheck()).catch(() => {});
    }
    return promise;
  };

  // First automatic check ~15s after launch (let the app settle), then
  // hourly — both silent on failure.  Every tick consults
  // `shouldRunAutomaticCheck`, which combines the toggle and the
  // 6-hour throttle into a single decision.
  // Manual "Check for updates" always works once the coordinator exists.
  // Timers stay armed so enabling the setting later takes effect without
  // a restart; they no-op while autoUpdateEnabled is false.
  setTimeout(() => {
    if (shouldRunAutomaticCheck({ enabled: autoUpdateEnabled, lastCheckMs: readAutoUpdateConfig(configPath()).lastCheckMs })) {
      void trackedCheck(false);
    }
  }, FIRST_CHECK_DELAY_MS).unref?.();
  setInterval(() => {
    if (shouldRunAutomaticCheck({ enabled: autoUpdateEnabled, lastCheckMs: readAutoUpdateConfig(configPath()).lastCheckMs })) {
      void trackedCheck(false);
    }
  }, POLL_INTERVAL_MS).unref?.();
}

// Exposed for tests; the helpers themselves live in updater-throttle.mjs.
export { AUTO_CHECK_THROTTLE_MS };
