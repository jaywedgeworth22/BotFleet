// The registry and the stylesheet are two halves of one contract: a skin listed
// here without a matching CSS block renders as whatever was active before, with
// no error anywhere. That failure is silent, so it gets a test.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isDarkSkin, SKINS, SKIN_IDS } from "./skins";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../styles.css"),
  "utf8",
);

const blocks = new Set(
  [...css.matchAll(/\[data-skin="([a-z-]+)"\]/g)].map(([, id]) => id),
);

/** `system` and `custom` are virtual/dynamic skins that do not have static CSS blocks. */
const STYLE_SKIN_IDS = SKIN_IDS.filter((id) => id !== "system" && id !== "custom");

describe("skins", () => {
  it("gives every registered skin a stylesheet block", () => {
    for (const id of STYLE_SKIN_IDS) expect(blocks).toContain(id);
  });

  it("registers every stylesheet block", () => {
    // SAFETY: the assertion only fits toContain()'s parameter type — the
    // assertion IS the check, and an unregistered block fails the test.
    for (const id of blocks) expect(SKIN_IDS).toContain(id as (typeof SKIN_IDS)[number]);
  });

  it("defines the same tokens in every skin", () => {
    const tokensOf = (id: string) => {
      const body = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      return new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name));
    };
    const reference = tokensOf("midnight");
    expect(reference.size).toBeGreaterThan(15);
    for (const id of STYLE_SKIN_IDS) {
      expect([...reference].filter((t) => !tokensOf(id).has(t))).toEqual([]);
    }
  });

  it("describes each skin exactly once", () => {
    expect(SKINS.map((s) => s.id).sort()).toEqual([...SKIN_IDS].sort());
    for (const skin of SKINS) {
      expect(skin.name.length).toBeGreaterThan(0);
      expect(skin.tagline.length).toBeGreaterThan(0);
    }
  });

  it("defaults @theme and :root to Studio so a FOUC is light-first", () => {
    expect(css).toMatch(/Defaults = Studio \(light-first\)/);
    const theme = css.match(/@theme \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const root = css.match(/:root \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(theme).toContain("--color-app: #f6f8fa");
    expect(theme).toContain("--color-ink: #111418");
    expect(root).toContain("--color-scrollbar: #c2cbd4");
    expect(root).toContain("--color-maus-line: #57606a");
    expect(css).toContain('[data-skin="midnight"]');
  });
});

// isDarkSkin() picks the Shiki theme for code fences
// (a11y-theme-copy:code-fence-dark-shiki-on-light-default) — a wrong answer
// here means dark-on-dark or light-on-light tokens somewhere.
describe("isDarkSkin", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is true only for the two dark presets", () => {
    for (const id of STYLE_SKIN_IDS) {
      expect(isDarkSkin(id)).toBe(id === "midnight" || id === "foundry");
    }
  });

  it("reads custom from the palette the user actually picked, not a guess", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "omb-custom-palette" ? JSON.stringify({ appBg: "#0b0d10" }) : null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(isDarkSkin("custom")).toBe(true);

    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "omb-custom-palette" ? JSON.stringify({ appBg: "#f8fafc" }) : null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(isDarkSkin("custom")).toBe(false);
  });

  it("falls back to the light default custom palette when nothing is stored", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(isDarkSkin("custom")).toBe(false);
  });
});
