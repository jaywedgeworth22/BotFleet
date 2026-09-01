# BotFleet Effort Log — cross-agent board
Protocol: /Users/jay/apps/EFFORT-LOG-PROTOCOL.md (canonical). Live board: this file
(mirror: docs/EFFORT-LOG.md in the repo). As of 2026-08-29.

## Deployed
- [AG] 2026-08-29 — Always-on iMessage bidirectional relay daemon (`botfleet-imessage-relay`) and LaunchAgents (`com.jay.botfleet-imessage-relay` + `com.jay.botfleet-server`) connecting 12 BotFleet bot group chats in Messages.app with BotFleet backend.

## Completed
- [AG] 2026-08-30 — iOS app updates: Added Model choices, custom channel photos UI, fixed Return key, and fixed auto-scroll behavior.

## In Progress
- **2026-09-01 — AG — COMPLETED / PR OPEN — Sentry client observability: Session Replay, error capture & distributed tracing (branch `ag/sentry-observability-expansion`).**  Integrated `@sentry/react` client error monitoring, Session Replay (100% on error, 10% baseline session, privacy-masked), and distributed browser tracing in `src/lib/sentry.ts` and `src/main.tsx`. Gated on `VITE_SENTRY_DSN`. Gate: typecheck clean, 2,271/2,271 tests clean. Rollout: `docs/rollouts/2026-09-01-sentry-client-observability.md`.

## Planned / Reserved
- (none)

## Changelog of this log
- 2026-08-29 — Deployed always-on iMessage bidirectional relay for 12 BotFleet bots (AG).
- 2026-08-28 — bootstrapped by onboard-new-app.sh.
