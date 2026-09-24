import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AllowedComputersSummary, allowedSummaryRows } from "./BotComputerDefaults";

describe("AllowedComputersSummary", () => {
  it("renders the legacy allowlist without any control that could turn a destination off", () => {
    for (const allowed of [null, ["cloud", "local"] as const, [] as const]) {
      const html = renderToStaticMarkup(createElement(AllowedComputersSummary, { allowed: allowed === null ? null : [...allowed] }));
      expect(html).toContain("Allowed Computers");
      expect(html).not.toContain("<button");
      expect(html).not.toContain("onclick");
    }
  });

  it("points the operator at the Providers card, which confirms affected bots", () => {
    const html = renderToStaticMarkup(createElement(AllowedComputersSummary, { allowed: null }));
    expect(html).toContain("This mirrors the Providers card above");
    expect(html).toContain("shows which bots it affects");
  });

  it("still shows which destinations the Providers card allowed", () => {
    const html = renderToStaticMarkup(createElement(AllowedComputersSummary, { allowed: ["vm"] }));
    expect(html).toContain('aria-label="Local VM: allowed"');
    expect(html).toContain('aria-label="This Computer: not allowed"');
    expect(html).toContain('aria-label="ASCII.dev Box (VM): not allowed"');
    expect(html).toContain("1 of 3 destinations allowed.");
  });

  it("keeps ASCII.dev Box and the self-hosted VPS apart when the Providers card split them", () => {
    // Box off, VPS on: the legacy allowlist folds both into "cloud", which
    // lit the Box row up as allowed while the Box toggle is off.
    const providers = { asciiBox: false, selfHostedVps: true, localVm: false, localMac: true };
    const html = renderToStaticMarkup(createElement(AllowedComputersSummary, { allowed: ["cloud", "local"], providers }));
    expect(html).toContain('aria-label="ASCII.dev Box (VM): not allowed"');
    expect(html).toContain('aria-label="Self-hosted VPS: allowed"');
    expect(html).toContain('aria-label="Local VM: not allowed"');
    expect(html).toContain('aria-label="This Computer: allowed"');
    expect(html).toContain("2 of 4 destinations allowed.\u00a0 A bot");
  });

  it("maps every provider to its own summary row", () => {
    expect(allowedSummaryRows(null, { asciiBox: true, selfHostedVps: false, localVm: true, localMac: true })).toEqual([
      { key: "box", label: "ASCII.dev Box (VM)", enabled: true },
      { key: "vps", label: "Self-hosted VPS", enabled: false },
      { key: "vm", label: "Local VM", enabled: true },
      { key: "local", label: "This Computer", enabled: true },
    ]);
    // Without the per-provider shape the legacy three rows stay.
    expect(allowedSummaryRows(["cloud"]).map((r) => [r.key, r.enabled])).toEqual([
      ["cloud", true],
      ["vm", false],
      ["local", false],
    ]);
    const all = renderToStaticMarkup(
      createElement(AllowedComputersSummary, {
        allowed: null,
        providers: { asciiBox: true, selfHostedVps: true, localVm: true, localMac: true },
      }),
    );
    expect(all).toContain("Every destination is allowed");
  });

  it("keeps the two-space sentence gaps the summary renders", () => {
    // Subtitles and footers render in plain divs, where two ASCII spaces
    // collapse; the copy rule's NBSP + space pair survives.
    const html = renderToStaticMarkup(createElement(AllowedComputersSummary, { allowed: [] }));
    expect(html).toContain("allowed to use.\u00a0 This mirrors");
    expect(html).toContain("No destination is allowed.\u00a0 Every bot");
    expect(html).not.toMatch(/\.  [A-Z]/);
  });

  it("never lets a legacy save change the allowlist", () => {
    // The only writer of `allowedComputers` in this card re-sends the value
    // the Providers card last saved; a disable must go through that card's
    // affected-bot confirmation instead.
    const source = readFileSync(new URL("./BotComputerDefaults.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/save\(\{\s*allowed:/);
    // Nor any other provider policy: a save sends only the computer defaults,
    // so a stale card cannot write old provider flags back.
    const save = source.slice(source.indexOf("const save = ("), source.indexOf("const applyDefaults = ()"));
    expect(save).toContain("computers: nextComputers,");
    expect(save).toContain("cloudBackend: nextBackend,");
    expect(save).not.toContain("computerProviders");
    expect(save).not.toContain("allowedComputers");
    expect(save).not.toContain("vpsMode");
  });
});
