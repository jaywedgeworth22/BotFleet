import { describe, expect, it } from "vitest";
import {
  parseTurnSpendFromEventLog,
  RollingSpendTracker,
  SEVEN_DAYS_MS,
} from "./rolling-spend.ts";

describe("rolling spend calculation", () => {
  const now = 1_788_912_000_000;

  it("parses turn.completed events with valid cost and respects cutoff", () => {
    const lines = [
      JSON.stringify({
        type: "turn.completed",
        provider: "dshAgent",
        createdAt: new Date(now - 1000).toISOString(),
        cost: 0.05,
      }),
      JSON.stringify({
        type: "turn.completed",
        provider: "dshAgent",
        createdAt: new Date(now - SEVEN_DAYS_MS - 1000).toISOString(),
        cost: 0.1,
      }),
      JSON.stringify({
        type: "turn.completed",
        provider: "dshAgent",
        createdAt: new Date(now - 2000).toISOString(),
        cost: 0,
      }),
      JSON.stringify({
        type: "item.completed",
        cost: 0.2,
      }),
      "not json",
    ].join("\n");

    const parsed = parseTurnSpendFromEventLog(lines, now - SEVEN_DAYS_MS);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      at: now - 1000,
      provider: "dshAgent",
      instanceId: undefined,
      costUsd: 0.05,
      billingMode: undefined,
    });
  });

  it("calculates 5h and 7d rolling spend per engine", () => {
    const tracker = new RollingSpendTracker();
    // Turn within 5 hours
    tracker.recordTurn({
      at: now - 1 * 3600 * 1000,
      provider: "claudeAgent",
      costUsd: 0.5,
    });
    // Turn within 7 days but older than 5 hours (e.g. 24h ago)
    tracker.recordTurn({
      at: now - 24 * 3600 * 1000,
      provider: "claudeAgent",
      costUsd: 1.25,
    });
    // DeepSeek turn within 5 hours
    tracker.recordTurn({
      at: now - 30 * 60 * 1000,
      provider: "dshAgent",
      instanceId: "deepseek",
      costUsd: 0.02,
    });

    const spend = tracker.getSpend(now);
    expect(spend.claudeAgent).toEqual({
      spend5hUsd: 0.5,
      spend7dUsd: 1.75,
    });
    // dshAgent, deepseek, and deepseekAgent should all reflect the DeepSeek spend
    expect(spend.dshAgent).toEqual({
      spend5hUsd: 0.02,
      spend7dUsd: 0.02,
    });
    expect(spend.deepseek).toEqual({
      spend5hUsd: 0.02,
      spend7dUsd: 0.02,
    });
    expect(spend.deepseekAgent).toEqual({
      spend5hUsd: 0.02,
      spend7dUsd: 0.02,
    });
  });

  it("prunes turns older than 7 days", () => {
    const tracker = new RollingSpendTracker();
    tracker.recordTurn({
      at: now - SEVEN_DAYS_MS - 5000,
      provider: "minimax",
      costUsd: 0.1,
    });
    const spend = tracker.getSpend(now);
    expect(spend.minimax).toBeUndefined();
  });
});
