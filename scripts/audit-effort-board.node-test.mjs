import assert from "node:assert/strict";
import test from "node:test";
import { auditEffortBoard } from "./audit-effort-board.mjs";

test("links derivative candidates without promoting PR references to completion or deployment", () => {
  const root = { id: "root", app: "botfleet", source_kind: "agent-report", title: "Recover credentials for standalone custom engines", status: "in_progress", addressed_by: "CLAUDE", description: "Introduced by PR #10" };
  const derivative = { id: "derivative", app: "botfleet", source_kind: "effort-row", title: "CODEX — COMPLETED — Recover credentials for standalone custom engines", status: "in_progress" };
  const input = { board: [root, derivative], issues: [{ number: 9, body: "Canonical board item root" }], mergedPullRequests: [{ number: 10, mergedAt: "2026-09-12", mergeCommit: { oid: "a".repeat(40) } }] };
  const before = structuredClone(input);
  const report = auditEffortBoard(input);
  assert.equal(report.mode, "audit-only");
  assert.equal(report.snapshot.open, 2);
  assert.deepEqual(report.links[0].candidateRootIds, ["root"]);
  assert.ok(report.findings.some((finding) => finding.kind === "terminal-text-open-status"));
  assert.ok(report.findings.some((finding) => finding.kind === "merged-reference-needs-scope-review" && finding.owner === "CLAUDE"));
  assert.deepEqual(input, before);
});

test("deployment needs a surface receipt; descriptions and merge hashes are insufficient", () => {
  const board = [{ id: "a", app: "botfleet", source_kind: "agent-report", title: "Deployed PR #10", status: "deployed" }];
  const base = { board, issues: [], mergedPullRequests: [] };
  assert.ok(auditEffortBoard(base).findings.some((finding) => finding.kind === "deployed-without-surface-receipt"));
  assert.ok(!auditEffortBoard({ ...base, deployments: [{ boardId: "a", surface: "Mac", observedAt: "2026-09-12", commit: "abc", receipt: "Verified runtime identity" }] }).findings.some((finding) => finding.kind === "deployed-without-surface-receipt"));
});

test("rejects invalid snapshots and does not copy private URLs into the report", () => {
  const row = { id: "a", app: "botfleet", source_kind: "agent-report", title: "Check https://host.invalid/capability/secret", status: "open" };
  const base = { board: [row], issues: [], mergedPullRequests: [] };
  assert.ok(!JSON.stringify(auditEffortBoard(base)).includes("capability/secret"));
  assert.throws(() => auditEffortBoard({ ...base, board: [row, row] }), /duplicate/);
  assert.throws(() => auditEffortBoard({ ...base, board: [{ ...row, app: "another-app" }] }), /foreign/);
});
