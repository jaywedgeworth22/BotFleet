import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  authenticatedRuntimeError,
  DEFAULT_PORTS,
  designatedRequirementFromOutput,
  isExpectedBotFleetProcess,
  loadPrepared,
  parseArguments,
  run,
  stableApplicationProcessError,
  swapPreparedFiles,
  validateBuiltBundle,
} from "./update-botfleet-mac.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));

test("prepare and apply expose an explicit reusable stage", () => {
  assert.deepEqual(
    parseArguments(["prepare", "--target", "abc", "--source", "/tmp/source", "--stage", "/tmp/stage"]),
    {
      command: "prepare",
      target: "abc",
      source: "/tmp/source",
      stage: "/tmp/stage",
      bundle: undefined,
      dependencies: undefined,
      openApplication: true,
    },
  );
  assert.deepEqual(parseArguments(["apply", "--stage", "/tmp/stage", "--no-open"]), {
    command: "apply",
    target: "origin/main",
    source: undefined,
    stage: "/tmp/stage",
    bundle: undefined,
    dependencies: undefined,
    openApplication: false,
  });
  assert.throws(() => parseArguments(["apply"]), /requires --stage/);
  assert.throws(() => parseArguments(["update", "--unknown"]), /Unknown option/);
  assert.throws(() => parseArguments(["prepare", "--bundle", "/tmp/app"]), /supplied together/);
  assert.throws(
    () => parseArguments(["prepare", "--bundle", "/tmp/app", "--dependencies", "/tmp/deps"]),
    /requires its exact --source/,
  );
  assert.equal(
    parseArguments([
      "prepare",
      "--source", "/tmp/source",
      "--bundle", "/tmp/source/release/BotFleet.app",
      "--dependencies", "/tmp/source/node_modules",
    ]).bundle,
    "/tmp/source/release/BotFleet.app",
  );
});

test("prepared stages reject symlink directories and public manifests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "botfleet-update-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  const link = join(root, "stage-link");
  await mkdir(stage, { mode: 0o700 });
  await symlink(stage, link);
  await assert.rejects(loadPrepared(link), /must be a real directory/);

  const manifest = join(stage, "prepared.json");
  await writeFile(manifest, "{}\n", { mode: 0o600 });
  await chmod(manifest, 0o644);
  await assert.rejects(loadPrepared(stage), /must not be accessible by group or other users/);
});

test("bundle validation rejects a symlink before trusting its contents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "botfleet-update-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "BotFleet.app");
  const link = join(root, "BotFleet-link.app");
  await mkdir(bundle);
  await symlink(bundle, link);
  await assert.rejects(validateBuiltBundle(link, "b".repeat(40)), /must be a real directory/);
});

