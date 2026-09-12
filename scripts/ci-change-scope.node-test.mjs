import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { classifyCIPaths } from "./ci-change-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("only the explicit non-executable documentation paths take the fast path", () => {
  assert.deepEqual(classifyCIPaths(["docs/EFFORT-LOG.md", "docs/audits/findings.json"]), {
    changedCount: 2,
    docsOnly: true,
  });
  assert.equal(classifyCIPaths(["README.md", "SECURITY.md"]).docsOnly, true);

  for (const path of [
    "src/App.tsx",
    "ios/project.yml",
    "package.json",
    "pnpm-lock.yaml",
    "LICENSE",
    "NOTICE",
    "docs/secrets.md",
    ".github/workflows/ci.yml",
    "scripts/release.mjs",
  ]) {
    assert.equal(classifyCIPaths([path]).docsOnly, false, path);
  }

  assert.equal(classifyCIPaths(["docs/EFFORT-LOG.md", "server/index.ts"]).docsOnly, false);
  assert.equal(classifyCIPaths([]).docsOnly, false);
});

test("the CLI emits only GitHub outputs for a NUL-delimited path list", () => {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts/ci-change-scope.mjs")], {
    cwd: ROOT,
    input: Buffer.from("docs/EFFORT-LOG.md\0README.md\0"),
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "docs_only=true\nchanged_count=2\n");
});

test("every protected check stays present and takes the same fail-closed scope output", () => {
  const workflow = parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"));
  const requiredJobs = ["test", "control-plane", "package-linux", "ios"];

  assert.equal(Object.hasOwn(workflow.on, "workflow_dispatch"), true);
  assert.equal(Object.hasOwn(workflow.on, "schedule"), true);
  assert.equal(workflow.jobs.changes.outputs.docs_only, "${{ steps.scope.outputs.docs_only }}");

  const classifier = workflow.jobs.changes.steps.find((step) => step.id === "scope");
  assert.match(classifier.run, /EVENT_NAME.*!= "push".*EVENT_NAME.*!= "pull_request"/s);
  assert.match(classifier.run, /echo "docs_only=false"/);
  assert.match(classifier.run, /BASE_SHA.*\^\[0-9a-f\]\{40\}\$/);

  for (const jobId of requiredJobs) {
    const job = workflow.jobs[jobId];
    assert.equal(job.needs, "changes", jobId);
    assert.equal(job.if, "${{ !cancelled() }}", jobId);

    const fastPath = job.steps.find((step) => step.name === "Documentation-only fast path");
    assert.equal(fastPath.if, "needs.changes.outputs.docs_only == 'true'", jobId);

    for (const step of job.steps.filter((candidate) => candidate !== fastPath)) {
      assert.match(step.if, /needs\.changes\.outputs\.docs_only != 'true'/, `${jobId}: ${step.name ?? step.run ?? step.uses}`);
    }
  }

  const source = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(source, /git diff --no-renames --name-only -z/);
  assert.doesNotMatch(source, /paths-ignore:/);
});

test("the weekly full run is registered with the Sentry cron reporter", () => {
  const workflow = parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"));
  const schedule = workflow.on.schedule[0].cron;
  const maxJobTimeout = Math.max(
    ...Object.values(workflow.jobs).map((job) => job["timeout-minutes"] ?? 0),
  );
  const probe = spawnSync(
    "python3",
    [
      "-c",
      [
        "import importlib.util,json,pathlib",
        "p=pathlib.Path('scripts/sentry-ci-report.py')",
        "s=importlib.util.spec_from_file_location('sentry_ci_report', p)",
        "m=importlib.util.module_from_spec(s)",
        "s.loader.exec_module(m)",
        "print(json.dumps({'schedules':m.CRON_SCHEDULES,'margins':m.CRON_CHECKIN_MARGIN_OVERRIDES}))",
      ].join(";"),
    ],
    { cwd: ROOT, encoding: "utf8" },
  );

  assert.equal(probe.status, 0, probe.stderr);
  const reporter = JSON.parse(probe.stdout);
  assert.equal(reporter.schedules.CI, schedule);
  assert.ok(reporter.margins.CI >= maxJobTimeout + 15);
});
