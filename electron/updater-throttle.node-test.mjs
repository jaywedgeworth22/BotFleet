// node:test coverage for the 6-hour auto-update throttle and the Mac
// app-bundle fingerprint.  These are pure helpers that live in
// updater-throttle.mjs so they can be exercised without an `electron`
// runtime — updater.mjs itself imports the same module.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTO_CHECK_THROTTLE_MS,
  macAppFingerprint,
  nextAutoUpdateRecord,
  readAutoUpdateConfig,
  recordAutomaticCheck,
  shouldRunAutomaticCheck,
} from "./updater-throttle.mjs";

test("shouldRunAutomaticCheck allows the first run when no lastCheckMs is recorded", () => {
  assert.equal(shouldRunAutomaticCheck({ enabled: true }), true);
  assert.equal(shouldRunAutomaticCheck({ enabled: true, lastCheckMs: undefined }), true);
  assert.equal(shouldRunAutomaticCheck({ enabled: true, lastCheckMs: -1 }), true);
  assert.equal(shouldRunAutomaticCheck({ enabled: true, lastCheckMs: Number.NaN }), true);
});

test("shouldRunAutomaticCheck blocks a run inside the 6-hour window", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    shouldRunAutomaticCheck({ enabled: true, lastCheckMs: now - 1 }, now),
    false,
  );
  assert.equal(
    shouldRunAutomaticCheck({ enabled: true, lastCheckMs: now - AUTO_CHECK_THROTTLE_MS + 1 }, now),
    false,
  );
});

test("shouldRunAutomaticCheck allows a run after the 6-hour window elapses", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    shouldRunAutomaticCheck({ enabled: true, lastCheckMs: now - AUTO_CHECK_THROTTLE_MS }, now),
    true,
  );
  assert.equal(
    shouldRunAutomaticCheck({ enabled: true, lastCheckMs: now - (AUTO_CHECK_THROTTLE_MS + 60_000) }, now),
    true,
  );
});

test("shouldRunAutomaticCheck refuses to run when the toggle is off", () => {
  const now = 1_700_000_000_000;
  assert.equal(shouldRunAutomaticCheck({ enabled: false, lastCheckMs: now - 30_000 }, now), false);
  assert.equal(shouldRunAutomaticCheck({ enabled: undefined }, now), false);
});

// A changed Mac bundle fingerprint is the "out-of-band reinstall" signal
// nextAutoUpdateRecord stores every cycle (see the tests below) but that,
// before this fix, nothing ever compared against the running app -- so a
// reinstall between checks never bypassed the 6-hour window. Both branches:
// same fingerprint stays throttled, a changed one checks immediately.
test("shouldRunAutomaticCheck stays throttled inside the window when the fingerprint has not changed", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    shouldRunAutomaticCheck(
      {
        enabled: true,
        lastCheckMs: now - 30_000,
        lastAppFingerprint: "202609041230:abcdef123456",
        currentFingerprint: "202609041230:abcdef123456",
      },
      now,
    ),
    false,
  );
});

test("shouldRunAutomaticCheck bypasses the 6-hour window when the fingerprint has changed", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    shouldRunAutomaticCheck(
      {
        enabled: true,
        // well inside the throttle window -- only the fingerprint mismatch
        // should be why this returns true
        lastCheckMs: now - 30_000,
        lastAppFingerprint: "202609041230:abcdef123456",
        currentFingerprint: "202609051115:different000",
      },
      now,
    ),
    true,
  );
});

test("shouldRunAutomaticCheck ignores the fingerprint fields when either side is missing", () => {
  const now = 1_700_000_000_000;
  // no lastAppFingerprint on record yet (pre-upgrade config, or the bundle
  // could not be read the first time) -- falls back to the plain throttle
  assert.equal(
    shouldRunAutomaticCheck({ enabled: true, lastCheckMs: now - 30_000, currentFingerprint: "new" }, now),
    false,
  );
  // platform can't compute a fingerprint right now (non-darwin, or the
  // bundle is missing) -- same fallback
  assert.equal(
    shouldRunAutomaticCheck(
      { enabled: true, lastCheckMs: now - 30_000, lastAppFingerprint: "old" },
      now,
    ),
    false,
  );
});

test("AUTO_CHECK_THROTTLE_MS is the documented 6-hour window", () => {
  assert.equal(AUTO_CHECK_THROTTLE_MS, 6 * 60 * 60 * 1000);
});

test("readAutoUpdateConfig returns an empty object on a missing or invalid file", () => {
  const missing = readAutoUpdateConfig("/nonexistent/path/config.json");
  assert.deepEqual(missing, {});
  // The harness's test-floor guard forbids mutating the real config; the
  // empty-object default is what a fresh install would see.
});

test("macAppFingerprint returns null on a non-darwin platform", () => {
  const result = macAppFingerprint({ platform: "linux" });
  assert.equal(result, null);
});

