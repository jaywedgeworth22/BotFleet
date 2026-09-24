import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CONFIG_KEYS_WITHOUT_PROVIDER_RELOAD,
  computerProviderBlocked,
  computerProvidersStale,
  heldComputerProviders,
  revokedTurnProviders,
  disabledComputerProviders,
  legacyAllowlistRevokedProviders,
  providerReloadKeys,
  revokedComputerProviders,
  turnUsesComputerProvider,
  unacknowledgedImpact,
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

  it("compares each turn's providers before and after the whole botDefaults save", () => {
    expect(helper).toContain("revokedTurnProviders(heldProvidersFor(before, inputs, runOn), heldProvidersFor(after, inputs, runOn))");
    // Every input turn mounting reads, from the settings being compared.
    const held = source.slice(source.indexOf("function heldProvidersFor("), source.indexOf("function botsLosingProviders("));
    expect(held).toContain("allowedBotComputers(settings)");
    expect(held).toContain("settings.botDefaults?.computers");
    expect(held).toContain("settings.botDefaults?.cloudBackend");
    expect(held).toContain("settings.botDefaults?.computerProviders");
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

describe("computerProviderBlocked (lifecycle gates)", () => {
  const all = { asciiBox: true, selfHostedVps: true, localVm: true, localMac: true };
  it("blocks a provider whose toggle is off", () => {
    expect(computerProviderBlocked({ ...all, asciiBox: false }, null, "asciiBox")).toBe(true);
    expect(computerProviderBlocked({ ...all, asciiBox: false }, null, "selfHostedVps")).toBe(false);
  });

  it("blocks a destination a legacy-only save removed from allowedComputers", () => {
    // Toggles untouched (or never written), allowlist narrowed by an older client.
    expect(computerProviderBlocked(all, ["vm", "local"], "asciiBox")).toBe(true);
    expect(computerProviderBlocked(all, ["vm", "local"], "selfHostedVps")).toBe(true);
    expect(computerProviderBlocked(undefined, ["cloud"], "localVm")).toBe(true);
    expect(computerProviderBlocked(undefined, ["cloud"], "asciiBox")).toBe(false);
  });

  it("allows everything when neither spelling narrows", () => {
    for (const id of ["asciiBox", "selfHostedVps", "localVm", "localMac"] as const) {
      expect(computerProviderBlocked(undefined, null, id)).toBe(false);
      expect(computerProviderBlocked(all, null, id)).toBe(false);
    }
  });

  it("is what the cloud and Local VM lifecycle routes check", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("computerProviderBlocked(config.botDefaults?.computerProviders, allowedBotComputers(config), id)");
    expect(source).toContain("if (computerProviderOff(cfg, providerId)) {");
    expect(source).toContain('return computerProviderOff(config, "localVm");');
    // The old toggle-only check is gone from the cloud route.
    expect(source).not.toContain("if (providers && providers[providerId] !== true) {");
  });
});

describe("heldComputerProviders / revokedTurnProviders", () => {
  const all = { asciiBox: true, selfHostedVps: true, localVm: true, localMac: true };
  const both = ["cloud", "local"] as ("cloud" | "vm" | "local")[];
  const held = (
    granted: ("cloud" | "vm" | "local")[],
    auto: boolean,
    cloudBackend: "box" | "vps",
    providers: typeof all | undefined = all,
    autoAllows: ("cloud" | "vm" | "local")[] = both,
  ) => heldComputerProviders({ granted, auto, autoAllows, cloudBackend }, providers);

  it("revokes the host when an inherited workspace default moves from local to cloud", () => {
    // An Auto bot resolves to the workspace default; resolveGrants hands it
    // ["local"] before the save and ["cloud"] after.
    const before = held(["local"], false, "box");
    const after = held(["cloud"], false, "box");
    expect(before).toEqual(["localMac"]);
    expect(revokedTurnProviders(before, after)).toEqual(["localMac"]);
  });

  it("revokes the old backend when the workspace cloud backend switches", () => {
    expect(revokedTurnProviders(held(["cloud"], false, "box"), held(["cloud"], false, "vps"))).toEqual(["asciiBox"]);
  });

  it("revokes a provider toggled off and leaves the rest", () => {
    const after = held(["cloud", "vm"], false, "box", { ...all, localVm: false });
    expect(revokedTurnProviders(held(["cloud", "vm"], false, "box"), after)).toEqual(["localVm"]);
  });

  it("counts Auto's reachable destinations, filtered by the toggles", () => {
    expect(held([], true, "vps")).toEqual(["selfHostedVps", "localMac"]);
    expect(held([], true, "vps", { ...all, localMac: false })).toEqual(["selfHostedVps"]);
    expect(held([], true, "box", all, ["cloud"])).toEqual(["asciiBox"]);
    expect(held([], false, "box")).toEqual([]);
  });

  it("revokes nothing when a save only grants more or changes nothing", () => {
    expect(revokedTurnProviders(held(["cloud"], false, "box"), held(["cloud", "local"], false, "box"))).toEqual([]);
    expect(revokedTurnProviders(held(["vm"], false, "box"), held(["vm"], false, "vps"))).toEqual([]);
  });
});

describe("computerProvidersStale (PUT /api/config compare-and-swap)", () => {
  const current = { asciiBox: true, selfHostedVps: false, localVm: true, localMac: false };
  it("accepts a save that saw the stored toggles", () => {
    expect(computerProvidersStale({ ...current }, current)).toBe(false);
  });

  it("refuses a save from a window that saw an older state", () => {
    // Another window turned This Computer off; this one still shows it on.
    expect(computerProvidersStale({ ...current, localMac: true }, current)).toBe(true);
    expect(computerProvidersStale({ asciiBox: true }, current)).toBe(true);
    expect(computerProvidersStale(null, current)).toBe(true);
    expect(computerProvidersStale([true, false], current)).toBe(true);
  });

  it("is checked by PUT /api/config before anything is saved", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const route = source.slice(source.indexOf('path === "/api/config") {'));
    const cas = route.indexOf("computerProvidersStale(body.expectedComputerProviders, current)");
    expect(cas).toBeGreaterThan(0);
    expect(route.indexOf("providerConfigBusy = true;")).toBeGreaterThan(cas);
    expect(route).toContain('code: "computer_providers_stale"');
  });

  it("keeps the two-space sentence gap in the stale-save error the window shows", () => {
    // The client puts this error in a plain <div>, where two ASCII spaces
    // collapse; the copy rule's NBSP + space pair survives.
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain('"Provider settings changed in another window.\\u00a0 Review them and try again."');
    expect(source).not.toContain("another window. Review them");
  });
});

