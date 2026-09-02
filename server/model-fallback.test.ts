import { describe, expect, it } from "vitest";

import type { ModelSelection } from "./contracts.ts";
import {
  isQuotaOrCapText,
  isShortProviderErrorText,
  lastUserTextIndex,
  selectTurnFallback,
  sliceIsShortProviderError,
  turnHitQuotaOrCap,
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
  const quotaOrCap = turnHitQuotaOrCap(messagesAfterUser);
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

  it("matches usage-cap and quota chips", () => {
    expect(isQuotaOrCapText("usage cap reached for this model")).toBe(true);
    expect(isQuotaOrCapText("quota exceeded for this plan")).toBe(true);
    expect(isQuotaOrCapText("Here is a long successful answer about quotas that is well over five hundred characters. ".repeat(8))).toBe(false);
    expect(isQuotaOrCapText("Done.")).toBe(false);
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

describe("lastUserTextIndex", () => {
  it("finds the last user text, ignoring later bot chips", () => {
    expect(
      lastUserTextIndex([
        { role: "user", kind: "text", text: "one" },
        { role: "bot", kind: "text", text: "ok" },
        { role: "user", kind: "text", text: "two" },
        { role: "bot", kind: "activity", tool: { name: "Bash" } },
      ]),
    ).toBe(2);
  });
});

describe("isShortProviderErrorText", () => {
  it("matches the short error-chip patterns", () => {
    expect(isShortProviderErrorText("account_inactive")).toBe(true);
    expect(isShortProviderErrorText("Here is a long successful answer about rate limits that is well over three hundred characters. ".repeat(4))).toBe(false);
    expect(isShortProviderErrorText("Done.")).toBe(false);
  });
});
