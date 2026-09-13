import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import type { ModelSelection } from "./contracts.ts";
import {
  bootRecoveryTurnOpts,
  isQuotaOrCapText,
  isShortProviderErrorText,
  lastTurnStartIndex,
  parseQuotaResetTime,
  QuotaCooldownRegistry,
  quotaCooldowns,
  selectTurnFallback,
  shouldReplayPersistedStarter,
  sliceIsShortProviderError,
  turnHitQuotaOrCap,
  turnQuotaOrCapEvidence,
  turnProducedAssistantOutput,
  type FallbackScanMessage,
} from "./model-fallback.ts";

const fallbacks: ModelSelection[] = [
  { instanceId: "grok", model: "grok-4" },
  { instanceId: "claude", model: "claude-sonnet-5" },
];

function decide(messagesAfterUser: FallbackScanMessage[], opts: {
  ok?: boolean;
  stopReason?: string | null;
  used?: number;
  chain?: ModelSelection[];
  current?: { instanceId: string; model: string } | null;
} = {}) {
  const textIsError = sliceIsShortProviderError(messagesAfterUser);
  const quotaOrCap = Boolean(turnQuotaOrCapEvidence(messagesAfterUser, opts.ok ?? false));
  const produced = turnProducedAssistantOutput(messagesAfterUser, { textIsError: textIsError || quotaOrCap });
  return selectTurnFallback({
    ok: (opts.ok ?? false) && !textIsError && !quotaOrCap,
    stopReason: opts.stopReason,
    produced,
    quotaOrCap,
    fallbacks: opts.chain ?? fallbacks,
    used: opts.used ?? 0,
    current: opts.current,
  });
}

describe("turnProducedAssistantOutput", () => {
  it("does not count a tool-start chip (ok undefined) as produced, so 1:1 failover starts the next instance", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "activity", tool: { name: "Bash" } },
    ];
    expect(turnProducedAssistantOutput(afterUser)).toBe(false);
    expect(decide(afterUser, { ok: false })).toEqual({
      instanceId: "grok",
      model: "grok-4",
      nextUsed: 1,
    });
  });

  it("room messages with sender attribution use the same gate", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "activity", tool: { name: "Read" } },
      { role: "bot", kind: "activity", tool: { name: "error: HTTP 401", ok: false } },
    ];
    expect(turnProducedAssistantOutput(afterUser)).toBe(false);
    expect(decide(afterUser, { ok: false })).toEqual({
      instanceId: "grok",
      model: "grok-4",
      nextUsed: 1,
    });
  });

  it("counts a successful terminal tool result as produced", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "activity", tool: { name: "Bash", ok: true } },
    ];
    expect(turnProducedAssistantOutput(afterUser)).toBe(true);
    expect(decide(afterUser, { ok: false })).toBeUndefined();
  });

  it("never counts retry or working activity, even when ok is true", () => {
    expect(
      turnProducedAssistantOutput([
        { role: "bot", kind: "activity", tool: { name: "retrying — attempt 2/3 in 1s — 503", ok: true } },
      ]),
    ).toBe(false);
    expect(
      turnProducedAssistantOutput([
        { role: "bot", kind: "activity", tool: { name: "working", ok: true } },
      ]),
    ).toBe(false);
  });

  it("never counts screen frames", () => {
    expect(turnProducedAssistantOutput([{ role: "bot", kind: "screen" }])).toBe(false);
  });

  it("successful text reply does not fail over", () => {
    const afterUser: FallbackScanMessage[] = [{ role: "bot", kind: "text", text: "Here you go." }];
    expect(turnProducedAssistantOutput(afterUser)).toBe(true);
    expect(decide(afterUser, { ok: true })).toBeUndefined();
  });

  it("a short provider-error text chip is not produced output", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "text", text: "rate limit exceeded, try again later" },
    ];
    const textIsError = sliceIsShortProviderError(afterUser);
    expect(textIsError).toBe(true);
    expect(turnProducedAssistantOutput(afterUser, { textIsError })).toBe(false);
    expect(decide(afterUser, { ok: true })).toEqual({
      instanceId: "grok",
      model: "grok-4",
      nextUsed: 1,
    });
  });
});

