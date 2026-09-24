import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CONFIG_KEYS_WITHOUT_PROVIDER_RELOAD,
  disabledComputerProviders,
  legacyAllowlistRevokedProviders,
  providerReloadKeys,
  revokedComputerProviders,
  turnUsesComputerProvider,
} from "./config-reload-keys.ts";

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

describe("disabledComputerProviders", () => {
  const all = { asciiBox: true, selfHostedVps: true, localVm: true, localMac: true };
  it("names only the providers a save turned from on to off", () => {
    expect(disabledComputerProviders(all, { ...all, localMac: false })).toEqual(["localMac"]);
    expect(disabledComputerProviders({ ...all, localVm: false }, all)).toEqual([]);
    expect(disabledComputerProviders(all, all)).toEqual([]);
  });

  it("treats an install with no provider object yet as every provider on", () => {
    expect(disabledComputerProviders(undefined, { ...all, asciiBox: false })).toEqual(["asciiBox"]);
    expect(disabledComputerProviders(undefined, undefined)).toEqual([]);
  });
});

describe("turnUsesComputerProvider", () => {
  const base = { granted: [] as ("cloud" | "vm" | "local")[], auto: false, autoAllows: [] as ("cloud" | "vm" | "local")[], cloudBackend: "box" as const };
  it("interrupts only turns that hold the disabled provider", () => {
    expect(turnUsesComputerProvider({ ...base, granted: ["local"] }, ["localMac"])).toBe(true);
    expect(turnUsesComputerProvider({ ...base, granted: ["vm"] }, ["localMac"])).toBe(false);
    expect(turnUsesComputerProvider({ ...base, granted: ["vm"] }, ["localVm"])).toBe(true);
  });

  it("maps the cloud destination through the resolved backend", () => {
    expect(turnUsesComputerProvider({ ...base, granted: ["cloud"] }, ["asciiBox"])).toBe(true);
    expect(turnUsesComputerProvider({ ...base, granted: ["cloud"] }, ["selfHostedVps"])).toBe(false);
    expect(turnUsesComputerProvider({ ...base, granted: ["cloud"], cloudBackend: "vps" }, ["selfHostedVps"])).toBe(true);
  });

  it("counts every destination an Auto turn could still reach", () => {
    const auto = { ...base, auto: true, autoAllows: ["cloud", "local"] as ("cloud" | "vm" | "local")[] };
    expect(turnUsesComputerProvider(auto, ["localMac"])).toBe(true);
    expect(turnUsesComputerProvider(auto, ["asciiBox"])).toBe(true);
    expect(turnUsesComputerProvider(auto, ["localVm"])).toBe(false);
    expect(turnUsesComputerProvider({ ...auto, autoAllows: ["cloud"] }, ["localMac"])).toBe(false);
  });

  it("leaves an Off bot alone", () => {
    expect(turnUsesComputerProvider(base, ["asciiBox", "selfHostedVps", "localVm", "localMac"])).toBe(false);
  });
});

describe("legacyAllowlistRevokedProviders", () => {
  it("counts destinations an older client removed from allowedComputers", () => {
    expect(legacyAllowlistRevokedProviders(null, ["cloud", "vm"])).toEqual(["localMac"]);
    expect(legacyAllowlistRevokedProviders(["cloud", "vm", "local"], ["local"])).toEqual([
      "asciiBox", "selfHostedVps", "localVm",
    ]);
    expect(legacyAllowlistRevokedProviders(["vm"], null)).toEqual([]);
    expect(legacyAllowlistRevokedProviders(null, null)).toEqual([]);
    expect(legacyAllowlistRevokedProviders(["vm"], ["vm", "local"])).toEqual([]);
  });
});

describe("revokedComputerProviders", () => {
  const all = { asciiBox: true, selfHostedVps: true, localVm: true, localMac: true };
  it("revokes on a legacy-only narrowing with the provider toggles untouched", () => {
    expect(revokedComputerProviders(
      { providers: all, allowed: null },
      { providers: all, allowed: ["cloud", "vm"] },
    )).toEqual(["localMac"]);
    expect(revokedComputerProviders(
      { providers: undefined, allowed: null },
      { providers: undefined, allowed: [] },
    )).toEqual(["asciiBox", "selfHostedVps", "localVm", "localMac"]);
  });

  it("merges both spellings without duplicates", () => {
    expect(revokedComputerProviders(
      { providers: all, allowed: null },
      { providers: { ...all, localMac: false, localVm: false }, allowed: ["cloud", "vm"] },
    )).toEqual(["localVm", "localMac"]);
  });

  it("revokes nothing when a save only grants more", () => {
    expect(revokedComputerProviders(
      { providers: { ...all, localVm: false }, allowed: ["cloud"] },
      { providers: all, allowed: null },
    )).toEqual([]);
  });
});

describe("PUT /api/config provider disable", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const helper = source.slice(
    source.indexOf("async function interruptTurnsUsingDisabledProviders("),
    source.indexOf("async function runProviderReload()"),
  );

  it("interrupts only the affected turns when no rebuild runs", () => {
    expect(source).toContain("await interruptTurnsUsingDisabledProviders(configBeforeSave, cfg);");
  });

  it("reads the legacy allowlist as well as the provider toggles", () => {
    expect(helper).toContain("revokedComputerProviders(");
    expect(helper).toContain("allowed: allowedBotComputers(after)");
  });

  it("latches each targeted turn as stopped before interrupting the engine", () => {
    const latch = helper.indexOf("latchInterruptedTurns([turn]);");
    const interrupt = helper.indexOf("await instance?.adapter.interruptTurn(turn.threadId)");
    expect(latch).toBeGreaterThan(0);
    expect(interrupt).toBeGreaterThan(latch);
    // Nothing awaited between the latch and the interrupt call.
    expect(helper.slice(latch, interrupt)).not.toContain("await ");
  });
});
