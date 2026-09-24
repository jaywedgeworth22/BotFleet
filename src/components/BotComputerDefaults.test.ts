import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AllowedComputersSummary } from "./BotComputerDefaults";

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
