# BotFleet Effort Log — cross-agent board
- **2026-09-01 — GROK — IN PROGRESS — Sentry DSN hygiene: no hardcoded iOS fallback (branch `grok/sentry-dsn-hygiene`, worktree `~/apps/botfleet-grok-sentry-dsn`).**  Board `aecc129faf6842b480b229ca92b143dc`.  Cocoa init is plist-only / build-injected; empty DSN = no-op.
Protocol: /Users/jay/apps/EFFORT-LOG-PROTOCOL.md (canonical). Live board: this file
(mirror: docs/EFFORT-LOG.md in the repo). As of 2026-08-29.

## Deployed
- [AG] 2026-08-29 — Always-on iMessage bidirectional relay daemon (`botfleet-imessage-relay`) and LaunchAgents (`com.jay.botfleet-imessage-relay` + `com.jay.botfleet-server`) connecting 12 BotFleet bot group chats in Messages.app with BotFleet backend.

## Completed
- **2026-09-01 — GROK — COMPLETED — Delta-audit Batch 2: iOS ATS rollback + light-first (PR #92).**  Board `95e445e5`.  I2 chat image composer remains a documented gap (`a9683ae2`).
- **2026-09-01 — GROK — COMPLETED — Delta-audit Batch 3: Electron window-open allowlist + open-file confinement (PR #91).**  Board `6c38e297`.
- **2026-09-01 — GROK — COMPLETED — Resource-threshold triggers that wake a bot (`grok/resource-triggers`).**  Board `3cd995b0`.  Merged as #65 / #80.  GROK correction 2026-09-01: this row was still In Progress on the repo mirror after merge; moved in place, not deleted.
- **2026-09-01 — AG — COMPLETED — iOS Native Sentry Cocoa telemetry, crash reporting, and app-hang detection (branch `ag/ios-sentry-cocoa-expansion`).**  PR #55 merged.  GROK correction 2026-09-01: this row was still In Progress on the repo mirror after merge; moved in place, not deleted.  Rollout: `docs/rollouts/2026-09-01-ios-sentry-cocoa-expansion.md`.
- [AG] 2026-09-01 — Automatic model failover on quota/session limits, Gemini/Antigravity harness full tool & computer execution, and shared Qdrant Agent RAG integration (branch `ag/model-failover-gemini-qdrant-rag`). Enables automatic fallback model switching on session limits/quotas/errors, unlocks local computer control and full tool loading for Antigravity & Gemini ACP harnesses, adds shared Qdrant stdio MCP proxy with semantic vector search/store, and exposes Qdrant Agent RAG custom settings in App Settings. Gate: typecheck clean, driver test suites clean, build clean.
- [AG] 2026-09-01 — iOS fallback provider dropdowns, DeepSeek harness GUI availability & blue logo, and Antigravity logo separation (branch `ag/ios-fallback-provider-deepseek-logos`). Adds Provider and Model pickers for every fallback row in iOS Agent Profile, fixes AntigravityMark in ProviderMark, ensures DeepSeek harness (dsh) is discoverable in GUI with official blue whale logo. Gate: Swift tests clean, typecheck clean, build clean.
- [AG] 2026-08-31 — Sentry client observability: Session Replay, error capture & distributed tracing (PR #44 merged to `main`). Integrated `@sentry/react` client error monitoring, Session Replay (100% on error, 10% baseline session, privacy-masked), and distributed browser tracing in `src/lib/sentry.ts` and `src/main.tsx`. Gated on `VITE_SENTRY_DSN`. Gate: typecheck clean, 2,271/2,271 tests clean. Rollout: `docs/rollouts/2026-09-01-sentry-client-observability.md`.
- [AG] 2026-08-30 — iOS app updates: Added Model choices, custom channel photos UI, fixed Return key, and fixed auto-scroll behavior.

## In Progress
- **2026-09-02 — BF-PLUMBER — IN PROGRESS — Live-test BotFleet engines + official quota-chip corpus (branch `grok/quota-chip-corpus`, worktree `~/apps/botfleet-plumber-quota-corpus`).**  Board `a59fcff2`.  Expand matcher to Codex/Cursor/Claude/Gemini/Kimi/DeepSeek official chips.  Near-cap alert: `@Plumber near-cap <engine>`.  <!-- wb-agent-report:a59fcff213d4440490fd53b32891f2da -->
- **2026-09-01 — BF-DIRECTOR — IN PROGRESS — Quota/session-limit must fail over even after tools and in rooms (branch `grok/quota-cap-fallback`, worktree `~/apps/botfleet-director-quota-fallback`).**  Board `96f2ec55`.  Issue #118.  Owner: anytime a bot hits usage cap/quota, use the saved fallback model.  <!-- wb-agent-report:96f2ec55370d437bb68cef79049fb0d1 -->
- **2026-09-01 - GROK - IN_PROGRESS - Vercel auto-deploys skip unless site files changed, plus 1/hour (branch `grok/vercel-site-watch`, worktree `~/apps/botfleet-grok-vercel-watch`).**  Board `46837afd`.  Script `apps/site/vercel-ignore-hourly.sh` watches `apps/site` so iOS/docs commits do not ship botfleet.app.
- **2026-09-01 - GROK - IN_PROGRESS - Product reach: iPad, chat files, APNs wake, iMessage LaunchAgent, Vercel 1/hour, desktop release host.**  Board `b43584ea` `a9683ae2` `4677da28` `af8f2776` `02ca3c98` `80dd2680` `9051c3ac`.  Issue #107.  Worktree `~/apps/botfleet-grok-reach` @ `grok/product-reach`.
- **2026-09-01 — GROK — IN PROGRESS — Add fleet sentry-ci-report.yml + scripts/sentry-ci-report.py (branch `grok/sentry-ci-report`, worktree `~/apps/botfleet-grok-sentry-ci`, board `e70a89f7`).**  Gold copy UM PR #1394.  APP=`botfleet`.  Fingerprint `[ci-failure, botfleet, workflow]`.  <!-- wb-agent-report:e70a89f7 -->
- **2026-09-01 — GROK — IN PROGRESS — Sentry production deploy records (`sentry-cli releases deploys new -e production`) (branch `grok/sentry-deploys`, worktree `~/apps/botfleet-grok-sentry-deploys`, board `2d1c8565`).**  Additive workflow for `botfleet` project on CI success for `main` push.  VERSION = full git SHA.  Soft-fail.
- **2026-09-01 — GROK — IN PROGRESS — Pickup CLAUDE cap: BotFleet analysis v2 (`claude/analysis-v2`, `~/apps/botfleet-claude`).**  Board `781554fd`.  PR #97.  Report `docs/audits/2026-09-01-botfleet-analysis-v2.md`.  Raw 238 / Claude tech-confirmed 144 / unique P0 still open 5.  No product code.
- **2026-09-01 — GROK — IN PROGRESS — Delta-audit Batch 2: iOS ATS rollback + light-first + iOS truth (branch `grok/delta-audit-ios`, worktree `~/apps/botfleet-grok-delta-ios`).**  Board `95e445e5` `a9683ae2`.  Remove `NSAllowsArbitraryLoads` and `botfleet.app` cleartext; keep local networking + `ts.net`; `preferredColorScheme(.light)`; no APNs.  I2 chat image composer remains a documented gap.  GROK note 2026-09-01: ATS rollback landed as #92 on main; this row is the remaining iOS-truth slice.
- **2026-09-01 - GROK - IN_PROGRESS - Implement 2026-09-01 delta audit batches. Worktree ~/apps/botfleet-grok-delta @ grok/delta-audit-fixes.**  Board `9e922f65`.  Fallbacks, honesty/docs, data/permissions, companion trust.  Electron #91 and iOS ATS #92 already merged.
- **2026-09-01 — GROK — IN PROGRESS — Companion trust leftovers C3/C4/D2 (`grok/delta-companion-trust`).**  Board `149843e8`.  Pairing replay after revoke, phone always-allow/authorize deny, DSH `--mcp` quoting.  Merging into `grok/delta-audit-fixes`.
- **2026-09-01 — GROK — IN PROGRESS — Sentry fleet adoption: Vercel `VITE_SENTRY_DSN`, User Feedback widget, harness gen_ai agent spans (conversation/tool/model/tokens/errors, no prompts) (branch `grok/sentry-fleet-adoption`, worktree `~/apps/botfleet-grok-sentry-adopt`).**  Board `d99cee7f21ad4a2ba6f74b50c85fda04`.  Rollout: `docs/rollouts/2026-09-01-sentry-fleet-adoption.md`.

## Planned / Reserved
- (none)

## Changelog of this log
- 2026-09-01 — BF-DIRECTOR claimed quota/session-limit failover (`96f2ec55`, issue #118) on `grok/quota-cap-fallback`.
- 2026-09-01 — GROK claimed iOS product-reach on `grok/product-reach` (iPad, chat attachments, APNs).  Issue #107.
- 2026-09-01 — GROK picked up CLAUDE analysis v2 (`781554fd`) after the finder journal died at verify/synthesis.  Report-only.
- 2026-09-01 — GROK moved resource-triggers (#65/#80) and iOS Sentry Cocoa (#55) from In Progress to Completed after merge.  Added delta-audit Batch 4+6 claim on `grok/delta-audit-fixes`.
- 2026-08-29 — Deployed always-on iMessage bidirectional relay for 12 BotFleet bots (AG).
- 2026-08-28 — bootstrapped by onboard-new-app.sh.
