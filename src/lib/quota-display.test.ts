import { describe, expect, it } from "vitest";

import {
  antigravityGroupSummary,
  antigravityQuotaLines,
  formatResetCountdown,
  quotaLinesSummary,
  remainingPercentLabel,
  windowHeadlines,
} from "./quota-display";
import { driverKindsForWindow, isPlanLevelSkip, modelsToSkip } from "../../server/quota-window-map";

describe("antigravity quota lines", () => {
  const models = [
    { label: "Claude 4.6 Sonnet", modelId: "claude-sonnet-4-6", remainingPercentage: 0.3, isExhausted: false },
    { label: "Gemini 3.1 Pro", modelId: "gemini-3.1-pro-high", isExhausted: true },
    { label: "Gemini 3 Flash", modelId: "gemini-3-flash", isExhausted: false },
    { label: "Tab", modelId: "gemini-tab", remainingPercentage: 0.9, isExhausted: false, isAutocompleteOnly: true },
  ];

  it("puts Gemini first, marks omitted remaining as exhausted, and drops autocomplete", () => {
    const lines = antigravityQuotaLines(models);
    expect(lines.map((line) => `${line.label}: ${line.value}`)).toEqual([
      "Gemini 3 Flash: exhausted",
      "Gemini 3.1 Pro: exhausted",
      "Claude 4.6 Sonnet: 30%",
    ]);
  });

  it("joins every model for hover, not a four-name slice", () => {
    expect(quotaLinesSummary(antigravityQuotaLines(models))).toContain("Gemini 3.1 Pro: exhausted");
    expect(quotaLinesSummary(antigravityQuotaLines(models))).toContain("Claude 4.6 Sonnet: 30%");
  });

  it("treats N/A remaining as exhausted", () => {
    expect(remainingPercentLabel({ label: "Gemini", modelId: "gemini-x", isExhausted: false })).toBe("exhausted");
  });
});

describe("Cursor monthly windows", () => {
  const monthly = {
    provider: "cursor",
    sourceApp: "cursor-cli",
    label: "Cursor Pro monthly",
    modelId: null,
    modelType: null,
    window: "monthly",
    skip: true,
    skipReason: "0% remaining",
  };

  it("maps onto cursorAgent and skips the whole engine", () => {
    expect(driverKindsForWindow(monthly)).toEqual(["cursorAgent"]);
    expect(isPlanLevelSkip(monthly)).toBe(true);
    expect(
      modelsToSkip(monthly, {
        instanceId: "cursor",
        driverKind: "cursorAgent",
        models: { options: [{ id: "auto" }, { id: "composer-2.5" }] },
      }),
    ).toEqual(["*"]);
  });

  it("does not treat a 5-hour remainder as a plan skip", () => {
    expect(
      isPlanLevelSkip({
        ...monthly,
        window: "5h",
        skip: true,
        skipReason: "session limit",
        label: "Cursor 5h",
      }),
    ).toBe(false);
  });
});

describe("antigravity group summary", () => {
  it("collapses third-party models into one summary and keeps Gemini separate", () => {
    const groups = antigravityGroupSummary([
      { label: "Claude 4.6 Sonnet", modelId: "claude-sonnet-4-6", remainingPercentage: 0.3, isExhausted: false },
      { label: "GPT-OSS 120B", modelId: "gpt-oss-120b-medium", remainingPercentage: 0.2, isExhausted: false },
      { label: "Gemini 3.1 Pro", modelId: "gemini-3.1-pro-high", isExhausted: true },
      { label: "Gemini 3 Flash", modelId: "gemini-3-flash", remainingPercentage: 0.8, isExhausted: false },
    ]);
    // Exhausted models are excluded from the average — including an empty
    // slot would dilute the read of the models the user can still send to.
    expect(groups).toEqual([
      { group: "gemini", label: "Gemini", remainingPercent: 80, exhausted: false },
      { group: "external", label: "Third Party", remainingPercent: 25, exhausted: false },
    ]);
  });

  it("marks the whole group exhausted when every model is", () => {
    const groups = antigravityGroupSummary([
      { label: "Claude 4.6 Sonnet", modelId: "claude-sonnet-4-6", isExhausted: true },
      { label: "Gemini 3.1 Pro", modelId: "gemini-3.1-pro-high", isExhausted: true },
    ]);
    expect(groups.every((group) => group.exhausted)).toBe(true);
    expect(groups.find((group) => group.group === "external")?.remainingPercent).toBe(0);
  });

  it("ignores autocomplete-only entries", () => {
    const groups = antigravityGroupSummary([
      { label: "Tab", modelId: "gemini-tab", remainingPercentage: 0.9, isExhausted: false, isAutocompleteOnly: true },
    ]);
    expect(groups).toEqual([]);
  });
});

describe("windowHeadlines + formatResetCountdown", () => {
  it("picks the most restrictive window per bucket and orders weekly → monthly → 5h", () => {
    const headlines = windowHeadlines([
      { label: "Cursor Pro weekly", window: "weekly", remainingPercent: 80, resetAt: futureIso(4, 12), skip: false },
      { label: "Cursor Hobby weekly", window: "weekly", remainingPercent: 5, resetAt: futureIso(1, 2), skip: false },
      { label: "Cursor Pro monthly", window: "monthly", remainingPercent: 100, resetAt: futureIso(12, 0), skip: false },
      { label: "Cursor 5h", window: "5h", remainingPercent: 50, resetAt: futureIso(0, 2, 14), skip: false },
    ]);
    expect(headlines.map((h) => h.bucket)).toEqual(["weekly", "monthly", "5h"]);
    // The most restrictive (lowest remaining) wins the weekly slot.
    expect(headlines[0].remainingPercent).toBe(5);
    expect(headlines[0].display).toBe("Weekly");
  });

  it("treats an explicitly-skipped window as fully exhausted (zero remaining)", () => {
    const headlines = windowHeadlines([
      { label: "Cursor Pro monthly", window: "monthly", remainingPercent: 100, resetAt: futureIso(12, 0), skip: true, skipReason: "0% remaining" } as any,
    ]);
    expect(headlines[0].exhausted).toBe(true);
    expect(headlines[0].remainingPercent).toBe(0);
  });

  it("formats reset countdowns: 4d 12h, 12h 14m, 14m, resetting now", () => {
    const now = Date.now();
    expect(formatResetCountdown(now + (4 * 86_400 + 12 * 3600) * 1000, now)).toBe("4d 12h");
    expect(formatResetCountdown(now + (12 * 3600 + 14 * 60) * 1000, now)).toBe("12h 14m");
    expect(formatResetCountdown(now + 14 * 60 * 1000, now)).toBe("14m");
    expect(formatResetCountdown(now - 1, now)).toBe("resetting now");
    expect(formatResetCountdown(null)).toBeNull();
  });
});

function futureIso(days: number, hours: number, extraMinutes = 0): string {
  return new Date(Date.now() + ((days * 86_400) + (hours * 3600) + (extraMinutes * 60)) * 1000).toISOString();
}
