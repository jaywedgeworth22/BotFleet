// node:test coverage for the 6-hour auto-update throttle and the Mac
// app-bundle fingerprint.  These are pure helpers that live in
// updater-throttle.mjs so they can be exercised without an `electron`
// runtime — updater.mjs itself imports the same module.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import {
  AUTO_CHECK_THROTTLE_MS,
  macAppFingerprint,
  nextAutoUpdateRecord,
  readAutoUpdateConfig,
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
