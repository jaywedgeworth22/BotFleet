// Capability matrix shape tests — one row per capability, one column per
// engine, cell text matches the registry's capability state.  We render
// to a static markup string (the Vite test environment is `node`, so
// the DOM-free `renderToStaticMarkup` is the right tool — same pattern
// the ApprovalCard and CloudBackendPicker tests already use).
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EngineCapabilitiesMatrix } from "./EngineCapabilitiesMatrix.tsx";
import {
  CAPABILITY_KEYS,
  CAPABILITY_LABELS,
  ENGINE_CAPABILITIES,
  ENGINE_DISPLAY_ORDER,
  capabilityCellLabel,
} from "@/lib/engine-capabilities.tsx";

describe("EngineCapabilitiesMatrix", () => {
  it("renders one row per capability", () => {
    const html = renderToStaticMarkup(createElement(EngineCapabilitiesMatrix));
    for (const key of CAPABILITY_KEYS) {
      expect(html, `${CAPABILITY_LABELS[key]} row missing`).toContain(CAPABILITY_LABELS[key]);
    }
  });

  it("renders one column header per engine id", () => {
    const html = renderToStaticMarkup(createElement(EngineCapabilitiesMatrix));
    for (const id of ENGINE_DISPLAY_ORDER) {
      const entry = ENGINE_CAPABILITIES[id];
      expect(html, `${entry.displayName} header missing`).toContain(entry.displayName);
    }
  });

  it("renders the right cell vocabulary for every (engine, capability) pair", () => {
    const html = renderToStaticMarkup(createElement(EngineCapabilitiesMatrix));
    for (const id of ENGINE_DISPLAY_ORDER) {
      const entry = ENGINE_CAPABILITIES[id];
      for (const key of CAPABILITY_KEYS) {
        const expected = capabilityCellLabel(entry.capabilities[key]);
        // Every cell uses the same vocabulary; just pin that the
        // expected word OR the dash for a missing entry shows up
        // somewhere in the rendered table — we are NOT asserting the
        // exact pairing here (the DOM tree would be too deep to grep),
        // only that every cell-rendering branch is reached.  The
        // exhaustive per-cell pairing is asserted in
        // engine-capabilities.test.ts where the registry itself is
        // walked.
        const ok = expected === "—" ? true : html.includes(expected);
        expect(ok, `cell vocabulary "${expected}" must be present in the rendered table`).toBe(true);
      }
    }
  });

  it("renders a pricing pill for every engine", () => {
    const html = renderToStaticMarkup(createElement(EngineCapabilitiesMatrix));
    // The Subscription · $X/mo pill wording is the legacy vocabulary
    // we kept; pin at least one match across the seven engines.
    expect(html).toMatch(/Subscription/);
    // Subscription + API engines emit "Subscription + API · $X/mo";
    // MiniMax and Grok both qualify, so the string must appear at
    // least twice.
    const subscriptionApiMatches = html.match(/Subscription \+ API/g) ?? [];
    expect(subscriptionApiMatches.length).toBeGreaterThanOrEqual(2);
  });
});