describe("provider disable impact is judged by the running turn and the server's state", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("interrupts by what a turn mounted, not the bot's grants after a mid-turn edit", () => {
    // A turn started on Cloud keeps its Box mount after the bot is switched
    // to Local VM; with the stored grants both sides read VM and the Box
    // disable skipped it.
    const mounted = heldComputerProviders({ granted: ["cloud"], auto: false, autoAllows: [], cloudBackend: "box" }, {
      asciiBox: true, selfHostedVps: true, localVm: true, localMac: true,
    });
    const afterDisable = heldComputerProviders({ granted: ["cloud"], auto: false, autoAllows: [], cloudBackend: "box" }, {
      asciiBox: false, selfHostedVps: true, localVm: true, localMac: true,
    });
    expect(revokedTurnProviders(mounted, afterDisable)).toEqual(["asciiBox"]);
    const fn = source.slice(source.indexOf("async function interruptTurnsUsingDisabledProviders("), source.indexOf("async function runProviderReload()"));
    expect(fn).toContain("const inputs = turn.computerInputs ?? turnComputerInputs(bot);");
    expect(fn).not.toContain("storedComputerGrants(bot)");
    // Both dispatch paths snapshot the inputs when they claim the turn.
    expect(source.match(/computerInputs: turnComputerInputs\(bot\),/g)?.length).toBe(2);
    expect(source).toContain("computerInputs: owner?.computerInputs,");
  });

  it("names only the bots the confirm did not list", () => {
    const impacted = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
    expect(unacknowledgedImpact(["a", "b"], impacted)).toEqual([]);
    expect(unacknowledgedImpact(["a", "b", "gone"], impacted)).toEqual([]);
    expect(unacknowledgedImpact(["a"], impacted)).toEqual([{ id: "b", name: "B" }]);
    expect(unacknowledgedImpact(undefined, impacted)).toEqual(impacted);
    expect(unacknowledgedImpact([1, null, "a"], impacted)).toEqual([{ id: "b", name: "B" }]);
  });

  it("recomputes the impact on PUT /api/config before anything is saved", () => {
    const route = source.slice(source.indexOf('path === "/api/config") {'));
    const check = route.indexOf("botsLosingProviders(cfg,");
    expect(check).toBeGreaterThan(route.indexOf("computerProvidersStale(body.expectedComputerProviders, current)"));
    expect(route.indexOf("providerConfigBusy = true;")).toBeGreaterThan(check);
    expect(route).toContain("unacknowledgedImpact(\n          body.acknowledgedImpact,");
    expect(route).toContain('code: "computer_impact_changed"');
    // Nothing is awaited between the check and the write it guards.
    expect(route.slice(check, route.indexOf("providerConfigBusy = true;"))).not.toContain("await ");
    // The server's list counts cloud automations, as the window's does.
    const fn = source.slice(source.indexOf("function botsLosingProviders("), source.indexOf("/** A `botDefaults` save does not rebuild"));
    expect(fn).toContain("routines?.listRoutines()");
    expect(fn).toContain("webhooks.list()");
    expect(fn).toContain("resourceTriggers.list()");
    expect(fn).toContain('item.enabled && item.runOn === "cloud"');
  });
});
