// The workspace's effective computer providers, as the Computer settings
// section reads them, and whether its controls may write yet.  Kept out of
// the component so it can be tested without a browser.
import type { ConfigStatus } from "@/state/store";
import {
  DEFAULT_VPS_MODE,
  migrateAllowedComputersToProviders,
  type ComputerProviders,
  type VpsMode,
} from "../../shared/local-auto-consent";

/** Derive the new per-provider shape from the legacy allowlist array,
 * for the read path on configs that pre-date the migration.  Uses
 * `migrateAllowedComputersToProviders` itself so the renderer and the
 * boot migrations cannot disagree: null/undefined is every provider on,
 * [] is every provider off. */
function providersFromAllowedComputers(allowed: Array<"cloud" | "vm" | "local"> | null | undefined): {
  providers: ComputerProviders;
  vpsMode: VpsMode;
} {
  return migrateAllowedComputersToProviders(allowed);
}

/** True while the provider controls must not write.  Before the config
 * has hydrated, `resolveWorkspaceProviders` has nothing to read and falls
 * back to the every-provider-on default; a toggle saved from that state
 * would re-enable providers that are off on disk, and skip the impact
 * confirm because the bots look like they use nothing it would remove. */
export function providerControlsLocked(config: ConfigStatus | null | undefined, saving: boolean): boolean {
  return saving || config === null || config === undefined;
}

/** Resolve the workspace's effective providers, applying the migration
 * fall-through on configs that have not been migrated yet.  Returns
 * both the providers and the resolved VPS mode so the parent can hand
 * them to the toggles without re-doing the same lookup. */
export function resolveWorkspaceProviders(config: ConfigStatus | null | undefined): {
  providers: ComputerProviders;
  vpsMode: VpsMode;
  resolvedFromLegacy: boolean;
} {
  const defaults = config?.botDefaults;
  if (defaults?.computerProviders) {
    return {
      providers: {
        asciiBox: Boolean(defaults.computerProviders.asciiBox),
        selfHostedVps: Boolean(defaults.computerProviders.selfHostedVps),
        localVm: Boolean(defaults.computerProviders.localVm),
        localMac: Boolean(defaults.computerProviders.localMac),
      },
      vpsMode: defaults.vpsMode ?? (defaults.computerProviders.selfHostedVps ? DEFAULT_VPS_MODE : null),
      resolvedFromLegacy: false,
    };
  }
  const legacy = providersFromAllowedComputers(defaults?.allowedComputers);
  return {
    providers: legacy.providers,
    vpsMode: legacy.providers.selfHostedVps ? (defaults?.vpsMode ?? legacy.vpsMode ?? DEFAULT_VPS_MODE) : null,
    resolvedFromLegacy: true,
  };
}
