import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { impactedBotsForProvider, type CloudAutomationSource } from "./computer-impact";
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