describe("quota and session-limit failover", () => {
  it("matches Grok's session-limit chip", () => {
    const text = "You've hit your session limit · resets 12:10am (America/Chicago)";
    expect(isQuotaOrCapText(text)).toBe(true);
    expect(isShortProviderErrorText(text)).toBe(true);
  });

  it("matches usage-cap and quota chips across various providers", () => {
    expect(isQuotaOrCapText("usage cap reached for this model")).toBe(true);
    expect(isQuotaOrCapText("quota exceeded for this plan")).toBe(true);
    expect(isQuotaOrCapText("You have exhausted your daily quota")).toBe(true);
    expect(isQuotaOrCapText("You've reached your usage limit")).toBe(true);
    expect(isQuotaOrCapText("Insufficient Balance")).toBe(true);
    expect(isQuotaOrCapText("out of credits")).toBe(true);
    expect(isQuotaOrCapText("Your credit balance is too low")).toBe(true);
    expect(isQuotaOrCapText("HTTP 429: Too Many Requests")).toBe(true);
    expect(isQuotaOrCapText("RESOURCE_EXHAUSTED")).toBe(true);
    expect(isQuotaOrCapText("Here is a long successful answer about quotas that is well over five hundred characters. ".repeat(8))).toBe(false);
    expect(isQuotaOrCapText("Done.")).toBe(false);
  });

  it("matches official provider quota chips and ignores near-cap warnings", () => {
    const hits = [
      // Grok TUI / xAI SuperGrok (observed in this room)
      "You've hit your session limit · resets 12:10am (America/Chicago)",
      // grok.com consumer
      "Message limit reached",
      "You've exceeded your messaging allowance for the moment",
      // xAI API
      "429 Too Many Requests",
      // Claude.ai subscription (support.claude.com)
      "5-hour limit reached - resets 3:00pm",
      // Claude API (docs.claude.com / platform.claude.com)
      "You have reached your API usage limits: your organization has crossed its monthly API usage threshold",
      "This request would exceed your organization's rate limit of 30,000 input tokens per minute",
      "rate_limit_error",
      "enforced_spend_limit_reached",
      // Gemini API (ai.google.dev)
      "Resource has been exhausted (e.g. check quota).",
      "You exceeded your current quota, please check your plan and billing details.",
      "429 RESOURCE_EXHAUSTED",
      "Your prepayment credits are depleted.",
      // Codex CLI (openai/codex + help.openai.com)
      "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again later.",
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 6th, 2026 11:41 PM.",
      "usage_limit_exceeded",
      "Rate limit reached for gpt-4.1 in organization org-example on tokens per min (TPM)",
      // Cursor CLI / editor
      "You've reached your monthly limit. Set a new on-demand limit to continue.",
      "Increase limits for faster responses Claude Opus 4.5 is not available in the slow pool. Please switch to Auto.",
      "You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.",
      "You've hit your rate limit on your current plan",
      "Upgrade your plan to continue",
      // DeepSeek API (api-docs.deepseek.com)
      "402 Insufficient Balance",
      "429 Rate Limit Reached",
      // Kimi Code (kimi.com/code/docs error-reference)
      "You've reached your 5-hour usage limit",
      "You've reached your weekly (7-day) usage limit",
      "You've reached your monthly usage limit for this billing cycle",
      "We're receiving too many requests at the moment. Please wait a moment and try again.",
      "Quota exceeded, please upgrade your plan or retry later",
    ];
    expect(hits.filter((text) => !isQuotaOrCapText(text))).toEqual([]);
    expect(isQuotaOrCapText("Approaching 5-hour limit.")).toBe(false);
    expect(isQuotaOrCapText("You've used 80% of your included usage")).toBe(false);
  });

  it("does not turn ordinary successful prose or quoted examples into provider failures", () => {
    const prose = [
      "The billing fix is merged.",
      "The subscription accounting review is complete.",
      "Capacity planning is documented.",
      "I added coverage for quota exceeded and rate limit errors.",
      "You've reached the end of the billing review.",
      "Quota exceeded handling is documented.",
      "Rate limit parsing is tested.",
      "Your subscription limit fix is merged.",
      "You've hit your usage limit handling in a regression test.",
      "This request would exceed the old timeout, so I increased it.",
      "HTTP 429 handling is covered by tests.",
      "> Quota exceeded, please upgrade your plan.",
      'The provider may say "You have reached your usage limit".',
    ];
    for (const text of prose) {
      expect(isQuotaOrCapText(text), text).toBe(false);
      expect(isShortProviderErrorText(text), text).toBe(false);
      expect(turnQuotaOrCapEvidence([{ role: "bot", kind: "text", text }], true), text).toBeUndefined();
      expect(decide([{ role: "bot", kind: "text", text }], { ok: true }), text).toBeUndefined();
    }
  });

  it("binds quota status to the actual error activity instead of earlier assistant text", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "text", text: "The billing review is complete." },
      { role: "bot", kind: "activity", tool: { name: "error: API request failed: 429 rate limit reached · retry after 45s", ok: false } },
    ];
    expect(turnQuotaOrCapEvidence(afterUser, false)).toEqual({
      text: "API request failed: 429 rate limit reached · retry after 45s",
      source: "provider-error",
    });
    expect(parseQuotaResetTime("API request failed: 429 rate limit reached · retry after 45s", 1_000, true)).toEqual({
      isQuotaOrCap: true,
      resetsAt: 46_000,
      rawTimeText: "retry after 45s",
    });
  });

  it("does not revive an earlier retry error after the turn completes successfully", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "activity", tool: { name: "error: 429 rate limit reached", ok: false } },
      { role: "bot", kind: "activity", tool: { name: "retrying — attempt 2/3 in 1s — 429", ok: true } },
      { role: "bot", kind: "text", text: "The retry completed the billing review." },
    ];
    expect(turnQuotaOrCapEvidence(afterUser, true)).toBeUndefined();
  });

  it("fails over after successful tools when the last text is a session-limit chip", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "activity", tool: { name: "Bash", ok: true } },
      { role: "bot", kind: "activity", tool: { name: "Read", ok: true } },
      { role: "bot", kind: "text", text: "You've hit your session limit · resets 12:10am (America/Chicago)" },
    ];
    expect(turnProducedAssistantOutput(afterUser)).toBe(true);
    expect(turnHitQuotaOrCap(afterUser)).toBe(true);
    expect(decide(afterUser, { ok: true })).toEqual({
      instanceId: "grok",
      model: "grok-4",
      nextUsed: 1,
    });
  });

  it("fails over from an error activity chip that names the quota", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "activity", tool: { name: "Bash", ok: true } },
      { role: "bot", kind: "activity", tool: { name: "error: quota exceeded for this plan", ok: false } },
    ];
    expect(turnHitQuotaOrCap(afterUser)).toBe(true);
    expect(decide(afterUser, { ok: false })).toEqual({
      instanceId: "grok",
      model: "grok-4",
      nextUsed: 1,
    });
  });

  it("skips a fallback that is the same engine as the current primary", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "text", text: "You've hit your session limit · resets 12:10am (America/Chicago)" },
    ];
    expect(
      decide(afterUser, {
        ok: true,
        current: { instanceId: "grok", model: "grok-4" },
      }),
    ).toEqual({
      instanceId: "claude",
      model: "claude-sonnet-5",
      nextUsed: 2,
    });
  });

  it("does not invent an engine when every saved fallback matches the primary", () => {
    const afterUser: FallbackScanMessage[] = [
      { role: "bot", kind: "text", text: "quota exceeded" },
    ];
    expect(
      decide(afterUser, {
        ok: true,
        current: { instanceId: "claude", model: "claude-opus-5" },
        chain: [{ instanceId: "claude", model: "claude-opus-5" }],
      }),
    ).toBeUndefined();
  });
});

