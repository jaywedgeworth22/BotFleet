---
name: mac-cleanup
description: Optimize Mac workstation and Hetzner Coolify disk space, prune merged git worktrees across all apps, clean Xcode symbols/simulators, and flush package caches. Use when checking disk health or optimizing local storage.
---

# Mac & Hetzner Disk Cleanup Skill (ALL AGENTS)

> **Shared `~/.claude/skills`.** Monet, Claude/Fable, and (when active) Renoir all load this directory.  Do not treat the word Monet in examples as proof of your seat.  Pin `AGENT_SEAT` / `AGENT_TAG` from the logged-in account before Slack or `board --by`:
> - Monet → `MONET`, Notes `Monet`, `monet/`, `~/apps/<app>-monet`
> - Claude / Fable → `CLAUDE`, Notes `Claude`, `claude/`, `~/apps/<app>-claude`
> - Renoir → `RENOIR`, Notes `Renoir`, `renoir/`, `~/apps/<app>-renoir`
> Cursor, Grok, Grok Bot, Codex, AG, DeepSeek, Kimi, and Fx have their own skill dirs and must not take identity from here.


Optimize local workstation storage and remote Coolify server disk usage by running the unified automated maintenance sweep.

## How to Run the Cleanup

### 1. Direct Command (All Platforms)
Any agent (Antigravity, Grok, Claude, Cursor, Codex) or operator can execute the unified cleanup script directly:

```bash
bash /Users/jay/apps/mac-auto-cleanup.sh
```

Or using the CLI shortcut (available in `zsh` and `bash`):
```bash
mac-auto-cleanup
```

### 2. What It Cleans (Safe & Idempotent)

1. **Merged Git Worktrees**:
   - Owned by `com.jay.disk-janitor` (clean + idle + no `--force`).  This script does not reap worktrees or wipe `~/.grok/worktrees`.
2. **Xcode Developer Caches**:
   - Cleans `~/Library/Developer/Xcode/iOS DeviceSupport` symbols.
   - Cleans `~/Library/Developer/Xcode/DerivedData` build caches.
   - Prunes unavailable simulators only (`xcrun simctl delete unavailable`).  Never `rm -rf` `CoreSimulator/Devices`.
3. **Package Manager Caches**:
   - `npm cache clean --force` and `~/.npm/_npx`
   - `pnpm store prune`
   - `yarn cache clean`
   - `brew cleanup -s`
4. **Spotlight PipelineStorage Journals**:
   - Truncates oversized Apple Intelligence / CoreSpotlight `PipelineStorage` journals.
5. **Agent Session Transcripts**:
   - Prunes Grok session transcripts older than 7 days (`~/.grok/sessions`).
   - Prunes old Codex archived sessions (`~/.codex/archived_sessions`).
   - Prunes old Antigravity brain conversation folders older than 7 days (`~/.gemini/antigravity/brain`).
6. **Remote Hetzner Coolify Server (`167.233.254.55`)**:
   - Automatically triggers remote Docker cleanup (`docker builder prune -af --filter "until=72h"` and `docker system prune -af --volumes`).

## Scheduled Automation
- **Mac LaunchAgent**: `~/Library/LaunchAgents/com.jay.mac-cleanup.plist` runs automatically every 4 hours (`StartInterval: 14400`).
- **Hetzner Cron**: `/etc/cron.d/coolify-maintenance` runs automatically every 4 hours.

## Quick Status Check
To view live disk space and system process health:
```bash
ms
# or
bash ~/apps/mac-status.sh
```