test("command results wait for output pipes to close", async () => {
  const script = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "setTimeout(() => process.stdout.write('late\\\\n'), 40)"], { stdio: ["ignore", 1, 2] });
    process.stdout.write("early\\n");
  `;
  const result = await run(process.execPath, ["-e", script]);
  assert.equal(result.stdout, "early\nlate\n");
});

test("designated requirement comparison excludes the bundle-specific executable path", () => {
  const requirement = 'designated => identifier "com.botfleet.app" and certificate leaf[subject.OU] = CC8UTF7ATG';
  const installed = `Executable=/Applications/BotFleet.app/Contents/MacOS/BotFleet\n${requirement}\n`;
  const candidate = `Executable=/Applications/.BotFleet.update-123.app/Contents/MacOS/BotFleet\n${requirement}\n`;
  assert.equal(designatedRequirementFromOutput(installed), requirement);
  assert.equal(designatedRequirementFromOutput(candidate), requirement);
});

test("production updater has no force-kill or unrelated desktop-process cleanup", async () => {
  const source = await readFile(join(scripts, "update-botfleet-mac.mjs"), "utf8");
  for (const forbidden of ["pkill", "killall", '"Dock"', '"Finder"', '"System Settings"']) {
    assert.equal(source.includes(forbidden), false, `must not contain ${forbidden}`);
  }
  assert.doesNotMatch(source, /process\.kill\([^\n]+"SIGKILL"/);
  assert.match(source, /process\.kill\(pid, "SIGTERM"\)/);
  assert.match(source, /runtime\.safeToRestart !== true/);
  assert.match(source, /runtime\.sourceCommit !== expectedBuild\.targetCommit/);
  assert.match(source, /Database ownership is ambiguous/);
});

test("process verification binds relative server commands to the live checkout cwd", () => {
  const config = { appPath: "/Applications/BotFleet.app", checkout: "/Users/test/apps/botfleet-server" };
  assert.equal(
    isExpectedBotFleetProcess("/opt/homebrew/bin/node --experimental-strip-types server/index.ts", config.checkout, config),
    true,
  );
  assert.equal(
    isExpectedBotFleetProcess("/opt/homebrew/bin/node --experimental-strip-types server/index.ts", "/tmp/decoy", config),
    false,
  );
  assert.equal(isExpectedBotFleetProcess("/usr/bin/python3 server/index.ts", config.checkout, config), false);
  assert.equal(isExpectedBotFleetProcess("/Applications/Other.app/Contents/MacOS/BotFleet", "/", config), false);
  assert.equal(isExpectedBotFleetProcess("/Applications/BotFleet.app/Contents/MacOS/BotFleet", "/", config), true);
});

test("the updater covers every desktop harness fallback port", () => {
  assert.deepEqual(DEFAULT_PORTS, [8799, 18799, 28799]);
});

test("desktop verification requires one stable installed-application process after open", () => {
  assert.equal(stableApplicationProcessError([41], [41], true), null);
  assert.match(stableApplicationProcessError([], [], true), /did not remain running/);
  assert.match(stableApplicationProcessError([41], [42], true), /did not remain running/);
  assert.equal(stableApplicationProcessError([], [], false), null);
});

test("post-start identity accepts new work while the pre-install readiness gate still refuses it", () => {
  const owner = { pid: 42, port: 8799 };
  const prepared = {
    targetCommit: "b".repeat(40),
    version: "1.0.30",
    apiVersion: 1,
    uiHash: "c".repeat(64),
  };
  const runtime = {
    app: "botfleet",
    pid: owner.pid,
    dataOwner: owner,
    sourceCommit: prepared.targetCommit,
    sourceDirty: false,
    version: prepared.version,
    apiVersion: prepared.apiVersion,
    uiHash: null,
    safeToRestart: false,
    activeWorkCount: 1,
  };
  assert.match(authenticatedRuntimeError(runtime, owner, prepared, { requireIdle: true }), /active operations/);
  assert.equal(authenticatedRuntimeError(runtime, owner, prepared, { requireIdle: false }), null);
  assert.match(
    authenticatedRuntimeError({ ...runtime, uiHash: "d".repeat(64) }, owner, prepared, { requireIdle: false }),
    /does not match the prepared application build/,
  );
});

test("packaged identity comes from the build output rather than an ambient label", async () => {
  const source = await readFile(join(scripts, "update-botfleet-mac.mjs"), "utf8");
  const builder = await readFile(join(scripts, "../electron-builder.yml"), "utf8");
  assert.match(source, /Contents\/Resources\/server\/build-identity\.json/);
  assert.match(source, /build\.sourceDirty !== false/);
  assert.match(source, /EXPECTED_SIGN_IDENTITY = "Developer ID Application: Jay Wedgeworth, LLC \(CC8UTF7ATG\)"/);
  assert.match(source, /BUILDER_SIGN_SELECTOR = "Jay Wedgeworth, LLC \(CC8UTF7ATG\)"/);
  assert.match(builder, /identity: "Jay Wedgeworth, LLC \(CC8UTF7ATG\)"/);
  assert.doesNotMatch(builder, /identity: "Developer ID Application:/);
  assert.doesNotMatch(source, /BOTFLEET_SOURCE_COMMIT:/);
});

async function swapFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "botfleet-update-swap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = {
    appPath: join(root, "BotFleet.app"),
    candidateApp: join(root, ".candidate.app"),
    rollbackApp: join(root, ".rollback.app"),
    liveDependencies: join(root, "node_modules"),
    candidateDependencies: join(root, ".candidate-node_modules"),
    rollbackDependencies: join(root, ".rollback-node_modules"),
  };
  for (const [path, marker] of [
    [paths.appPath, "old-app"],
    [paths.candidateApp, "new-app"],
    [paths.liveDependencies, "old-deps"],
    [paths.candidateDependencies, "new-deps"],
  ]) {
    await mkdir(path);
    await writeFile(join(path, "marker"), marker);
  }
  return paths;
}

test("the app and dependency tree swap together while retaining both prior copies", async (t) => {
  const paths = await swapFixture(t);
  await swapPreparedFiles(paths);
  assert.equal(await readFile(join(paths.appPath, "marker"), "utf8"), "new-app");
  assert.equal(await readFile(join(paths.liveDependencies, "marker"), "utf8"), "new-deps");
  assert.equal(await readFile(join(paths.rollbackApp, "marker"), "utf8"), "old-app");
  assert.equal(await readFile(join(paths.rollbackDependencies, "marker"), "utf8"), "old-deps");
});

test("a dependency install rename failure restores the old app and dependencies", async (t) => {
  const paths = await swapFixture(t);
  let calls = 0;
  await assert.rejects(
    swapPreparedFiles(paths, async (from, to) => {
      calls += 1;
      if (calls === 4) throw new Error("injected dependency rename failure");
      await rename(from, to);
    }),
    /injected dependency rename failure/,
  );
  assert.equal(await readFile(join(paths.appPath, "marker"), "utf8"), "old-app");
  assert.equal(await readFile(join(paths.liveDependencies, "marker"), "utf8"), "old-deps");
  assert.equal(await readFile(join(paths.candidateApp, "marker"), "utf8"), "new-app");
  assert.equal(await readFile(join(paths.candidateDependencies, "marker"), "utf8"), "new-deps");
});
