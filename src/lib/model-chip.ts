import type { Bot, InstanceInfo } from "@/state/store";

/** Driver mark + display name for the bot's current model. */
export function modelChip(bot: Bot | undefined, instances: InstanceInfo[]): { driverKind: string; name: string } | null {
  const selection = bot?.modelSelection;
  if (!selection) return null;
  const engine = instances.find((instance) => instance.instanceId === selection.instanceId);
  const name =
    engine?.models.options.find((option) => option.id === selection.model)?.label ?? selection.model;
  return { driverKind: engine?.driverKind ?? selection.instanceId, name };
}
