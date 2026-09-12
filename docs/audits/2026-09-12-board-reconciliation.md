# Board Reconciliation — September 12, 2026

## Observed Baseline

A complete read with `board list --app botfleet --limit 2000 --json` returned 511 rows: 179 open/in progress, 325 completed, six deployed, and one duplicate.  The CLI defaults to 60 rows; that page is not a count of the backlog.  The snapshot had 198 root records and 313 derivative effort rows, compared with 59 GitHub issues and 267 merged PRs.

The audit-only report flags 86 open derivative candidates, nine open rows whose titles say completed/merged, 32 root rows missing an exact canonical issue-body link, 30 merged-PR references needing scope review, and six deployed rows without a supplied surface receipt.  These are review candidates, not 163 independently confirmed product bugs.  A PR linked as the origin of a bug does not establish that it fixed that bug; no automatic completion or deployment inference is made.

## Applied Corrections

Ten CODEX historical effort records were checked against the already completed canonical board items and merged PRs #314, #316, and #324.  One status was corrected to Completed and nine superseded records were marked Duplicate with canonical links; all records and original ownership fields remain.  No GitHub issue was closed by these derivative corrections, and no deployment status was assigned.  A later independent 518-row read confirmed all ten corrected statuses persisted.

| Derivative Board ID | Corrected Status | Canonical Source PR |
|---|---|---|
| `00471be04e2e461f99218e0e42319172` | completed | #324 (`c9807099`) |
| `891dd53837e94a16bf8a528efe746a0c` | duplicate | #324 (`c9807099`) |
| `ba77f7d1af4d4cab8248dc3d6afa8dab` | duplicate | #324 (`c9807099`) |
| `622d2ff60e254acfad938f168d7e138d` | duplicate | #324 (`c9807099`) |
| `34148bdf8d4f49e4bf7a1d18150af050` | duplicate | #316 (`7ae5c8c1`) |
| `223cb67d726c473a9183aed01303cff3` | duplicate | #316 (`7ae5c8c1`) |
| `cd707b0d3a884a7bb219287ae0dcc132` | duplicate | #314 (`86410c70`) |
| `31d40e9b2ad7433b9e2ce00fa589f334` | duplicate | #314 (`86410c70`) |
| `c91ce9ead277433eb49af11e1e532a8a` | duplicate | #314 (`86410c70`) |
| `7b387ff9900c4636a2a4d64e58362396` | duplicate | #314 (`86410c70`) |

A second pass retired 48 exact effort mirrors as Duplicate.  Each had one `wb-agent-report` marker pointing to an existing canonical record and copied that record's task title.  This provenance establishes a duplicate view of the same task without inferring its completion; canonical statuses and ownership remained unchanged, including active work.  Ambiguous title-only or broader-scope entries remain review candidates.

Seven owned live effort bullets were also placed under their actual In Progress/Completed sections without changing their text.  The synchronizer uses section headings, not the inline status words.  Appending an active claim below Changelog hides it from that parser; leaving a Completed paragraph under In Progress reopens its derivative.  All unrelated peer rows were retained.

## Newly Revalidated Product Work

The review found existing reports that still match current source, so they now have explicit canonical GitHub issues: #341 (packaged diagnostics opt-out), #342 (environment clearing), and #343 (duplicate failed-turn Sentry capture).  The active diagnostics lane owns their fixes.  Local VM deletion/mode-switch exclusion (#345) and fleet Auto-confirmation scope (#346) were also revalidated and given separate linked issues.  The implementation and release acceptance remain open; this reconciliation does not mark these product defects fixed.

## Repeatable Audit

Run `node scripts/audit-effort-board.mjs BOARD.json ISSUES.json MERGED_PRS.json [DEPLOYMENTS.json]`.  Inputs are explicit snapshots; the tool contains no network client, credentials, or writeback mode.  Optional deployment receipts must identify a board record, surface, observed time, commit, and receipt.  The report retains ownership, redacts URLs from titles, and rejects foreign-app or duplicate-ID snapshots.

`node --test scripts/audit-effort-board.node-test.mjs` passes three behavior tests, including nonmutation, source-versus-deployment separation, and URL redaction.  The on-demand helper is registered in the Mac process inventory and its pinned Coding note.  Current PR/build receipts and physical-device acceptance must still be checked before further corrections.

The required local typecheck passed.  The full Vitest run passed 3,560 tests but two fixture servers missed their startup deadlines under heavy Mac load; both affected suites then passed alone (six tests), and every remaining chained suite passed.  These were empty-stderr startup failures, not product assertion failures.  Hosted acceptance remains pending.
