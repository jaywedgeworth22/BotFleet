# 2026-09-04 — Sentry Max Features (BotFleet)

Board `af1ab6e9`.  Branch `grok/sentry-max-features`.  Worktree
`~/apps/botfleet-grok-sentry-max`.

## Changes

- Node harness `profileSessionSampleRate` + optional `@sentry/profiling-node`.
- iOS profiling 0.1 + masked Session Replay (10% / 100% error).
- Web Feedback already on.  Windows SDK listed N/A (not a second project).

## Verification

- `pnpm exec vitest run src/lib/sentry.test.ts`
