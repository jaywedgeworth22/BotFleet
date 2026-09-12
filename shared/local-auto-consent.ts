export interface LocalAutoConsentBot {
  id: string;
  name: string;
}

export type LocalComputerDestination = "cloud" | "vm" | "local";

/** Whether Auto mode can gain host control from this stored selection.
 * Explicit and inherited Local grants remain consent-relevant while the
 * allowlist blocks them because they become active when it is widened.  A
 * truly unconfigured bot uses automatic discovery, whose host fallback is
 * relevant only while the allowlist permits Local. */
export function requiresLocalAutoConsent(
  computers: readonly (LocalComputerDestination | "off")[] | undefined,
  workspaceDefault: readonly LocalComputerDestination[] | undefined,
  allowedComputers: readonly LocalComputerDestination[] | null | undefined,
): boolean {
  if (computers !== undefined) return computers.includes("local");
  if (workspaceDefault?.length) return workspaceDefault.includes("local");
  return allowedComputers == null || allowedComputers.includes("local");
}

/** Consent covers exactly the identities and names shown in the warning. */
export function matchesLocalAutoConsent(value: unknown, required: LocalAutoConsentBot[]): boolean {
  if (!Array.isArray(value) || value.length !== required.length) return false;
  const remaining = new Map(required.map((bot) => [bot.id, bot.name]));
  for (const bot of value) {
    if (!bot || typeof bot !== "object" || typeof bot.id !== "string" ||
        typeof bot.name !== "string" || !remaining.has(bot.id) || remaining.get(bot.id) !== bot.name) return false;
    remaining.delete(bot.id);
  }
  return remaining.size === 0;
}