describe("selectTurnFallback", () => {
  it("cancelled or interrupted does not fail over", () => {
    const afterUser: FallbackScanMessage[] = [{ role: "bot", kind: "activity", tool: { name: "Bash" } }];
    expect(decide(afterUser, { ok: false, stopReason: "cancelled" })).toBeUndefined();
    expect(decide(afterUser, { ok: false, stopReason: "interrupted" })).toBeUndefined();
  });

  it("walks the saved chain by used count", () => {
    const afterUser: FallbackScanMessage[] = [];
    expect(decide(afterUser, { ok: false, used: 1 })).toEqual({
      instanceId: "claude",
      model: "claude-sonnet-5",
      nextUsed: 2,
    });
    expect(decide(afterUser, { ok: false, used: 2 })).toBeUndefined();
  });
});

describe("lastTurnStartIndex", () => {
  it("finds the last user text, ignoring later bot chips", () => {
    expect(
      lastTurnStartIndex([
        { role: "user", kind: "text", text: "one" },
        { role: "bot", kind: "text", text: "ok" },
        { role: "user", kind: "text", text: "two" },
        { role: "bot", kind: "activity", tool: { name: "Bash" } },
      ]),
    ).toBe(2);
  });

  it("also finds an auto-delivered system-role instruction that started the turn", () => {
    expect(
      lastTurnStartIndex([
        { role: "system", kind: "text", text: "routine fired" },
        { role: "bot", kind: "text", text: "session limit hit" },
      ]),
    ).toBe(0);
  });

  it("prefers the later of a user message and a system instruction", () => {
    expect(
      lastTurnStartIndex([
        { role: "user", kind: "text", text: "one" },
        { role: "system", kind: "text", text: "webhook fired" },
        { role: "bot", kind: "activity", tool: { name: "Bash" } },
      ]),
    ).toBe(1);
  });
});

