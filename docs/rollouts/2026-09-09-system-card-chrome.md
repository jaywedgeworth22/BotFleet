# 2026-09-09 — System-Instruction Card Chrome

## Context & Objective

Fixer PR #299 stores auto-delivered routine / webhook / iMessage prompts as `role=system` and renders them as a left-edge work card (`WebhookCard` / `ChannelEventCard`), not a blue user bubble.  Designer UI-pass: Title Case chrome, no coordinator-speak, light-first surfaces.

Stacked on `fixer/thread-append-auto-role`.  Extra-ship no.  No TestFlight.  Do not bounce live BotFleet.

## Changes Made

- Desktop `WebhookCard`: always-padded inset card (`bg-card` + hairline), Details/Collapse Title Case accent, non-expandable is a div not a disabled button, payload recessed `bg-inset`.
- Routine fallback headline is **Scheduled Run** (not the first 120 characters of the prompt, not "Instructions").  Subtitle is the first line or **Routine**.  Details noun is **Run Details**.
- Reply quote author for `role=system` is **Scheduled Run**.
- iOS `ChannelEventCard`: skip avatar on `.system`, light `secondarySystemBackground` fill, accent Details (no capsule chip), non-expandable is not a disabled button, maxWidth 580.

## Verification

```
pnpm typecheck
./node_modules/.bin/vitest run src/lib/replies.test.ts src/lib/webhook-message.test.ts
```

Unsigned iOS `xcodebuild` when the local SDK is present.  No TestFlight.  Live BotFleet was not rebuilt.

## Next

Fixer: merge `grok/system-card-chrome` into `fixer/thread-append-auto-role` so #299 ships with this chrome.  Mac app still needs `update-botfleet.sh` after #299 lands; ask Jay first.
