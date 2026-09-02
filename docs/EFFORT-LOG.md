# BotFleet Effort Log — cross-agent board
Protocol: /Users/jay/apps/EFFORT-LOG-PROTOCOL.md (canonical). Live board: this file
(mirror: docs/EFFORT-LOG.md in the repo). As of 2026-08-29.

## Deployed
- [AG] 2026-08-29 — Always-on iMessage bidirectional relay daemon (`botfleet-imessage-relay`) and LaunchAgents (`com.jay.botfleet-imessage-relay` + `com.jay.botfleet-server`) connecting 12 BotFleet bot group chats in Messages.app with BotFleet backend.

## Completed
- [AG] 2026-08-31 — Sentry client observability: Session Replay, error capture & distributed tracing (PR #44 merged to `main`). Integrated `@sentry/react` client error monitoring, Session Replay (100% on error, 10% baseline session, privacy-masked), and distributed browser tracing in `src/lib/sentry.ts` and `src/main.tsx`. Gated on `VITE_SENTRY_DSN`. Gate: typecheck clean, 2,271/2,271 tests clean. Rollout: `docs/rollouts/2026-09-01-sentry-client-observability.md`.
- [AG] 2026-08-30 — iOS app updates: Added Model choices, custom channel photos UI, fixed Return key, and fixed auto-scroll behavior.

## In Progress
- **2026-09-01 — GROK — IN PROGRESS — Pickup CLAUDE cap: BotFleet analysis v2 (`claude/analysis-v2`, `~/apps/botfleet-claude`).**  Board `781554fd`.  PR #97.  Report `docs/audits/2026-09-01-botfleet-analysis-v2.md`.  Raw 238 / Claude tech-confirmed 144 / unique P0 still open 5.  No product code.
- **2026-09-01 — GROK — IN PROGRESS — Delta-audit Batch 2: iOS ATS rollback + light-first + iOS truth (branch `grok/delta-audit-ios`, worktree `~/apps/botfleet-grok-delta-ios`).**  Board `95e445e5` `a9683ae2`.  Remove `NSAllowsArbitraryLoads` and `botfleet.app` cleartext; keep local networking + `ts.net`; `preferredColorScheme(.light)`; no APNs.  I2 chat image composer remains a documented gap.  GROK note 2026-09-01: ATS rollback landed as #92 on main; this row is the remaining iOS-truth slice.
- **2026-09-01 — GROK — IN PROGRESS — Sentry fleet adoption: Vercel `VITE_SENTRY_DSN`, User Feedback widget, harness gen_ai agent spans (conversation/tool/model/tokens/errors, no prompts) (branch `grok/sentry-fleet-adoption`, worktree `~/apps/botfleet-grok-sentry-adopt`).**  Board `d99cee7f21ad4a2ba6f74b50c85fda04`.  Rollout: `docs/rollouts/2026-09-01-sentry-fleet-adoption.md`.
- **2026-09-01 — GROK — IN PROGRESS — Resource-threshold triggers that wake a bot (`grok/resource-triggers`).**  Board `3cd995b0`.  Worktree `~/apps/botfleet-grok-resource-triggers`.  Automations → Resources tab; disk/RAM/CPU sampler; same queue as webhooks.  Live Housekeeper webhook already created on 8799.
- **2026-09-01 — AG — IN PROGRESS — iOS Native Sentry Cocoa telemetry, crash reporting, and app-hang detection (branch `ag/ios-sentry-cocoa-expansion`).**  Integrates native Sentry Cocoa SDK into BotFleet iOS Companion: added Sentry Cocoa SPM package dependency, implemented `SentryTelemetry.swift` for crash reporting, 2.0s app-hang detection, and 0.2 distributed tracing, and wired into `CompanionApp.init()`. Gate: xcodegen clean, SPM resolved, typecheck clean. Rollout: `docs/rollouts/2026-09-01-ios-sentry-cocoa-expansion.md`.

## Planned / Reserved
- (none)

## Changelog of this log
- 2026-09-01 — GROK picked up CLAUDE analysis v2 (`781554fd`) after the finder journal died at verify/synthesis.  Report-only.
- 2026-08-29 — Deployed always-on iMessage bidirectional relay for 12 BotFleet bots (AG).
- 2026-08-28 — bootstrapped by onboard-new-app.sh.
