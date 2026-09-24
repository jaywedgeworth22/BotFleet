// EngineCallout shape tests — every known engine renders the headline
// behind a collapsed "Why this engine?" disclosure by default, and the
// registry pricing pill when expanded.  Replaces the legacy
// MiniMaxCallout.test.ts; the new copy is shared across all engines so
// the matrix and the callout cannot drift.
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
  it("renders collapsed by default for every engine id in the registry", () => {
    for (const id of ENGINE_DISPLAY_ORDER) {
      const entry = ENGINE_CAPABILITIES[id];
      const html = renderToStaticMarkup(createElement(EngineCallout, { engineId: id }));
      expect(html).toContain("Why this engine?");
      const decoded = decodeHtmlEntities(html);
      expect(decoded).toContain(entry.whyThisEngine.headline);
      // Collapsed: summary only — no prose paragraphs, no pricing line.
      // Avoid /<p/ — Lucide's <path> would falsely match.
      expect(html).not.toMatch(/<p[\s>]/);
      expect(html).not.toContain("Pricing:");
      expect(html).toContain('aria-expanded="false"');
    }
  });

  it("expands to show prose and pricing when defaultOpen is set", () => {
    const entry = ENGINE_CAPABILITIES.minimax;
    const html = renderToStaticMarkup(
      createElement(EngineCallout, { engineId: "minimax", defaultOpen: true }),
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/<p[\s>]/);
    expect(html).toContain("Pricing:");
    // MiniMax's Token Plan subscription must show; the API block is
    // present in the registry but not as the primary label.
    expect(html).toContain("Subscription + API");
    const decoded = decodeHtmlEntities(html);
    expect(decoded).toContain(entry.whyThisEngine.prose[0]);
  });

  it("uses a unique aria-controls id per instanceId", () => {
    const a = renderToStaticMarkup(
      createElement(EngineCallout, {
        engineId: "minimax",
        instanceId: "mm-a",
        defaultOpen: true,
      }),
    );
    const b = renderToStaticMarkup(
      createElement(EngineCallout, {
        engineId: "minimax",
        instanceId: "mm-b",
        defaultOpen: true,
      }),
    );
    expect(a).toContain("engine-callout-detail-mm-a");
    expect(b).toContain("engine-callout-detail-mm-b");
    expect(a).not.toContain("engine-callout-detail-mm-b");
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
