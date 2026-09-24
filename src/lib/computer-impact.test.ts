import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { impactedBotsForProvider, revalidateImpact, type CloudAutomationSource } from "./computer-impact";
import { ComputerImpactConfirmModal } from "../components/ComputerImpactConfirmModal";
import { COMPUTER_PROVIDER_DISABLE_IMPACT } from "../../shared/local-auto-consent";
import type { Bot } from "../state/store";

function makeBot(id: string, computers?: Bot["computers"], cloudBackend?: Bot["cloudBackend"]): Bot {
  return {
    id,
    threadId: `t-${id}`,
    name: `Bot ${id}`,
    title: "",
    description: "",
    notifications: true,
    color: "blue" as any,
    unread: false,
    activity: "idle",
    modelSelection: { instanceId: "i", model: "m" },
    computers,
    cloudBackend,
    messages: [],
  };
}

const ALL_ON = { asciiBox: true, selfHostedVps: true, localVm: true, localMac: true };
const cloudRoutine = (botId: string, enabled = true): CloudAutomationSource => ({ botId, runOn: "cloud", enabled });

describe("impactedBotsForProvider", () => {
  it("lists a bot with its computers off when an enabled cloud routine runs on the provider", () => {
    const bots = [makeBot("off", []), makeBot("vmOnly", ["vm"])];
    const impacted = impactedBotsForProvider("asciiBox", {
      bots,
      workspaceProviders: ALL_ON,
      automations: { routines: [cloudRoutine("off"), cloudRoutine("vmOnly")] },
    });
    expect(impacted.map((bot) => bot.id)).toEqual(["off", "vmOnly"]);
    expect(impacted[0].usage).toBe("Cloud Routine on ASCII.dev Box");
    expect(impacted[1].usage).toBe("Local VM · Cloud Routine on ASCII.dev Box");
  });

  it("counts cloud webhooks and resource triggers the same way", () => {
    const impacted = impactedBotsForProvider("asciiBox", {
      bots: [makeBot("a", ["local"])],
      workspaceProviders: ALL_ON,
      automations: { webhooks: [cloudRoutine("a")], resourceTriggers: [cloudRoutine("a")] },
    });
    expect(impacted.map((bot) => bot.id)).toEqual(["a"]);
    expect(impacted[0].usage).toBe("This Computer · Cloud Webhook, Cloud Resource Trigger on ASCII.dev Box");
  });

  it("follows the bot's resolved cloud backend, like resolveCloudBackend", () => {
    const input = {
      bots: [makeBot("vps", [], "vps"), makeBot("wsDefault", [])],
      workspaceProviders: ALL_ON,
      workspaceCloudBackend: "vps" as const,
      automations: { routines: [cloudRoutine("vps"), cloudRoutine("wsDefault")] },
    };
    expect(impactedBotsForProvider("asciiBox", input)).toEqual([]);
    const vps = impactedBotsForProvider("selfHostedVps", input);
    expect(vps.map((bot) => bot.id)).toEqual(["vps", "wsDefault"]);
    expect(vps[0].usage).toBe("Cloud Routine on Self-Hosted VPS");
  });

  it("ignores disabled and local routines, and routines of other bots", () => {
    const impacted = impactedBotsForProvider("asciiBox", {
      bots: [makeBot("a", [])],
      workspaceProviders: ALL_ON,
      automations: {
        routines: [cloudRoutine("a", false), { botId: "a", runOn: "maus", enabled: true }, cloudRoutine("other")],
      },
    });
    expect(impacted).toEqual([]);
  });

  it("keeps the explicit-grant and Auto cases, named in product terms", () => {
    const impacted = impactedBotsForProvider("asciiBox", {
      bots: [makeBot("cloud", ["cloud", "vm"]), makeBot("auto"), makeBot("off", [])],
      workspaceProviders: ALL_ON,
      autoLocalFor: () => ({ hostPlatform: "darwin", engineSupportsLocal: true }),
    });
    expect(impacted.map((bot) => bot.id)).toEqual(["cloud", "auto"]);
    expect(impacted[0].usage).toBe("ASCII.dev Box · Local VM");
    expect(impacted[1].usage).toBe("Auto (ASCII.dev Box, This Computer)");
    for (const bot of impacted) expect(bot.usage).not.toMatch(/\b(cloud|vm|local|auto)\b/);
  });
});