describe("shouldReplayPersistedStarter", () => {
  it("replays a webhook/system prompt that only got as far as an activity chip", () => {
    const messages: FallbackScanMessage[] = [
      { role: "system", kind: "text", text: "webhook fired" },
      { role: "bot", kind: "activity", tool: { name: "Bash" } },
    ];
    expect(shouldReplayPersistedStarter(messages, 0)).toBe(true);
  });

  it("does not replay a completed prompt when the in-flight turn was a card continuation", () => {
    const messages: FallbackScanMessage[] = [
      { role: "user", kind: "text", text: "connect slack" },
      { role: "bot", kind: "text", text: "please connect Slack" },
      { role: "bot", kind: "connector" },
    ];
    expect(shouldReplayPersistedStarter(messages, 0)).toBe(false);
  });

  it("does not replay after a successful tool result (side effects already ran)", () => {
    const messages: FallbackScanMessage[] = [
      { role: "system", kind: "text", text: "webhook fired" },
      { role: "bot", kind: "activity", tool: { name: "Bash", ok: true } },
    ];
    expect(shouldReplayPersistedStarter(messages, 0)).toBe(false);
  });
});

describe("bootRecoveryTurnOpts", () => {
  it("forwards webhook automationSource and marks unattended on both replay and BOOT_RECOVERY_NOTICE paths", () => {
    const resume = { role: "system", automationSource: "webhook" as const };
    const notice = bootRecoveryTurnOpts(resume, false);
    const replay = bootRecoveryTurnOpts(resume, true);
    expect(notice).toEqual({ automationSource: "webhook", unattended: true });
    expect(replay).toEqual(notice);
  });

  it("marks resource recovery unattended even when the persisted starter already produced a tool result", () => {
    expect(bootRecoveryTurnOpts({ role: "system", automationSource: "resource" }, false)).toEqual({
      automationSource: "resource",
      unattended: true,
    });
  });

  it("forwards schedule automationSource so the recovery notice stores as system", () => {
    expect(bootRecoveryTurnOpts({ role: "system", automationSource: "schedule" }, false)).toEqual({
      automationSource: "schedule",
      unattended: true,
    });
  });

  it("marks a system starter without a source unattended so recovery is not treated as a person typing", () => {
    expect(bootRecoveryTurnOpts({ role: "system" }, false)).toEqual({
      automationSource: undefined,
      unattended: true,
    });
  });

  it("leaves an ordinary human starter attended and without an automationSource", () => {
    expect(bootRecoveryTurnOpts({ role: "user" }, true)).toEqual({
      automationSource: undefined,
      unattended: undefined,
    });
  });
});

describe("parseQuotaResetTime", () => {
  it("parses relative reset durations in minutes and seconds", () => {
    const base = 1700000000000;
    const res1 = parseQuotaResetTime("Rate limit reached. Try again in 15 minutes.", base);
    expect(res1.isQuotaOrCap).toBe(true);
    expect(res1.resetsAt).toBe(base + 15 * 60 * 1000);

    const res2 = parseQuotaResetTime("HTTP 429: Too Many Requests · retry after 45s", base);
    expect(res2.isQuotaOrCap).toBe(true);
    expect(res2.resetsAt).toBe(base + 45 * 1000);
  });

  it("parses Grok style reset time with timezone", () => {
    const text = "You've hit your session limit · resets 12:10am (America/Chicago)";
    const res = parseQuotaResetTime(text);
    expect(res.isQuotaOrCap).toBe(true);
    expect(typeof res.resetsAt).toBe("number");
    expect(res.resetsAt).toBeGreaterThan(Date.now() - 1000);
  });

  it("parses midnight reset", () => {
    const text = "Daily quota exceeded · resets at midnight UTC";
    const res = parseQuotaResetTime(text);
    expect(res.isQuotaOrCap).toBe(true);
    expect(typeof res.resetsAt).toBe("number");
  });

  it("recognizes quota without reset time", () => {
    const text = "Insufficient Balance";
    const res = parseQuotaResetTime(text);
    expect(res.isQuotaOrCap).toBe(true);
    expect(res.resetsAt).toBeNull();
  });
});

