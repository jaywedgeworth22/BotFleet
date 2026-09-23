// Which bots lose something when the operator turns a computer provider
// off, and how to name what they use in product terms.
//
// The list has to match what the runtime actually mounts, which is
// `resolveGrants` plus the per-provider filter in
// `server/computer-grants.ts`.  Two rules there matter here:
//
// - A turn started by a routine, webhook or resource trigger with
//   `runOn: "cloud"` gets the cloud destination whatever the bot's own
//   computers say, including a bot whose computers are turned off.
// - The per-provider filter then drops that cloud destination when the
//   bot's resolved backend (its own `cloudBackend`, else the workspace
//   default, else Box) is the provider being turned off.
//
// So a bot with an enabled cloud automation uses its resolved cloud
// backend even when `providersForBot` says it has no computer at all,
// and turning that backend off breaks the automation.
import type { Bot } from "@/state/store";
import { providersForBot, type AutoLocalFallback } from "@/components/BotComputerMatrix";
import {
  COMPUTER_PROVIDER_LABEL,
  COMPUTER_PROVIDER_ORDER,
  type ComputerProviderId,
  type ComputerProviders,
} from "../../shared/local-auto-consent";

/** The minimum a routine, webhook or resource trigger needs to say for the
 * impact list: whose it is, where it runs, and whether it can fire. */
export type CloudAutomationSource = {
  botId: string;
  runOn: "maus" | "cloud";
  enabled: boolean;
};

export type CloudAutomations = {
  routines?: readonly CloudAutomationSource[];
  webhooks?: readonly CloudAutomationSource[];
  resourceTriggers?: readonly CloudAutomationSource[];
};

type AutomationKind = "routine" | "webhook" | "resourceTrigger";

const AUTOMATION_LABEL: Record<AutomationKind, string> = {
  routine: "Cloud Routine",
  webhook: "Cloud Webhook",
  resourceTrigger: "Cloud Resource Trigger",
};

export type ImpactedBot = {
  id: string;
  name: string;
  /** What the bot uses today, in product names ("Auto", "ASCII.dev Box",
   * "Cloud Routine on Self-Hosted VPS"), for the confirm list. */
  usage: string;
  /** Per-provider state the bot currently has, counting cloud automations. */
  providers: ComputerProviders;
};

export type ImpactInput = {
  bots: readonly Bot[];
  workspaceProviders: ComputerProviders | undefined;
  workspaceCloudBackend?: "box" | "vps";
  workspaceDefaultComputers?: readonly ("cloud" | "vm" | "local")[];
  autoLocalFor?: (bot: Bot) => AutoLocalFallback | undefined;
  automations?: CloudAutomations;
};

function cloudKindsFor(botId: string, automations: CloudAutomations | undefined): AutomationKind[] {
  if (!automations) return [];
  const kinds: AutomationKind[] = [];
  const has = (list: readonly CloudAutomationSource[] | undefined) =>
    (list ?? []).some((item) => item.botId === botId && item.enabled && item.runOn === "cloud");
  if (has(automations.routines)) kinds.push("routine");
  if (has(automations.webhooks)) kinds.push("webhook");
  if (has(automations.resourceTriggers)) kinds.push("resourceTrigger");
  return kinds;
}

/** Every bot with the provider in its effective grant, with a product-name
 * description of what it uses.  Mirrors `resolveGrants` and the
 * per-provider filter; see the file header. */
export function impactedBotsForProvider(provider: ComputerProviderId, input: ImpactInput): ImpactedBot[] {
  const result: ImpactedBot[] = [];
  for (const bot of input.bots) {
    const off = bot.computers !== undefined && bot.computers.length === 0;
    const granted = providersForBot(
      bot,
      input.workspaceProviders,
      input.workspaceCloudBackend,
      input.workspaceDefaultComputers,
      input.autoLocalFor?.(bot),
    );
    const providers: ComputerProviders = { ...granted };
    const kinds = cloudKindsFor(bot.id, input.automations);
    const cloudProvider: ComputerProviderId =
      (bot.cloudBackend ?? input.workspaceCloudBackend ?? "box") === "box" ? "asciiBox" : "selfHostedVps";
    // `runOn: "cloud"` bypasses the allowlist in resolveGrants but not the
    // per-provider filter, so it only counts while that backend is on.
    const cloudBackendOn = input.workspaceProviders ? input.workspaceProviders[cloudProvider] === true : true;
    if (kinds.length > 0 && cloudBackendOn) providers[cloudProvider] = true;
    if (providers[provider] !== true) continue;

    const parts: string[] = [];
    const grantedNames = COMPUTER_PROVIDER_ORDER.filter((id) => granted[id]).map((id) => COMPUTER_PROVIDER_LABEL[id]);
    if (bot.computers === undefined) {
      parts.push(grantedNames.length > 0 ? `Auto (${grantedNames.join(", ")})` : "Auto");
    } else if (!off) {
      parts.push(...grantedNames);
    }
    if (kinds.length > 0 && cloudBackendOn) {
      parts.push(`${kinds.map((kind) => AUTOMATION_LABEL[kind]).join(", ")} on ${COMPUTER_PROVIDER_LABEL[cloudProvider]}`);
    }
    result.push({ id: bot.id, name: bot.name, usage: parts.join(" · "), providers });
  }
  return result;
}
