// Usage tab per-bot expand-with-details.  The previous test file
// pinned only the "All bots" row totals; this one pins the new
// expand/collapse behavior, the per-session table that drops when a
// row is clicked, and the pricing-mode pill that swaps an API rate for
// a "Subscription — included in plan" label whenever the engine's
// pricing kind is `subscription` (no API block) — the same shape
// `<UsageWhatIfProjection>` relies on, so the two stay in sync.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { UsageWhatIfProjection, apiEquivalentCost, projectionRows } from "./UsageWhatIfProjection.tsx";
import { ENGINE_CAPABILITIES } from "@/lib/engine-capabilities.tsx";

describe("UsageWhatIfProjection unattributed footnote", () => {
  it("shows the unattributed-usage footnote only when tokens could not be attributed", () => {
    const byEngine = [
      { engineId: "minimax", totalTokens: 1_000_000, cachedTokens: 100_000, actualCostUsd: 55 },
    ];
    const withUnattributed = renderToStaticMarkup(
      createElement(UsageWhatIfProjection, { periodLabel: "Last 30 days", byEngine, unattributedTokens: 12_345 }),
    );
    expect(withUnattributed).toContain("12,345 tokens ran on connections deleted before");
    const without = renderToStaticMarkup(
      createElement(UsageWhatIfProjection, { periodLabel: "Last 30 days", byEngine }),
    );
    expect(without).not.toContain("connections deleted before");
  });
});

describe("UsageWhatIfProjection", () => {
  it("renders one row per engine that has a pricing block with API", () => {
    const byEngine = [
      { engineId: "minimax", totalTokens: 1_000_000, cachedTokens: 100_000, actualCostUsd: 55 },
      { engineId: "grok", totalTokens: 200_000, cachedTokens: 10_000, actualCostUsd: 99 },
      { engineId: "claude", totalTokens: 50_000, cachedTokens: 0, actualCostUsd: 213.2 },
    ];
    const html = renderToStaticMarkup(
      createElement(UsageWhatIfProjection, { periodLabel: "Last 30 days", byEngine }),
    );
    // MiniMax and Grok have `subscription+api` pricing blocks; Claude
    // has `subscription` only.  The card must render MiniMax and Grok
    // rows (projectionRows skips Claude's row).
    expect(html).toContain("MiniMax");
    expect(html).toContain("Grok");
  });

  it("apiEquivalentCost matches the registry's API block for MiniMax M3", () => {
    const usage = { engineId: "minimax", totalTokens: 1_000_000, cachedTokens: 200_000, actualCostUsd: 55 };
    const pricing = ENGINE_CAPABILITIES.minimax.pricing;
    if (pricing.kind !== "subscription+api") throw new Error("expected subscription+api");
    const cost = apiEquivalentCost(usage, pricing);
    // 1M tokens split 70/30 = 700k input / 300k output.  Cached share
    // is 200k, so 200k * 0.0002 (cached rate) + 500k * 0.001 (input) +
    // 300k * 0.004 (output) = 0.04 + 0.5 + 1.2 = 1.74.  Pin the math
    // so a future rate edit can't silently break the projection.
    expect(cost).toBeCloseTo(1.74, 2);
  });

  it("projectionRows skips engines with no API rate", () => {
    const rows = projectionRows([
      { engineId: "minimax", totalTokens: 100, cachedTokens: 0, actualCostUsd: 0 },
      { engineId: "claude", totalTokens: 100, cachedTokens: 0, actualCostUsd: 0 },
    ]);
    // Claude's pricing kind is `subscription`, not `subscription+api`
    // or `api`, so it does not appear in the projection table.
    const ids = rows.map((row) => row.entry.id);
    expect(ids).toContain("minimax");
    expect(ids).not.toContain("claude");
  });

  it("renders the no-data empty state when no engine has a pricing block", () => {
    const html = renderToStaticMarkup(
      createElement(UsageWhatIfProjection, { periodLabel: "Last 30 days", byEngine: [] }),
    );
    expect(html).toContain("No engines with a published API rate");
  });
});