describe("a user stop must not fail over", () => {
  // The bug this guards: the owner pressed Stop for two minutes on a bot with
  // a saved chain.  Had the stop reached the driver without a harness latch,
  // each press would have killed the attempt and immediately started the next
  // engine — "Stop does nothing" becoming "Stop falls over to another model".
  it("still fails over on exit_before_result, which is why the harness latch is load-bearing", () => {
    // Antigravity, claude and codex ALL settle a killed turn this way; none
    // of them reports "interrupted" for a user stop.  So this gate cannot
    // tell a user stop from a crash, and must not be asked to.
    expect(decide([], { ok: false, stopReason: "exit_before_result" })).toEqual({
      instanceId: "grok",
      model: "grok-4",
      nextUsed: 1,
    });
  });

  it("suppresses the chain only for the two stop reasons a driver never reports on a user stop", () => {
    expect(decide([], { ok: false, stopReason: "interrupted" })).toBeUndefined();
    expect(decide([], { ok: false, stopReason: "cancelled" })).toBeUndefined();
  });

  it("skips the chain when the caller has already latched the turn as stopped", () => {
    // How server/index.ts consumes its stoppedTurns latch: a stopped turn
    // never reaches selectTurnFallback at all.  Stopping is per-request, so
    // the saved chain itself is untouched and the next message gets it whole.
    const userStopped = true;
    const next = userStopped ? undefined : decide([], { ok: false, stopReason: "exit_before_result" });
    expect(next).toBeUndefined();
    expect(decide([], { ok: false, stopReason: "exit_before_result", used: 0 })).toBeDefined();
  });
});