describe("ComputerImpactConfirmModal copy", () => {
  const base = { open: true, disabledProvider: "asciiBox" as const, onCancel() {}, onConfirm() {} };

  it("shows product names for each bot, never raw computers[] values", () => {
    const bots = impactedBotsForProvider("asciiBox", {
      bots: [makeBot("a", ["cloud", "local"]), makeBot("b", [])],
      workspaceProviders: ALL_ON,
      automations: { routines: [cloudRoutine("b")] },
    });
    const html = renderToStaticMarkup(createElement(ComputerImpactConfirmModal, { ...base, bots }));
    expect(html).toContain("ASCII.dev Box · This Computer");
    expect(html).toContain("Cloud Routine on ASCII.dev Box");
    expect(html).not.toMatch(/>\s*cloud\s*·/);
    expect(html).not.toContain("font-mono");
    expect(html).toContain("2 bots use ASCII.dev Box.  Turning it off takes ASCII.dev Box away from them");
    expect(html).toContain("Disable Anyway");
    expect(html).not.toContain("leg of");
  });

  it("says plainly when no bot is affected", () => {
    const html = renderToStaticMarkup(createElement(ComputerImpactConfirmModal, { ...base, bots: [] }));
    expect(html).toContain("No bot uses ASCII.dev Box right now, so turning it off changes nothing for your bots.");
    expect(html).not.toContain("no-op");
  });

  it("keeps coordinator terms out of the provider captions", () => {
    for (const caption of Object.values(COMPUTER_PROVIDER_DISABLE_IMPACT)) {
      expect(caption).not.toMatch(/\bleg\b|host control|no-op/);
      expect(caption).not.toMatch(/[a-z]\. [A-Z]/);
    }
  });
});

describe("LocalComputerSection before the config hydrates", () => {
  it("locks the provider controls while there is no config to read", async () => {
    const { providerControlsLocked, resolveWorkspaceProviders } = await import("./workspace-providers");
    // With no config the resolver falls back to every provider on, which is
    // exactly the state a premature save would write back over the disk.
    expect(resolveWorkspaceProviders(null).providers).toEqual({
      asciiBox: true, selfHostedVps: true, localVm: true, localMac: true,
    });
    expect(providerControlsLocked(null, false)).toBe(true);
    expect(providerControlsLocked(undefined, false)).toBe(true);
    const config = { botDefaults: { computerProviders: { asciiBox: false, selfHostedVps: false, localVm: true, localMac: false } } } as any;
    expect(providerControlsLocked(config, false)).toBe(false);
    expect(providerControlsLocked(config, true)).toBe(true);
    expect(resolveWorkspaceProviders(config).providers.asciiBox).toBe(false);
  });
});

describe("LocalComputerSection before the automations hydrate", () => {
  it("keeps the provider controls locked until the whole hydration pass is ready", async () => {
    const { providerControlsLocked } = await import("./workspace-providers");
    const config = { botDefaults: { computerProviders: { asciiBox: true, selfHostedVps: false, localVm: false, localMac: false } } } as any;
    // Config is in, but bots/routines/webhooks/triggers may still be loading:
    // the impact confirm would read an empty automation list.
    expect(providerControlsLocked(config, false, "idle")).toBe(true);
    expect(providerControlsLocked(config, false, "loading")).toBe(true);
    expect(providerControlsLocked(config, false, "failed")).toBe(true);
    expect(providerControlsLocked(config, false, "ready")).toBe(false);
  });

  it("is wired to the store's hydration status", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../components/LocalComputerSection.tsx", import.meta.url), "utf8");
    expect(source).toContain("providerControlsLocked(state.config, saving, state.hydration.status)");
  });
});

