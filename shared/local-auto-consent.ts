export interface LocalAutoConsentBot {
  id: string;
  name: string;
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