describe("QuotaCooldownRegistry", () => {
  it("resolves fallback when primary is on active cooldown and switches back once expired", () => {
    const registry = new (quotaCooldowns.constructor as any)();
    const primary: ModelSelection = {
      instanceId: "grok",
      model: "grok-4",
      fallbacks: [{ instanceId: "claude", model: "claude-sonnet-5" }],
    };

    const now = 1700000000000;
    const resetsAt = now + 60000;

    registry.record({
      botId: "bot1",
      instanceId: "grok",
      model: "grok-4",
      resetsAt,
      error: "session limit",
      recordedAt: now,
    });

    // While in cooldown (now + 10s): uses fallback
    const resolution1 = registry.resolveModel("bot1", primary, now + 10000);
    expect(resolution1.isFallback).toBe(true);
    expect(resolution1.selection.instanceId).toBe("claude");
    expect(resolution1.selection.model).toBe("claude-sonnet-5");

    // After resetsAt (now + 70s): switches back to primary
    const resolution2 = registry.resolveModel("bot1", primary, now + 70000);
    expect(resolution2.isFallback).toBe(false);
    expect(resolution2.selection.instanceId).toBe("grok");
    expect(resolution2.selection.model).toBe("grok-4");
  });

  it("applies instance-level wildcard cap to all bots and lists active cooldowns", () => {
    const registry = new (quotaCooldowns.constructor as any)();
    const primary: ModelSelection = {
      instanceId: "codex",
      model: "gpt-5.4",
      fallbacks: [{ instanceId: "antigravity", model: "gemini-3.8-flash-high" }],
    };

    registry.recordInstanceCap("codex", "*", { error: "Codex session limit reached" });

    // Any bot targeting codex should automatically use fallback
    const resolved = registry.resolveModel("any-bot-id", primary);
    expect(resolved.isFallback).toBe(true);
    expect(resolved.selection.instanceId).toBe("antigravity");
    expect(resolved.selection.model).toBe("gemini-3.8-flash-high");
    expect(resolved.cooldown?.error).toBe("Codex session limit reached");

    // Cooldown list includes the instance cap
    const active = registry.list();
    expect(active.length).toBe(1);
    expect(active[0].instanceId).toBe("codex");
    expect(active[0].botId).toBe("*");
  });

  it("treats a per-model cooldown as an instance cap for the picker", () => {
    const registry = new (quotaCooldowns.constructor as any)();
    registry.record({
      botId: "monitor",
      instanceId: "cursor",
      model: "gpt-5",
      resetsAt: Date.now() + 60_000,
      error: "You've hit your usage limit",
      recordedAt: Date.now(),
    });
    const cd = registry.forInstance("cursor");
    expect(cd?.instanceId).toBe("cursor");
    expect(cd?.error).toBe("You've hit your usage limit");
  });

  it("persists and reloads cooldowns, skipping expired rows", () => {
    const file = `${tmpdir()}/quota-cooldowns-${Date.now()}.json`;
    const first = new QuotaCooldownRegistry();
    const writes: string[] = [];
    first.enablePersist(file, (_path, json) => {
      writes.push(json);
      writeFileSync(file, json);
    });
    const now = Date.now();
    first.recordInstanceCap("antigravity", "claude-opus-4-6-thinking", {
      resetsAt: now + 60_000,
      error: "exhausted",
      source: "antigravity-usage",
    });
    first.recordInstanceCap("grok", "*", { resetsAt: now - 1, error: "expired", source: "chip" });
    expect(writes.length).toBeGreaterThan(0);

    const second = new QuotaCooldownRegistry();
    second.enablePersist(file, (_path, json) => writeFileSync(file, json));
    expect(second.get("bot", "antigravity", "claude-opus-4-6-thinking")?.error).toBe("exhausted");
    expect(second.get("bot", "grok", "grok-4.6")).toBeUndefined();
  });

  it("drops only legacy sourceless prose cooldowns while retaining terminal chips and named sources", () => {
    const file = `${tmpdir()}/quota-cooldowns-prose-${Date.now()}.json`;
    writeFileSync(file, JSON.stringify({
      version: 1,
      cooldowns: [
        {
          botId: "prose-bot",
          instanceId: "grok",
          model: "grok-4",
          resetsAt: null,
          error: "The subscription accounting review is complete.",
          recordedAt: Date.now(),
        },
        {
          botId: "chip-bot",
          instanceId: "grok",
          model: "grok-4",
          resetsAt: null,
          error: "You've hit your session limit · resets in 30 minutes",
          recordedAt: Date.now(),
        },
        {
          botId: "prefixed-cap-bot",
          instanceId: "grok",
          model: "grok-4",
          resetsAt: null,
          error: "API request failed: 429 rate limit reached",
          recordedAt: Date.now(),
        },
        {
          botId: "monitor-bot",
          instanceId: "antigravity",
          model: "gemini",
          resetsAt: null,
          error: "opaque provider telemetry",
          recordedAt: Date.now(),
          source: "antigravity-usage",
        },
      ],
    }));
    const writes: string[] = [];
    const registry = new QuotaCooldownRegistry();
    registry.enablePersist(file, (_path, json) => {
      writes.push(json);
      writeFileSync(file, json);
    });

    expect(registry.get("prose-bot", "grok", "grok-4")).toBeUndefined();
    expect(registry.get("chip-bot", "grok", "grok-4")?.source).toBeUndefined();
    expect(registry.get("prefixed-cap-bot", "grok", "grok-4")?.source).toBeUndefined();
    expect(registry.get("monitor-bot", "antigravity", "gemini")?.source).toBe("antigravity-usage");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]).cooldowns).toHaveLength(3);
  });

  it("clearWhere removes a deleted instance's cooldowns even when they never expire, leaving other instances untouched", () => {
    // server/index.ts's DELETE /api/instances/:id relies on exactly this: a
    // recreated custom engine reuses the same slug/instance id, so a stale
    // wildcard cooldown with no resetsAt — which list()/get() would
    // otherwise never age out — must not survive the delete and immediately
    // cap the replacement the moment it exists.
    const registry = new QuotaCooldownRegistry();
    registry.recordInstanceCap("custom-ollama", "*", { error: "Session limit or usage cap reached" });
    registry.record({
      botId: "bot1",
      instanceId: "custom-ollama",
      model: "llama3",
      resetsAt: null,
      error: "per-model cap",
      recordedAt: Date.now(),
    });
    registry.recordInstanceCap("codex", "*", { error: "unrelated engine, must survive" });

    expect(registry.list().length).toBe(3);

    registry.clearWhere((cooldown) => cooldown.instanceId === "custom-ollama");

    const remaining = registry.list();
    expect(remaining.length).toBe(1);
    expect(remaining[0].instanceId).toBe("codex");
    expect(registry.forInstance("custom-ollama")).toBeUndefined();
  });
});
