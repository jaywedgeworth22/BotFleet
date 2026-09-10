# 2026-09-09 — Same-Source Re-Fires Append; Auto Instructions Are Not User Bubbles

Seat: BF-FIXER.  Branch `fixer/thread-append-auto-role`.  Worktree `~/apps/botfleet-fixer-thread-append`.  Board `3d9ff839`.

## Why

Same webhook or the same routine was minting a new chat on every fire.  Auto-delivered instructions (calendar ticks, webhooks, resource samples) rendered as blue iOS user bubbles because they were stored as `role: "user"`.

Designer owns the duplicate "Bot Chats" sidebar section (#1).  This lane is #2 and #3 only.

## What changed

- Each webhook / resource / routine has a durable `automationKey` on the task (`webhook:<id>` or `routine:<id>`).  A re-fire looks that key up first, then run history, and only then mints a task.  `createTask` with a matching key returns the existing task.
- Simple mode still writes into the bot's oldest conversation when no keyed task exists, and stamps that thread so a newly selected empty chat is not used.
- Auto-delivered prompts are stored as `role: "system"`.  The model still receives them as the turn prompt.  Desktop and iOS render a left-edge work card, not a blue bubble.  Older webhook rows that used `role: "user"` still parse into the existing card.  Phones that lack `system` decode it as `.bot` (left, not blue).

## Verify

```bash
pnpm exec vitest run server/store.test.ts server/routines.test.ts src/lib/replies.test.ts
cd ios && swift test --filter DecodingTests
```

No TestFlight from this seat.  Mac app needs `update-botfleet.sh` after merge.

## Follow-ups

- Designer: duplicate Bot Chats sidebar (PR after #243).
- Ping Designer for a UI pass on the system-instruction card chrome.