describe("BotComputerMatrix and the impact list agree", () => {
  it("lights the resolved cloud backend for an Off bot with a cloud automation", async () => {
    const { BotComputerMatrix, effectiveProvidersForBot } = await import("../components/BotComputerMatrix");
    const off = makeBot("off", []);
    const vpsOff = makeBot("vpsoff", [], "vps");
    const automations = { routines: [cloudRoutine("off"), cloudRoutine("vpsoff")] };
    expect(effectiveProvidersForBot(off, { workspaceProviders: ALL_ON, automations })).toEqual({
      asciiBox: true, selfHostedVps: false, localVm: false, localMac: false,
    });
    expect(effectiveProvidersForBot(vpsOff, { workspaceProviders: ALL_ON, automations }).selfHostedVps).toBe(true);
    // A backend that is off stays dark, same as the per-provider filter.
    expect(effectiveProvidersForBot(off, { workspaceProviders: { ...ALL_ON, asciiBox: false }, automations }).asciiBox).toBe(false);
    // Every lit cell is a provider whose disable lists the bot, and vice versa.
    for (const provider of ["asciiBox", "selfHostedVps", "localVm", "localMac"] as const) {
      const listed = impactedBotsForProvider(provider, { bots: [off], workspaceProviders: ALL_ON, automations }).length > 0;
      expect(effectiveProvidersForBot(off, { workspaceProviders: ALL_ON, automations })[provider]).toBe(listed);
    }
    const html = renderToStaticMarkup(
      createElement(BotComputerMatrix, {
        bots: [off],
        workspaceProviders: ALL_ON,
        automations,
        onApplyToAll: () => {},
      }),
    );
    expect(html).toContain('data-testid="matrix-cell-off-asciiBox-on"');
    expect(html).toContain('data-testid="matrix-cell-off-localMac-off"');
  });

  it("keeps an Off bot with no cloud automation dark", async () => {
    const { effectiveProvidersForBot } = await import("../components/BotComputerMatrix");
    const automations = { routines: [cloudRoutine("off", false), { botId: "off", runOn: "maus" as const, enabled: true }] };
    expect(effectiveProvidersForBot(makeBot("off", []), { workspaceProviders: ALL_ON, automations })).toEqual({
      asciiBox: false, selfHostedVps: false, localVm: false, localMac: false,
    });
  });
});

describe("revalidateImpact (disable confirm)", () => {
  const a = { id: "a", name: "A", usage: "ASCII.dev Box", providers: { ...ALL_ON } };
  const b = { id: "b", name: "B", usage: "Cloud Routine on ASCII.dev Box", providers: { ...ALL_ON } };
  it("confirms when the list is unchanged or only shrank", () => {
    expect(revalidateImpact([a, b], [a, b])).toEqual({ kind: "confirmed" });
    expect(revalidateImpact([a, b], [a])).toEqual({ kind: "confirmed" });
    expect(revalidateImpact([a], [])).toEqual({ kind: "confirmed" });
  });

  it("asks again when a bot joined the list or its usage changed", () => {
    expect(revalidateImpact([a], [a, b])).toEqual({ kind: "changed", impacted: [a, b] });
    expect(revalidateImpact([], [a])).toEqual({ kind: "changed", impacted: [a] });
    const moved = { ...a, usage: "ASCII.dev Box · Cloud Routine on ASCII.dev Box" };
    expect(revalidateImpact([a], [moved])).toEqual({ kind: "changed", impacted: [moved] });
  });

  it("is what the confirm handler runs before saving", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../components/LocalComputerSection.tsx", import.meta.url), "utf8");
    const confirm = source.slice(source.lastIndexOf("<ComputerImpactConfirmModal"), source.lastIndexOf("<LocalComputerAutoWarning"));
    const check = confirm.indexOf("revalidateImpact(impact.impacted, botsUsingProvider(impact.provider))");
    expect(check).toBeGreaterThan(0);
    expect(confirm.indexOf("persist(nextProviders")).toBeGreaterThan(check);
  });
});

describe("Apply new default to all", () => {
  it("sends only the computer defaults, never provider policy", async () => {
    const { applyDefaultsBody } = await import("./workspace-providers");
    expect(applyDefaultsBody({ computers: ["cloud", "local"], cloudBackend: "vps" })).toEqual({
      botDefaults: { computers: ["cloud", "local"], cloudBackend: "vps" },
    });
    const withPolicy = {
      computers: ["vm"],
      computerProviders: { asciiBox: true, selfHostedVps: true, localVm: true, localMac: true },
      vpsMode: "per-bot",
      allowedComputers: null,
    } as any;
    expect(applyDefaultsBody(withPolicy)).toEqual({ botDefaults: { computers: ["vm"] } });
    expect(applyDefaultsBody(undefined)).toEqual({});
    expect(applyDefaultsBody({})).toEqual({});
  });
});

describe("provider toggle saves say what they saw", () => {
  it("sends the shown toggles with every provider save", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../components/LocalComputerSection.tsx", import.meta.url), "utf8");
    expect(source).toContain("expectedComputerProviders: providers,");
  });

  it("reads the current config off a stale-save refusal only", async () => {
    const { staleProviderConfig } = await import("./workspace-providers");
    const config = { botDefaults: { computerProviders: { asciiBox: true, selfHostedVps: true, localVm: true, localMac: false } } };
    expect(staleProviderConfig({ status: 409, body: { code: "computer_providers_stale", config } })).toBe(config);
    expect(staleProviderConfig({ status: 409, body: { error: "provider settings are already being updated" } })).toBeNull();
    expect(staleProviderConfig(new Error("boom"))).toBeNull();
    expect(staleProviderConfig(null)).toBeNull();
  });
});
