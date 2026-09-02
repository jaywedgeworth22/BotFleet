# BotFleet Effort Log — cross-agent board
Protocol: /Users/jay/apps/EFFORT-LOG-PROTOCOL.md (canonical). Live board: this file
(mirror: docs/EFFORT-LOG.md in the repo). As of 2026-08-29.

## Deployed
- [AG] 2026-08-29 — Always-on iMessage bidirectional relay daemon (`botfleet-imessage-relay`) and LaunchAgents (`com.jay.botfleet-imessage-relay` + `com.jay.botfleet-server`) connecting 12 BotFleet bot group chats in Messages.app with BotFleet backend.

## Completed
- **2026-09-01 — GROK — COMPLETED — Resource-threshold triggers that wake a bot (`grok/resource-triggers`).**  Board `3cd995b0`.  Merged as #65 / #80.  GROK correction 2026-09-01: this row was still In Progress on the repo mirror after merge; moved in place, not deleted.
- **2026-09-01 — AG — COMPLETED — iOS Native Sentry Cocoa telemetry, crash reporting, and app-hang detection (branch `ag/ios-sentry-cocoa-expansion`).**  PR #55 merged.  GROK correction 2026-09-01: this row was still In Progress on the repo mirror after merge; moved in place, not deleted.  Rollout: `docs/rollouts/2026-09-01-ios-sentry-cocoa-expansion.md`.
- [AG] 2026-08-31 — Sentry client observability: Session Replay, error capture & distributed tracing (PR #44 merged to `main`). Integrated `@sentry/react` client error monitoring, Session Replay (100% on error, 10% baseline session, privacy-masked), and distributed browser tracing in `src/lib/sentry.ts` and `src/main.tsx`. Gated on `VITE_SENTRY_DSN`. Gate: typecheck clean, 2,271/2,271 tests clean. Rollout: `docs/rollouts/2026-09-01-sentry-client-observability.md`.
- [AG] 2026-08-30 — iOS app updates: Added Model choices, custom channel photos UI, fixed Return key, and fixed auto-scroll behavior.

## In Progress
- **2026-09-01 - GROK - IN_PROGRESS - Implement 2026-09-01 delta audit batches. Worktree ~/apps/botfleet-grok-delta @ grok/delta-audit-fixes.**  Board `9e922f65`.  This seat owns Batch 4 + 6 honesty/docs/ops (site CTA, README fork copy, SECURITY.md, Composio closed registration, effort-log hygiene).
- **2026-09-01 — GROK — IN PROGRESS — Sentry fleet adoption: Vercel `VITE_SENTRY_DSN`, User Feedback widget, harness gen_ai agent spans (conversation/tool/model/tokens/errors, no prompts) (branch `grok/sentry-fleet-adoption`, worktree `~/apps/botfleet-grok-sentry-adopt`).**  Board `d99cee7f21ad4a2ba6f74b50c85fda04`.  Rollout: `docs/rollouts/2026-09-01-sentry-fleet-adoption.md`.

## Planned / Reserved
- (none)

## Changelog of this log
- 2026-09-01 — GROK moved resource-triggers (#65/#80) and iOS Sentry Cocoa (#55) from In Progress to Completed after merge.  Added delta-audit Batch 4+6 claim on `grok/delta-audit-fixes`.
- 2026-08-29 — Deployed always-on iMessage bidirectional relay for 12 BotFleet bots (AG).
- 2026-08-28 — bootstrapped by onboard-new-app.sh.
