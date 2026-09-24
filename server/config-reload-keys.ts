// Which top-level config keys a `PUT /api/config` can change without
// rebuilding the provider fleet.  `reloadProviders()` disposes every
// provider and interrupts every in-flight turn, so only a key a driver
// actually reads may trigger it.
//
// Profile, voice, VPS, and room timeout changes do not rebuild the fleet:
// no driver reads them.  Terminology is only a display word, so renaming
// rooms must never kill a turn that is running.  `botDefaults` (the
// workspace computer providers, VPS mode, the New Bots default and the
// legacy allowlist) is read per turn by `resolveTurnComputerMounts` from
// the live `cfg`, never by a driver, so flipping a provider toggle in
// Settings must not interrupt the bots that are working.
export const CONFIG_KEYS_WITHOUT_PROVIDER_RELOAD: ReadonlySet<string> = new Set([
  "profile",
  "tts",
  "imageGen",
  "vps",
  "rooms",
  "localVm",
  "autoUpdate",
  "ingress",
  "usage",
  "observability",
  "infisical",
  "features",
  "terminology",
  "terminologyCustom",
  "conversationMode",
  "botDefaults",
]);

/** The keys in a config patch that require rebuilding the provider fleet. */
export function providerReloadKeys(patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((key) => !CONFIG_KEYS_WITHOUT_PROVIDER_RELOAD.has(key));
}
