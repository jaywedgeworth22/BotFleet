import { describe, expect, it } from "vitest";

import { antigravityQuotaLines, quotaLinesSummary, remainingPercentLabel } from "./quota-display";
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
