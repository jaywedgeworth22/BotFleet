// Capability registry invariants.  Anything the matrix, the callout, or
// the projection reads depends on the shape of `ENGINE_CAPABILITIES`, so
// the schema tests catch additions before they ship with a missing key
// or a half-filled pricing block.
import { describe, expect, it } from "vitest";

import {
  CAPABILITY_KEYS,
  ENGINE_CAPABILITIES,
  ENGINE_DISPLAY_ORDER,
  capabilityCellLabel,
  engineIdFromDriverKind,
  pricingModeLabel,
  type CapabilityKey,
  type PricingMode,
} from "./engine-capabilities.tsx";

const KNOWN_ENGINE_IDS = [
  "grok",
  "cursor",
  "claude",
  "codex",
  "antigravity",
  "deepseek-harness",
  "minimax",
];

describe("ENGINE_CAPABILITIES registry", () => {
  it("exposes one entry for every known engine id", () => {
    for (const id of KNOWN_ENGINE_IDS) {
      expect(ENGINE_CAPABILITIES[id], `missing registry entry for ${id}`).toBeDefined();
      expect(ENGINE_CAPABILITIES[id].id).toBe(id);
      expect(ENGINE_CAPABILITIES[id].displayName.length).toBeGreaterThan(0);
    }
  });

  it("covers every capability key in the matrix", () => {
    // Cells in the matrix need a value for every (engine, capability)
    // pair — `capabilityCellLabel` returns "—" when the cell is missing.
    // We require at least one entry per capability, so the matrix shows
    // the row rather than rendering nothing.
    const seen = new Set<CapabilityKey>();
    for (const entry of Object.values(ENGINE_CAPABILITIES)) {
      for (const key of Object.keys(entry.capabilities) as CapabilityKey[]) {
        seen.add(key);
      }
    }
    for (const key of CAPABILITY_KEYS) {
      expect(seen.has(key), `no engine declares the "${key}" capability`).toBe(true);
    }
  });

  it("has at least one default model per engine", () => {
    for (const [id, entry] of Object.entries(ENGINE_CAPABILITIES)) {
      expect(entry.defaultModels.length, `${id} must declare at least one default model`).toBeGreaterThan(0);
      for (const model of entry.defaultModels) {
        expect(model.id.length).toBeGreaterThan(0);
        expect(model.display.length).toBeGreaterThan(0);
      }
    }
  });

  it("fills in both blocks of every subscription+api pricing mode", () => {
    for (const [id, entry] of Object.entries(ENGINE_CAPABILITIES)) {
      if (entry.pricing.kind !== "subscription+api") continue;
      // The task spec is explicit: a `subscription+api` row must have
      // BOTH blocks filled in.  A row with only the subscription block
      // would render "Subscription" in the matrix but "API $X/1k" in the
      // projection — the inconsistency the rewrite removes.
      expect(entry.pricing.subscription.tierLabel.length, `${id}.subscription.tierLabel`).toBeGreaterThan(0);
      expect(Number.isFinite(entry.pricing.api.inputPer1k), `${id}.api.inputPer1k must be a finite number`).toBe(true);
      expect(Number.isFinite(entry.pricing.api.outputPer1k), `${id}.api.outputPer1k must be a finite number`).toBe(true);
    }
  });

  it("fills in subscription.tierLabel for every subscription engine", () => {
    for (const [id, entry] of Object.entries(ENGINE_CAPABILITIES)) {
      const pricing = entry.pricing as PricingMode;
      if (pricing.kind === "subscription" || pricing.kind === "subscription+api") {
        expect(pricing.subscription.tierLabel.length, `${id} subscription.tierLabel`).toBeGreaterThan(0);
      }
    }
  });

  it("lists every engine id in ENGINE_DISPLAY_ORDER", () => {
    expect(new Set(ENGINE_DISPLAY_ORDER)).toEqual(new Set(KNOWN_ENGINE_IDS));
  });

  it("engineIdFromDriverKind maps known driver kinds to registry ids", () => {
    expect(engineIdFromDriverKind("grok")).toBe("grok");
    expect(engineIdFromDriverKind("grokAgent")).toBe("grok");
    expect(engineIdFromDriverKind("claude")).toBe("claude");
    expect(engineIdFromDriverKind("claudeAgent")).toBe("claude");
    expect(engineIdFromDriverKind("dshAgent")).toBe("deepseek-harness");
    expect(engineIdFromDriverKind("dsh")).toBe("deepseek-harness");
    expect(engineIdFromDriverKind("deepseekAgent")).toBe("deepseek-harness");
    expect(engineIdFromDriverKind("deepseek")).toBe("deepseek-harness");
    expect(engineIdFromDriverKind("antigravityAgent")).toBe("antigravity");
    expect(engineIdFromDriverKind("minimax")).toBe("minimax");
    expect(engineIdFromDriverKind("unknown-engine")).toBeNull();
    expect(engineIdFromDriverKind(undefined)).toBeNull();
  });

  it("marks connectedApps 'yes' for every engine whose driver declares composioMcp", () => {
    // The matrix rendered "-" for Claude and Codex because the registry
    // omitted the key while their drivers declare composioMcp
    // (server/drivers/claude.ts, codex.ts, antigravity.ts, and the DSH
    // ACP adapter).  A missing key renders as "-", which reads as
    // "engine cannot do this" — the exact underclaim Codex flagged.
    for (const id of ["claude", "codex", "antigravity", "deepseek-harness"]) {
      expect(ENGINE_CAPABILITIES[id].capabilities.connectedApps, id).toBe("yes");
    }
  });

  it("marks MiniMax connectedApps as 'no' — the driver has no composioMcp", () => {
    // Connected Apps is the Composio bridge, and MiniMax's direct
    // driver declares no composioMcp in server/drivers/minimax.ts
    // (Claude, Codex, Antigravity, pi, and the DSH ACP adapter all
    // declare it).  'limited' still implied a partial channel that does
    // not exist; driving this Mac is the thisComputer row
    // (localComputerMcp), a different thing.  Pin 'no' so a future edit
    // cannot silently regress the matrix to overclaim.
    expect(ENGINE_CAPABILITIES.minimax.capabilities.connectedApps).toBe("no");
  });

  it("pricingModeLabel reads consistently with the pricing block", () => {
    expect(pricingModeLabel({ kind: "free" })).toContain("Free");
    expect(pricingModeLabel({ kind: "unknown" })).toContain("unknown");
    const subscription: PricingMode = {
      kind: "subscription",
      subscription: { tierLabel: "Test", costPerMonth: 9.99 },
    };
    expect(pricingModeLabel(subscription)).toContain("$9.99/mo");
    const api: PricingMode = {
      kind: "api",
      api: { inputPer1k: 0.001, outputPer1k: 0.004 },
    };
    expect(pricingModeLabel(api)).toContain("API");
  });

  it("capabilityCellLabel returns the legacy vocabulary", () => {
    expect(capabilityCellLabel("yes")).toBe("✓");
    expect(capabilityCellLabel("no")).toBe("✗");
    expect(capabilityCellLabel("limited")).toBe("limited");
    expect(capabilityCellLabel("yes-pro-only")).toBe("pro only");
    expect(capabilityCellLabel(undefined)).toBe("—");
  });
});
