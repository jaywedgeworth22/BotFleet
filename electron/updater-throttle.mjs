// Pure helpers extracted from updater.mjs so the 6-hour throttle, the Mac
// app fingerprint, and the auto-check decision can be unit-tested without
// importing the `electron` package (which only exists in the packaged
// runtime — the test runner is plain Node).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const AUTO_CHECK_THROTTLE_MS = 6 * 60 * 60 * 1000;

/** The harness- and electron-side read of the persisted autoUpdate config.
 * Always returns an object; a missing file or invalid JSON is "no
 * information", which is the same as the user never having enabled
 * automatic updates. */
export function readAutoUpdateConfig(configPath) {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return parsed?.autoUpdate ?? {};
  } catch {
    return {};
  }
}

/** True when an automatic check is allowed to run right now.  Manual checks
 * bypass this entirely and must not consult it. */
export function shouldRunAutomaticCheck(config, nowMs = Date.now()) {
  if (config?.enabled !== true) return false;
  const last = config?.lastCheckMs;
  if (typeof last !== "number" || !Number.isFinite(last) || last < 0) return true;
  return nowMs - last >= AUTO_CHECK_THROTTLE_MS;
}

/** Extract the CFBundleVersion (the per-build counter the pipeline writes
 * on every ship) from a raw Info.plist XML.  Matches the format
 * electron-builder produces; we don't ship a plist parser dependency
 * because the relevant field is a flat string. */
function extractCFBundleVersion(plistText) {
  const match = plistText.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/);
  return match ? match[1].trim() : null;
}

/** Compute a short fingerprint of the running Mac app bundle so a
 * reinstall that landed an out-of-band build between checks still shows
 * up as "different from last known" on the next cycle.  Returns null on
 * a non-darwin platform, when the app is not installed, or when the
 * bundle cannot be read — that is a legitimate answer and the timer
 * just won't have anything to compare against.
 *
 * `options` lets tests pass a custom CFBundleVersion reader and stat
 * provider so they do not have to write a real Info.plist to disk. */
export function macAppFingerprint(options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") return null;
  const readVersion = options.readVersion ?? extractCFBundleVersion;
  const statSyncFn = options.statSync ?? statSync;
  const existsSyncFn = options.existsSync ?? existsSync;
  const readFileSyncFn = options.readFileSync ?? readFileSync;
  const candidates = options.candidates ?? [
    "/Applications/BotFleet.app",
    join(options.home ?? process.env.HOME ?? "", "Applications", "BotFleet.app"),
  ];
  let infoPlist = null;
  for (const candidate of candidates) {
    const path = join(candidate, "Contents", "Info.plist");
    if (existsSyncFn(path)) {
      infoPlist = path;
      break;
    }
  }
  if (!infoPlist) return null;
  let infoPlistBytes;
  try {
    infoPlistBytes = readFileSyncFn(infoPlist);
  } catch {
    return null;
  }
  const plistText = infoPlistBytes.toString("utf8");
  const version = readVersion(plistText) ?? "unknown";
  const execPath = options.execPath ?? join("/Applications/BotFleet.app", "Contents", "MacOS", "BotFleet");
  let size = 0;
  let mtime = 0;
  if (existsSyncFn(execPath)) {
    try {
      const stats = statSyncFn(execPath);
      size = stats.size;
      mtime = Math.floor(stats.mtimeMs);
    } catch {
      /* leave at 0 */
    }
  }
  const execHash = createHash("sha1").update(`${size}:${mtime}`).digest("hex").slice(0, 12);
  return `${version}:${execHash}`;
}

/** Compose a fresh autoUpdate record.  The caller is responsible for
 * merging it into the existing config (other fields like `enabled` must
 * not be lost).  `options.fingerprint` may be a string, `null` (skip
 * the fingerprint), or `undefined` (compute a fresh one). */
export function nextAutoUpdateRecord(currentRecord, options = {}) {
  const next = { ...(currentRecord ?? {}) };
  next.lastCheckMs = options.nowMs ?? Date.now();
  if (options.fingerprint === null) {
    /* explicit skip — caller knows there is no bundle to read */
  } else if (typeof options.fingerprint === "string") {
    next.lastAppFingerprint = options.fingerprint;
  } else {
    const fingerprint = macAppFingerprint();
    if (fingerprint) next.lastAppFingerprint = fingerprint;
  }
  return next;
}
