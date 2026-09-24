import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CONFIG_KEYS_WITHOUT_PROVIDER_RELOAD, providerReloadKeys } from "./config-reload-keys.ts";

describe("providerReloadKeys", () => {
  it("does not rebuild the fleet for a Computer settings save", () => {
    // The exact body LocalComputerSection's provider toggle PUTs.
    const toggle = {
      botDefaults: {
        computerProviders: { asciiBox: false, selfHostedVps: true, localVm: true, localMac: true },
        vpsMode: "per-bot",
        allowedComputers: ["cloud", "vm", "local"],
      },
    };
    expect(providerReloadKeys(toggle)).toEqual([]);
    expect(providerReloadKeys({ botDefaults: { computers: ["cloud"], cloudBackend: "box" } })).toEqual([]);
  });

  it("still rebuilds for provider credentials, including when mixed with botDefaults", () => {
    expect(providerReloadKeys({ xai: { key: "k" } })).toEqual(["xai"]);
    expect(providerReloadKeys({ botDefaults: {}, minimax: { key: "k" } })).toEqual(["minimax"]);
  });

  it("keeps the display-only keys that were already excluded", () => {
    for (const key of ["profile", "tts", "vps", "rooms", "terminology", "conversationMode"]) {
      expect(CONFIG_KEYS_WITHOUT_PROVIDER_RELOAD.has(key)).toBe(true);
    }
  });

  it("is the filter PUT /api/config uses", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("const reloadKeys = providerReloadKeys(patch);");
  });
});
