import { describe, expect, it } from "vitest";

import {
  antigravityQuotaHeadlines,
  antigravityQuotaCapped,
  antigravityQuotaLines,
  antigravityQuotaWindows,
  isBotFleetQuotaWindow,
  isMiniMaxVideoQuotaWindow,
  type UsageMonitorQuotaWindow,
} from "./usage-monitor-quota";

function window(overrides: Partial<UsageMonitorQuotaWindow>): UsageMonitorQuotaWindow {
  return {
    id: "fixture",
    provider: "google-antigravity",
    providerKey: "google-antigravity",
    sourceApp: "local-mac",
    label: "fixture",
    remainingPercent: 50,
    resetAt: null,
    skip: false,
    window: "5h",
    ...overrides,
  };
}

describe("Usage Monitor BotFleet quota integration", () => {
  it("renders exactly the two Antigravity pools across 5-hour and weekly windows", () => {
    const rows = antigravityQuotaWindows([
      window({ id: "gemini-week", label: "Gemini Models · Weekly", window: "weekly", remainingPercent: 75 }),
      window({ id: "third-5h", label: "Third-Party Models · 5-hour", window: "5h", remainingPercent: 20 }),
      window({ id: "gemini-5h", label: "Gemini Models · 5-hour", window: "5h", remainingPercent: 80 }),
      window({ id: "third-week", label: "Third-Party Models · Weekly", window: "weekly", remainingPercent: null }),
    ]);

    expect(rows.map((row) => `${row.label}:${row.window}`)).toEqual([
      "Gemini Models · 5-hour:5h",
      "Gemini Models · Weekly:weekly",
      "Third-Party Models · 5-hour:5h",
      "Third-Party Models · Weekly:weekly",
    ]);
    expect(antigravityQuotaLines(rows).map((line) => line.value)).toEqual(["80%", "75%", "20%", "not reported"]);
  });

  it("fills an incomplete Antigravity report with explicit unknown rows", () => {
    const rows = antigravityQuotaWindows([
      window({ label: "Gemini Models · 5-hour", window: "5h", remainingPercent: 80 }),
    ]);

    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.label === "Third-Party Models · Weekly")?.remainingPercent).toBeNull();
    expect(rows.find((row) => row.label === "Third-Party Models · Weekly")?.skip).toBe(false);
  });

  it("prefers the newest observation before applying the conservative percentage tie-break", () => {
    const old = "2026-09-13T08:00:00.000Z";
    const fresh = "2026-09-13T09:00:00.000Z";
    const rows = antigravityQuotaWindows([
      window({ id: "old", label: "Gemini Models · 5-hour", window: "5h", remainingPercent: 10, occurredAt: old }),
      window({ id: "fresh", label: "Gemini Models · 5-hour", window: "5h", remainingPercent: 80, occurredAt: fresh }),
      window({ id: "tie-high", label: "Third-Party Models · Weekly", window: "weekly", remainingPercent: 80, occurredAt: fresh }),
      window({ id: "tie-low", label: "Third-Party Models · Weekly", window: "weekly", remainingPercent: 20, occurredAt: fresh }),
    ]);

    expect(rows[0].id).toBe("fresh");
    expect(rows[3].id).toBe("tie-low");
  });

  it("caps Antigravity only when both shared pools have an exhausted period", () => {
    const onePool = [
      window({ label: "Gemini Models · 5-hour", window: "5h", remainingPercent: 0 }),
      window({ label: "Gemini Models · Weekly", window: "weekly", remainingPercent: 80 }),
      window({ label: "Third-Party Models · 5-hour", window: "5h", remainingPercent: 40 }),
      window({ label: "Third-Party Models · Weekly", window: "weekly", remainingPercent: 60 }),
    ];
    expect(antigravityQuotaCapped(onePool)).toBe(false);
    expect(antigravityQuotaCapped([
      ...onePool,
      window({ id: "third-exhausted", label: "Third-Party Models · 5-hour", window: "5h", remainingPercent: 0 }),
    ])).toBe(true);
  });

  it("uses the selected window reset in the headline without changing pool identity", () => {
    const resetAt = new Date(Date.now() + 3_660_000).toISOString();
    const lines = antigravityQuotaHeadlines([
      window({ label: "Gemini Models · 5-hour", window: "5h", remainingPercent: 80, resetAt }),
      window({ label: "Third-Party Models · Weekly", window: "weekly", remainingPercent: 20 }),
    ]);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("Gemini Models · 5-hour 80% available");
    expect(lines[0]).toContain("resets in 1h");
  });

  it("keeps BotFleet Grok support while excluding non-BotFleet providers", () => {
    expect(isBotFleetQuotaWindow(window({ provider: "xai", providerKey: "xai", label: "Grok 5h" }))).toBe(true);
    for (const provider of ["gemini-cli", "windsurf", "github-copilot", "copilot", "kimi", "moonshot"]) {
      expect(isBotFleetQuotaWindow(window({ provider, providerKey: provider, label: provider }))).toBe(false);
    }
  });

  it("recognizes legacy subscriptions without borrowing Antigravity's Claude models", () => {
    expect(isBotFleetQuotaWindow(window({ provider: "claude-code", providerKey: undefined }))).toBe(true);
    expect(antigravityQuotaWindows([window({ provider: "anthropic", providerKey: undefined, via: "antigravity", label: "Third-Party Models · Weekly", window: "weekly" })])).toHaveLength(4);
    expect(isBotFleetQuotaWindow(window({ provider: "Grok Bot", providerKey: "xai" }))).toBe(false);
  });

  it("requires a Codex source identity for a bare OpenAI provider", () => {
    expect(isBotFleetQuotaWindow(window({ provider: "openai", providerKey: "openai", sourceApp: "codex-cli", label: "Codex 5h" }))).toBe(true);
    expect(isBotFleetQuotaWindow(window({ provider: "openai", providerKey: "openai", sourceApp: "openrouter", label: "GPT 5h" }))).toBe(false);
  });

  it("deemphasizes MiniMax video and Hailuo windows", () => {
    expect(isMiniMaxVideoQuotaWindow({ provider: "minimax", label: "Hailuo Video" })).toBe(true);
    expect(isMiniMaxVideoQuotaWindow({ provider: "minimax", label: "M3" })).toBe(false);
    expect(isMiniMaxVideoQuotaWindow({ provider: "xai", label: "Hailuo Video" })).toBe(false);
  });
});
