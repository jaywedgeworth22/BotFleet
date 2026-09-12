# Signed Mac Adoption And Credential Restoration

## Installed And Verified

The local Developer ID build and matching detached harness/dependencies were installed at `ae8abe7d5d595b427164ddf37fecebcf7da65c05` on September 12, 2026.  Marketing version remains 1.0.30; the signed build manifest identifies the actual source.  The authenticated runtime reported PID 11581, clean source, API version 1, and exactly one SQLite owner.  The desktop attached through port 18799, restored its saved profile and threads, and retained the unsent EngineProbe draft.  A native screenshot confirmed the loaded UI.

A supervised restart was necessary because GitHub review hooks continued to enqueue work.  Three queued deliveries remained in the durable store: two completed after restart and one reported stopped.  One active Designer review was recorded as interrupted.  These outcomes are not represented as uninterrupted execution.  The prior app, dependency tree, generated vendor file, stopped data-root snapshot, and final app user-data snapshot remain in the private rollout receipt under `~/Library/Caches/BotFleet/updates/audit-ae8abe7d-v2-20260912/previous/`.  The always-on process master and pinned Background Jobs note were refreshed.  Tailscale stayed off.

## Connection Acceptance

PagerDuty subscription P6MLZQI already targeted the correct current Cloudflare hooks ingress when rechecked.  Its native test ping returned 202, produced an accepted local webhook receipt, and completed run `ee0d64fc-e903-4a00-9da7-6c7ec08ddfa8` without error.  No incident was created and no capability URL or secret is published.  This closes #269 with fresh acceptance evidence; the underlying target correction is not attributed to this change.

## Credential Restore Defect

The desktop passed fixed workspace keys only when spawning a child.  Attachment to the always-on harness replayed custom-instance keys alone, leaving Composio and Infisical unconfigured despite retained project/session identifiers.  Issue #329 adds an owner-authenticated, loopback-only restore operation separate from settings edits.  It accepts only fixed credential names, retains existing resolved config and canonical Infisical values, writes no plaintext config or vault values, and refuses active work before mutation.  A synchronous provider fence protects accepted restoration; repeated attachment is idempotent.  The desktop retries from its current encrypted store after work finishes and stops retrying on quit.

Custom-instance keys now use the same authenticated idle guard before a targeted provider refresh.  The old replay could interrupt active turns through the ordinary settings route.  Restoration holds the existing encrypted-document transaction, so a later successful clear or save cannot race an older replay; only a confirmed missing instance removes its stale encrypted key.  Request deadlines and generic diagnostics avoid forwarding secrets through redirects or error text.

## Sentry Delivery Identity

The configured internal integration `botfleet-incident-monitor-5b7c22` subscribes to `issue` events and targets the current Cloudflare hooks host.  Its read-only delivery log returned 100 recent requests: 81 accepted (202), 16 rate-limited (429), and three timeouts.  This sample proves receipt outcomes, not completion of every bot run.  The failed-delivery metadata confirmed `Request-ID` (32 hexadecimal characters), `Sentry-Hook-Resource: issue`, `Sentry-Hook-Timestamp`, and `Sentry-Hook-Signature`; no custom headers were configured.  No request body, signature, capability URL, or secret was retained in this document.

Issue #273 adds the observed Request-ID as a narrowly scoped fallback after existing idempotency headers.  The isolated ingress regression repeats a synthetic request with that observed header shape and proves one enqueue; distinct request IDs and issue actions still enqueue separately.  PagerDuty `x-webhook-id` precedence remains unchanged.  Arbitrary proxy Request-ID headers do not activate deduplication.  Sentry's [event serializer](https://github.com/getsentry/sentry/blob/master/src/sentry/sentry_apps/api/serializers/app_platform_event.py) creates a request ID per event object, so this change deliberately makes no claim that separately regenerated provider requests share an identity and does not collapse events by issue ID or body hash.

## Validation Boundary

Focused credential tests passed 19 cases, including authenticated memory-only restoration and busy-turn refusal against a real isolated harness.  Webhook ingress and durable-manager tests cover Sentry replay, separate actions, generic request IDs, and PagerDuty precedence.  The integrated `pnpm typecheck && pnpm test` gate passed: 3,573 Vitest tests passed, 19 skipped, followed by all updater, desktop, packaged-server, iOS shipping, and Infisical checks.  Two independent peer reviews found no blocking issue.  Signed deployment remains required before live acceptance of these source changes.

The new source fix is separate from the already installed ae8abe7d build.  A subsequent signed rollout is required before claiming live credential restoration.  iOS physical-device and full engine acceptance remain tracked in #274/#294.
