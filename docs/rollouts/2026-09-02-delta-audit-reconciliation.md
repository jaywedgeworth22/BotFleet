# Rollout — Delta Audit reconciliation, main repair, fixer wave

**Why:** Owner asked for a top-to-bottom analysis and then for the P0/P1 concerns to be handled.  Main had gone red overnight.

**What:** `docs/audits/2026-09-02-delta-audit-reconciliation.md` (concur/dispute on every Delta Audit claim, new findings, revised batches), a fleet-compliant `AGENTS.md` (seat-agnostic tags, THE BOARD CLI, effort logs, Apple Notes, copy rules, Mac processes, iOS loop, verification gate), and the effort-log mirror.  Code changes are in their own PRs: #130 (main repair) and the wave branches `claude/harness-ops`, `claude/automation-runs`, `claude/site-truth`, `claude/off-fleet-defaults`, `claude/trust-boundaries`, `claude/computer-tests`.

**Verified:** docs only in this PR.  Facts in § 18 were checked by hand on Sep 1-2 (launchctl, lsof, curl, GitHub API, Vercel CLI).

**Follow-ups:** wave 2 (`phone-migration`, `ios-ci`, `mcp-fleet-tools`, `webui-light`), and the owner actions listed in the wave PRs (upload `latest-mac.yml`, deploy a fleet-owned Composio broker, re-auth `gh` on the Mac).