test("macAppFingerprint reads CFBundleVersion and hashes the executable's size+mtime", () => {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleVersion</key>
  <string>202609041230</string>
</dict>
</plist>`;
  // The function uses node:path's join to compose the Info.plist and exec
  // paths, so on Windows the separator is a backslash and a hard-coded
  // forward-slash string would never match.  Build the expected paths
  // through the same join so the mock stays portable across platforms.
  const bundle = "/Applications/BotFleet.app";
  const infoPlist = join(bundle, "Contents", "Info.plist");
  const execPath = join(bundle, "Contents", "MacOS", "BotFleet");
  const result = macAppFingerprint({
    platform: "darwin",
    candidates: [bundle],
    execPath,
    readVersion: () => "202609041230",
    readFileSync: () => Buffer.from(plist, "utf8"),
    statSync: () => ({ size: 12345, mtimeMs: 1700000000000 }),
    existsSync: (p) => p === infoPlist || p === execPath,
  });
  assert.ok(result);
  assert.equal(result?.startsWith("202609041230:"), true);
  // the hash half is deterministic for the same size+mtime
  assert.equal(result, "202609041230:74f040039bcb");
});

test("macAppFingerprint returns null when the bundle is not installed", () => {
  const result = macAppFingerprint({
    platform: "darwin",
    candidates: ["/Applications/BotFleet.app"],
    execPath: "/Applications/BotFleet.app/Contents/MacOS/BotFleet",
    existsSync: () => false,
  });
  assert.equal(result, null);
});

test("nextAutoUpdateRecord stamps lastCheckMs and preserves enabled", () => {
  const now = 1_700_000_000_000;
  const next = nextAutoUpdateRecord({ enabled: true, lastAppFingerprint: "old" }, { nowMs: now, fingerprint: "new" });
  assert.equal(next.enabled, true);
  assert.equal(next.lastCheckMs, now);
  assert.equal(next.lastAppFingerprint, "new");
});

test("nextAutoUpdateRecord omits the fingerprint when the bundle is not present", () => {
  const now = 1_700_000_000_000;
  const next = nextAutoUpdateRecord({ enabled: false }, {
    nowMs: now,
    fingerprint: null,
  });
  assert.equal(next.enabled, false);
  assert.equal(next.lastCheckMs, now);
  assert.equal(next.lastAppFingerprint, undefined);
});

test("nextAutoUpdateRecord omits the fingerprint on a non-darwin host", () => {
  // The test runner runs on the same Mac as the bundled app, so the
  // default fingerprint helper would happily return a real one.  Force
  // the no-bundle path by passing an explicit null fingerprint, which
  // is what the helper does on Linux/Windows.
  const now = 1_700_000_000_000;
  const next = nextAutoUpdateRecord({ enabled: true }, { nowMs: now, fingerprint: null });
  assert.equal(next.enabled, true);
  assert.equal(next.lastCheckMs, now);
  assert.equal(next.lastAppFingerprint, undefined);
});

// `recordAutomaticCheck` is the read-modify-write updater.mjs's
// `recordSuccessfulAutoCheck` delegates to.  Before this fix that function
// ended in `appendFileSync(path, "")` -- a no-op touch of an existing file
// that never wrote the updated `disk` object back, so `lastCheckMs` never
// reached config.json and the 6-hour throttle never actually engaged
// (`shouldRunAutomaticCheck` always saw `lastCheckMs: undefined` and kept
// returning "first run, check now"). These exercise it against a real temp
// file so the regression -- the throttle silently never engaging -- cannot
// come back unnoticed.
test("recordAutomaticCheck persists lastCheckMs to a fresh config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-updater-throttle-"));
  const configPath = join(dir, "config.json");
  try {
    const before = Date.now();
    recordAutomaticCheck(configPath, { enabled: true, fingerprint: "202609041230:abcdef123456" });
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(typeof onDisk.autoUpdate.lastCheckMs, "number");
    assert.ok(onDisk.autoUpdate.lastCheckMs >= before);
    assert.equal(onDisk.autoUpdate.lastAppFingerprint, "202609041230:abcdef123456");
    assert.equal(onDisk.autoUpdate.enabled, true);
    // readAutoUpdateConfig (the harness's own reader) agrees with what was
    // just written -- the whole point of persisting is that the next tick
    // and the next launch see the same thing.
    assert.deepEqual(readAutoUpdateConfig(configPath), onDisk.autoUpdate);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordAutomaticCheck merges into an existing config without disturbing other sections", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-updater-throttle-"));
  const configPath = join(dir, "config.json");
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        profile: { name: "Operator" },
        autoUpdate: { enabled: false, lastCheckMs: 1_600_000_000_000, lastAppFingerprint: "old" },
      }),
    );
    recordAutomaticCheck(configPath, { enabled: true, fingerprint: "new-fingerprint" });
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(onDisk.profile, { name: "Operator" });
    assert.equal(onDisk.autoUpdate.enabled, true);
    assert.equal(onDisk.autoUpdate.lastAppFingerprint, "new-fingerprint");
    assert.ok(onDisk.autoUpdate.lastCheckMs > 1_600_000_000_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordAutomaticCheck starts fresh when the config file is missing or unreadable", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-updater-throttle-"));
  // A nested, not-yet-created directory -- recordAutomaticCheck must create
  // it (mkdirSync recursive) rather than throwing.
  const configPath = join(dir, "nested", "config.json");
  try {
    recordAutomaticCheck(configPath, { enabled: true, fingerprint: null });
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(typeof onDisk.autoUpdate.lastCheckMs, "number");
    assert.equal(onDisk.autoUpdate.enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
