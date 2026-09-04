import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_INSTANCE_ID,
  ANTIGRAVITY_USAGE_SOURCE,
  applyAntigravityUsageToRegistry,
  createAntigravityQuotaPoller,
  findAntigravityUsageBin,
  isAntigravityModelCapped,
  parseAntigravityUsageJson,
  quotaModelsFromSnapshot,
  remainingPercentDisplay,
} from "./antigravity-quota.ts";
import { QuotaCooldownRegistry } from "./model-fallback.ts";

const FIXTURE = {
  timestamp: "2026-09-04T04:20:02.182Z",
  method: "google",
  email: "redacted@example.com",
  models: [
    {
      label: "Claude Opus 4.6 (Thinking)",
      modelId: "claude-opus-4-6-thinking",
      remainingPercentage: 0,
      isExhausted: false,
      resetTime: "2026-09-09T07:04:37Z",
      timeUntilResetMs: 441874826,
      isAutocompleteOnly: false,
    },
    {
      label: "Claude Sonnet 4.6 (Thinking)",
      modelId: "claude-sonnet-4-6",
      remainingPercentage: 0.29751188,
      isExhausted: false,
      resetTime: "2026-09-09T07:04:37Z",
      timeUntilResetMs: 441874826,
      isAutocompleteOnly: false,
    },
    {
      label: "Gemini 2.5 Pro",
      modelId: "gemini-2.5-pro",
      isExhausted: false,
      resetTime: "2026-09-05T03:58:25Z",
      timeUntilResetMs: 85102826,
      isAutocompleteOnly: true,
    },
    {
      label: "Gemini 3.1 Pro (High)",
      modelId: "gemini-3.1-pro-high",
      isExhausted: false,
      resetTime: "2026-09-05T03:58:25Z",
      timeUntilResetMs: 85102826,
      isAutocompleteOnly: false,
    },
    {
      label: "Gemini 3.6 Flash (High)",
      modelId: "gemini-3.6-flash-high",
      isExhausted: true,
      resetTime: "2026-09-05T03:58:25Z",
      timeUntilResetMs: 85102826,
      isAutocompleteOnly: false,
    },
  ],
};

describe("parseAntigravityUsageJson", () => {
  it("reads per-model remaining, exhausted, and autocomplete flags", () => {
    const snapshot = parseAntigravityUsageJson(FIXTURE);
    expect(snapshot.method).toBe("google");
    expect(snapshot.models).toHaveLength(5);
    const opus = snapshot.models.find((model) => model.modelId === "claude-opus-4-6-thinking");
    expect(opus?.remainingPercentage).toBe(0);
    expect(isAntigravityModelCapped(opus!)).toBe(true);
    const sonnet = snapshot.models.find((model) => model.modelId === "claude-sonnet-4-6");
    expect(remainingPercentDisplay(sonnet!)).toBe(29.75);
    expect(isAntigravityModelCapped(sonnet!)).toBe(false);
    const gemini = snapshot.models.find((model) => model.modelId === "gemini-3.1-pro-high");
    expect(gemini?.remainingPercentage).toBeUndefined();
    expect(isAntigravityModelCapped(gemini!)).toBe(true);
    const flash = snapshot.models.find((model) => model.modelId === "gemini-3.6-flash-high");
    expect(isAntigravityModelCapped(flash!)).toBe(true);
    const ac = snapshot.models.find((model) => model.modelId === "gemini-2.5-pro");
    expect(isAntigravityModelCapped(ac!)).toBe(false);
  });

  it("rejects a payload without models", () => {
    expect(() => parseAntigravityUsageJson({ timestamp: "now" })).toThrow(/models/);
  });
});

