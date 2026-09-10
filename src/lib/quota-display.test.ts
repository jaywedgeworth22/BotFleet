import { describe, expect, it } from "vitest";

import {
  antigravityGroupSummary,
  antigravityQuotaLines,
  formatResetCountdown,
  isEngineUnconfigured,
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

  it("emits only Gemini and Third-Party, not per-model rows", () => {
    const lines = antigravityQuotaLines(models);
    expect(lines.map((line) => `${line.label}: ${line.value}`)).toEqual([
      "Gemini: exhausted",
      "Third-Party: 30%",
    ]);
  });

  it("joins the two buckets for hover, not a per-model slice", () => {
    expect(quotaLinesSummary(antigravityQuotaLines(models))).toBe("Gemini: exhausted · Third-Party: 30%");
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

describe("Codex windows", () => {
  it("maps onto the shipped fleet's codex driver kind, not just codexAgent", () => {
    // The default fleet's Codex instance rides driver kind "codex"
    // (server/drivers/codex.ts's DRIVER_KIND) — "codexAgent" matches nothing
    // instanceConfigs() ever produces, so a Codex/OpenAI Usage Monitor window
    // was unreachable by windowsForDriver() for the one instance most likely
    // to want it.
    const codexWindow = {
      provider: "openai",
      sourceApp: "codex-cli",
      label: "Codex 5h",
      modelId: null,
      modelType: null,
      window: "5h",
      skip: false,
    };
    expect(driverKindsForWindow(codexWindow)).toContain("codex");
  });

  it("does not attribute an openai-compat custom-engine window to Codex", () => {
    // "openai-compat" is server/telemetry.ts's AMBIGUOUS_ENGINE fallback
    // provider token for a custom engine — it contains "openai" as a literal
    // substring, so without an explicit exclusion a skipped monthly window
    // on an unrelated custom engine would wildcard-cap the real Codex
    // instance, and an ordinary window would render under the wrong row.
    const customEngineWindow = {
      provider: "openai-compat",
      sourceApp: null,
      label: "Custom Engine",
      modelId: null,
      modelType: null,
      window: "monthly",
      skip: true,
      skipReason: "0% remaining",
    };
    expect(driverKindsForWindow(customEngineWindow)).toEqual([]);
  });
});

describe("Kimi windows", () => {
  it("maps a moonshot-provider window onto the shipped fleet's kimiAgent driver kind", () => {
    // inferProviderAndService (server/telemetry.ts) reports Kimi/Moonshot
    // windows under provider "moonshot"; the raw Usage Monitor windows table
    // this PR removed was the only place a Kimi window stayed visible
    // without this mapping.
    const kimiWindow = {
      provider: "moonshot",
      sourceApp: "kimi-cli",
      label: "Kimi 5h",
      modelId: null,
      modelType: null,
      window: "5h",
      skip: false,
    };
    expect(driverKindsForWindow(kimiWindow)).toEqual(["kimiAgent"]);
  });
});

describe("isEngineUnconfigured", () => {
  it("hides a driver whose CLI was never installed", () => {
    expect(isEngineUnconfigured("`codex` CLI not found")).toBe(true);
  });

  it("hides a driver with no API key or token ever entered", () => {
    expect(isEngineUnconfigured("no xAI API key — add {\"xai\":{\"key\":\"xai-…\"}} to ~/.botfleet/config.json or set XAI_API_KEY")).toBe(true);
    expect(isEngineUnconfigured("no Box token — add {\"box\":{\"token\":\"…\"}} to ~/.botfleet/config.json")).toBe(true);
    expect(isEngineUnconfigured("no API key — set OPENAI_COMPAT_API_KEY or add it to the instance config")).toBe(true);
  });

  it("hides an engine explicitly disabled in settings", () => {
    expect(isEngineUnconfigured("Disabled in settings")).toBe(true);
  });

  it("keeps a configured engine that is merely failing right now", () => {
    // A Box token IS set but the API call failed — this engine is
    // configured and the user relies on it, so its row must stay visible
    // with the real failure reason, not vanish as if never set up.
    expect(isEngineUnconfigured("box API unreachable: fetch failed")).toBe(false);
    expect(isEngineUnconfigured("Codex CLI is out of date (needs 0.151.0+). Run `npm install -g @openai/codex`")).toBe(false);
  });

  it("treats no reason as not-unconfigured", () => {
    expect(isEngineUnconfigured(undefined)).toBe(false);
    expect(isEngineUnconfigured(null)).toBe(false);
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
      { group: "external", label: "Third-Party", remainingPercent: 20, exhausted: false },
    ]);
  });

  it("does not show 0% when the group still has a usable model", () => {
    const groups = antigravityGroupSummary([
      { label: "Gemini 3.1 Pro", modelId: "gemini-3.1-pro-high", remainingPercentage: 0, isExhausted: false },
      { label: "Gemini 3 Flash", modelId: "gemini-3-flash", remainingPercentage: 0.4, isExhausted: false },
    ]);
    expect(groups).toEqual([
      { group: "gemini", label: "Gemini", remainingPercent: 40, exhausted: false },
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

  it("surfaces rolling 5h window countdown and monthly pool reset in headline", () => {
    const now = Date.now();
    const resetTime = new Date(now + (3 * 3600 + 21 * 60 + 5) * 1000).toISOString();
    const groups = antigravityGroupSummary(
      [
        { label: "Gemini 3.1 Pro", modelId: "gemini-3.1-pro-high", remainingPercentage: 0.9, isExhausted: false, resetTime },
        { label: "Claude 4.6 Sonnet", modelId: "claude-sonnet-4-6", remainingPercentage: 0.46, isExhausted: false, resetTime },
      ],
      { remainingPercentage: 0.46 },
    );
    expect(groups[0].headline).toBe("Gemini: 90% available (5h window, resets in 3h 21m); 46% available (monthly pool, resets on ~17th)");
    expect(groups[1].headline).toBe("Third-Party: 46% available (5h window, resets in 3h 21m)");
  });

  it("ties the reset countdown to the model that supplied the displayed percentage, not the earliest reset in the group", () => {
    // The displayed percentage is the MOST RESTRICTIVE reading (10%), not an
    // average — so the reset next to it must be THAT model's reset (4h), not
    // an unrelated 90%-remaining model's earlier 1h reset. Showing "10%
    // available … resets in 1h" would promise replenishment that will not
    // happen then.
    // Offset off an exact hour boundary (4h 5m / 1h 5m, not 4h / 1h) so the
    // countdown's floor()-based rounding can't flake between when `now` is
    // captured here and when the function under test reads its own
    // Date.now() a moment later.
    const now = Date.now();
    const tenPercentResetsIn4h = new Date(now + (4 * 3600 + 5 * 60) * 1000).toISOString();
    const ninetyPercentResetsIn1h = new Date(now + (1 * 3600 + 5 * 60) * 1000).toISOString();
    const groups = antigravityGroupSummary([
      { label: "GPT-OSS 120B", modelId: "gpt-oss-120b-medium", remainingPercentage: 0.1, isExhausted: false, resetTime: tenPercentResetsIn4h },
      { label: "Grok 4", modelId: "grok-4", remainingPercentage: 0.9, isExhausted: false, resetTime: ninetyPercentResetsIn1h },
    ]);
    const thirdParty = groups.find((group) => group.group === "external")!;
    expect(thirdParty.remainingPercent).toBe(10);
    expect(thirdParty.resetAtMs).toBe(Date.parse(tenPercentResetsIn4h));
    expect(thirdParty.headline).toBe("Third-Party: 10% available (5h window, resets in 4h 5m)");
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
