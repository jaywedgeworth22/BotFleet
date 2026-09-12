# 2026-09-12 — iOS Live Activity suspension policy

Issue #294.  Board `699ea1ae`.  Branch `codex/ios-live-activity-suspend-20260912`.

## Behavior

BotFleet uses local ActivityKit updates and does not register Live Activity push tokens.  When the app enters the background, it invalidates queued foreground updates, clears its activity snapshot, and requests immediate teardown of every BotFleet Live Activity.  Returning to the foreground creates a new lifecycle generation and reconciles the current companion state only after teardown finishes.

The inactive phase keeps the current update policy because it also covers short system interruptions such as Control Center.  Only the background transition disables updates and starts teardown.

## Race handling

ActivityKit mutations run through one ordered task chain.  Each foreground update carries the generation that scheduled it and rechecks that generation around suspension points.  A stale update therefore cannot recreate an activity after background teardown, while a rapid foreground return waits for teardown and then rebuilds from current state.

## Validation

- `cd ios && swift test` — 257 tests passed.
- Local unsigned app build remains blocked because Xcode reports that iOS 26.5 is not installed.  The SDK listing is present, but no eligible device or simulator runtime is installed.
- Physical-device stale, update, end, tap, and relaunch acceptance remains open.  No paired device or production notification state was mutated.
