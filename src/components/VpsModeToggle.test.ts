import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VpsModeToggle } from "./VpsModeToggle";

describe("VpsModeToggle", () => {
  it("keeps the two-space sentence gap in the per-bot caption", () => {
    // The caption renders in a plain <p>, where two ASCII spaces collapse to
    // one; the copy rule's NBSP + space pair survives HTML whitespace rules.
    const html = renderToStaticMarkup(createElement(VpsModeToggle, { value: "per-bot", onChange: () => {} }));
    expect(html).toContain("loopback viewer.\u00a0 Idle desktops stop on their own after 8 hours.");
    expect(html).not.toMatch(/\. [A-Z]/);
  });
});
