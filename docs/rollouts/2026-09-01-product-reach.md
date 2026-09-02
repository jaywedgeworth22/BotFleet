# Product reach: files, iPad, iMessage, APNs, Vercel cap

Tue, Sep 1, 2026.  Owner follow-up on the delta-audit deferrals.

## Why

Killed-app wake, iPad, iMessage, chat files on every platform, a real desktop download host, and Vercel auto-deploys capped at one production build per hour.

## What

- Chat `POST /api/attachments` accepts ordinary files (pdf, zip, office, audio/video, text) as well as images.  Pathless desktop drops upload instead of asking the user to save first.
- Companion stores APNs device tokens and wakes disconnected phones when the harness emits `notify`.  Uses `APNS_P8_PATH` (default `~/.secrets/AuthKey_N3949G7CN6.p8`), team `CC8UTF7ATG`, bundle `app.botfleet`.
- `POST /api/desktop/open` runs `open -a BotFleet` so the phone can bring the Mac app forward.
- `com.jay.botfleet-imessage-relay` LaunchAgent loaded (Xcode Python.app).  Packaged artifacts live at `jaywedgeworth22/botfleet-releases` v0.1.38 (`BotFleet.dmg`).
- Vercel `commandForIgnoringBuildStep` skips preview auto-deploys and caps production at one per hour.  `VERCEL_FORCE_DEPLOY=1` or Dashboard Redeploy (ignore step unchecked) still ships immediately.

## Verify

```
pnpm exec vitest run server/attachments.test.ts companion/src/apns.test.ts src/lib/intake-files.test.ts
launchctl print gui/$(id -u)/com.jay.botfleet-imessage-relay
curl -sI https://github.com/jaywedgeworth22/botfleet-releases/releases/latest/download/BotFleet.dmg
```