describe("applyAntigravityUsageToRegistry", () => {
  it("caps N/A remaining (Gemini) and remaining 0, and leaves remaining>0 available", () => {
    const registry = new QuotaCooldownRegistry();
    const snapshot = parseAntigravityUsageJson(FIXTURE);
    const applied = applyAntigravityUsageToRegistry(snapshot, registry, Date.parse("2026-09-04T04:20:02.182Z"));
    expect(applied.capped.sort()).toEqual([
      "claude-opus-4-6-thinking",
      "gemini-3.1-pro-high",
      "gemini-3.6-flash-high",
    ]);
    expect(registry.get("any-bot", ANTIGRAVITY_INSTANCE_ID, "claude-opus-4-6-thinking")).toMatchObject({
      source: ANTIGRAVITY_USAGE_SOURCE,
      model: "claude-opus-4-6-thinking",
    });
    expect(registry.get("any-bot", ANTIGRAVITY_INSTANCE_ID, "claude-sonnet-4-6")).toBeUndefined();
    expect(registry.get("any-bot", ANTIGRAVITY_INSTANCE_ID, "gemini-3.1-pro-high")).toBeDefined();
    expect(registry.get("any-bot", ANTIGRAVITY_INSTANCE_ID, "gemini-2.5-pro")).toBeUndefined();
    const overlay = quotaModelsFromSnapshot(snapshot);
    expect(overlay["claude-sonnet-4-6"]?.capped).toBe(false);
    expect(overlay["claude-sonnet-4-6"]?.remainingPercent).toBe(29.75);
    expect(overlay["gemini-3.1-pro-high"]?.capped).toBe(true);
    expect(overlay["gemini-3.1-pro-high"]?.remainingPercent).toBe(0);
  });

  it("clears a previously capped model once remaining recovers", () => {
    const registry = new QuotaCooldownRegistry();
    const first = parseAntigravityUsageJson(FIXTURE);
    applyAntigravityUsageToRegistry(first, registry);
    expect(registry.get("bot", ANTIGRAVITY_INSTANCE_ID, "claude-opus-4-6-thinking")).toBeDefined();

    const recovered = structuredClone(FIXTURE);
    recovered.models[0].remainingPercentage = 0.5;
    recovered.models[0].isExhausted = false;
    applyAntigravityUsageToRegistry(parseAntigravityUsageJson(recovered), registry);
    expect(registry.get("bot", ANTIGRAVITY_INSTANCE_ID, "claude-opus-4-6-thinking")).toBeUndefined();
    expect(registry.get("bot", ANTIGRAVITY_INSTANCE_ID, "gemini-3.6-flash-high")).toBeDefined();
  });

  it("does not clear chip-sourced cooldowns on a different engine", () => {
    const registry = new QuotaCooldownRegistry();
    registry.recordInstanceCap("grok", "*", { error: "session limit", source: "chip" });
    applyAntigravityUsageToRegistry(parseAntigravityUsageJson(FIXTURE), registry);
    expect(registry.get("bot", "grok", "grok-4.6")).toBeDefined();
  });
});

describe("createAntigravityQuotaPoller", () => {
  it("parses injected CLI JSON and records cooldowns", async () => {
    const registry = new QuotaCooldownRegistry();
    const poller = createAntigravityQuotaPoller({
      registry,
      exec: async () => JSON.stringify(FIXTURE),
      log: () => {},
    });
    const snapshot = await poller.tick(true);
    expect(snapshot?.models).toHaveLength(5);
    expect(registry.get("bot", ANTIGRAVITY_INSTANCE_ID, "gemini-3.6-flash-high")?.error).toMatch(
      /antigravity-usage/,
    );
    poller.stop();
  });

  it("leaves cooldowns alone when the CLI is missing", async () => {
    const registry = new QuotaCooldownRegistry();
    registry.recordInstanceCap(ANTIGRAVITY_INSTANCE_ID, "claude-opus-4-6-thinking", {
      error: "prior",
      source: ANTIGRAVITY_USAGE_SOURCE,
    });
    const poller = createAntigravityQuotaPoller({
      registry,
      exec: async () => {
        const error = new Error("spawn antigravity-usage ENOENT");
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      },
      log: () => {},
    });
    await poller.tick(true);
    expect(registry.get("bot", ANTIGRAVITY_INSTANCE_ID, "claude-opus-4-6-thinking")?.error).toBe("prior");
    poller.stop();
  });
});

describe("findAntigravityUsageBin", () => {
  it("prefers ANTIGRAVITY_USAGE_BIN when the file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-usage-"));
    const bin = join(dir, "antigravity-usage");
    writeFileSync(bin, "");
    expect(findAntigravityUsageBin({ ANTIGRAVITY_USAGE_BIN: bin }, (path) => path === bin)).toBe(bin);
  });
});
