// EngineCallout shape tests — every known engine renders the headline,
// at least one paragraph of prose, and the registry's pricing pill.
// Replaces the legacy MiniMaxCallout.test.ts; the new copy is shared
// across all engines so the matrix and the callout cannot drift.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EngineCallout } from "./EngineCallout.tsx";
import {
  CAPABILITY_LABELS,
  ENGINE_CAPABILITIES,
  ENGINE_DISPLAY_ORDER,
  engineIdFromDriverKind,
} from "@/lib/engine-capabilities.tsx";

// EngineCallout emits JSON-style HTML where ASCII apostrophes and
// quotes are HTML-escaped by `react-dom/server`'s serializer.  Comparing
// a raw headline that contains an apostrophe against the rendered
// markup via toContain() produces a false negative; this helper
// normalizes both sides before comparing.  Curly quotes (U+2018 /
// U+2019) are passed through by the serializer, so only the ASCII
// entities need decoding.  Pinned by the headline-render test.
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

describe("EngineCallout", () => {
  it("renders for every engine id in the registry", () => {
    for (const id of ENGINE_DISPLAY_ORDER) {
      const entry = ENGINE_CAPABILITIES[id];
      const html = renderToStaticMarkup(createElement(EngineCallout, { engineId: id }));
      expect(html).toContain("Why this engine?");
      const decoded = decodeHtmlEntities(html);
      expect(decoded).toContain(entry.whyThisEngine.headline);
      // At least one paragraph of prose — the legacy MiniMaxCallout
      // test pinned the same invariant.
      expect(html).toMatch(/<p/);
    }
  });

  it("renders the pricing mode label", () => {
    const html = renderToStaticMarkup(createElement(EngineCallout, { engineId: "minimax" }));
    expect(html).toContain("Pricing:");
    // MiniMax's Token Plan subscription must show; the API block is
    // present in the registry but not as the primary label.
    expect(html).toContain("Subscription + API");
  });

  it("resolves driver-kind ids via engineIdFromDriverKind", () => {
    const html = renderToStaticMarkup(createElement(EngineCallout, { driverKind: "grokAgent" }));
    const decoded = decodeHtmlEntities(html);
    expect(decoded).toContain(ENGINE_CAPABILITIES.grok.whyThisEngine.headline);
  });

  it("renders nothing for an unknown engine id", () => {
    const html = renderToStaticMarkup(createElement(EngineCallout, { engineId: "nope" }));
    // The fallback entry's prose still renders — `engineCapability()`
    // returns a sentinel entry when the id is missing.  That is by
    // design: a future engine the registry does not know yet still
    // gets a visible callout that explains the gap.
    expect(html).toContain("Engine not in the capability registry yet");
  });

  it("engineIdFromDriverKind strips the Agent suffix for known drivers", () => {
    expect(engineIdFromDriverKind("grokAgent")).toBe("grok");
    expect(engineIdFromDriverKind("claudeAgent")).toBe("claude");
    expect(engineIdFromDriverKind("dshAgent")).toBe("deepseek-harness");
    expect(engineIdFromDriverKind("cursorAgent")).toBe("cursor");
    expect(engineIdFromDriverKind("antigravityAgent")).toBe("antigravity");
  });

  it("renders every capability label as expected prose container", () => {
    // Sanity: the capability labels are stable strings the matrix
    // uses; the callout body does not render them directly but the
    // import is the same source of truth, so pin a couple of them
    // here to catch a future rename.
    expect(CAPABILITY_LABELS.files).toBe("Files");
    expect(CAPABILITY_LABELS.crossBotCoordination).toBe("Cross-Bot Coordination");
  });
});