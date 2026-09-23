// One-place setup for which computer providers this workspace allows, and
// a master view of every bot's per-provider grant.  The redesigned
// Computer settings UI splits "which providers are available" (here)
// from "how to install the Local VM runtime" (now in
// `LocalVmRuntimeCard.tsx`); the operator-facing toggle row is the
// answer to the first, and the runtime card still owns the second.
//
// What ships in this file:
// - `<ComputerProviderToggle>` row per provider (ASCII.dev Box, Self-
//   Hosted VPS, Local VM, This Computer), each with a caption explaining
//   the impact of turning it off.
// - `<VpsModeToggle>` next to the VPS row so the operator can pick
//   shared vs per-bot, or "not used".
// - `<BotComputerMatrix>` so every bot's grant is visible in one table,
//   with a one-click "Apply new default to all" that opens a confirm
//   dialog.
// - `<ComputerImpactConfirmModal>` opens before any provider toggle
//   turns off, listing the bots that would lose a leg of their grant.
//
// State lives in `state.config.botDefaults.computerProviders` (and
// `vpsMode`); writes go through `PUT /api/config` and the legacy
// `allowedComputers` field is back-filled from the new shape so the
// server-side allowlist gate keeps working through the cut-over.
import { useCallback, useMemo, useState } from "react";
import { ApiError, api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { Card } from "./SettingsPrimitives";
import { ComputerProviderToggle } from "./ComputerProviderToggle";
import { VpsModeToggle } from "./VpsModeToggle";
import { BotComputerMatrix, providersForBot } from "./BotComputerMatrix";
import { ComputerImpactConfirmModal, type ImpactedBot } from "./ComputerImpactConfirmModal";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import {
  COMPUTER_PROVIDER_ORDER,
  DEFAULT_COMPUTER_PROVIDERS,
  DEFAULT_VPS_MODE,
  type ComputerProviderId,
  type ComputerProviders,
  type VpsMode,
} from "../../shared/local-auto-consent";

/** Derive the legacy `allowedComputers: Destination[]` array from the
 * new per-provider shape so the server-side allowlist gate
 * (`server/computer-grants.ts`) keeps answering the same question
 * through the cut-over.  Every provider that maps to the same legacy
 * destination turns that destination on.  Returns `null` (= "every
 * destination is allowed") when every legacy destination is on, which
 * matches the shipped default and is what the legacy field has always
 * meant. */
function allowedComputersFromProviders(providers: ComputerProviders): Array<"cloud" | "vm" | "local"> | null {
  const cloud = providers.asciiBox || providers.selfHostedVps;
  const vm = providers.localVm;
  const local = providers.localMac;
  if (cloud && vm && local) return null;
  const result: Array<"cloud" | "vm" | "local"> = [];
  if (cloud) result.push("cloud");
  if (vm) result.push("vm");
  if (local) result.push("local");
  return result;
}

/** Derive the new per-provider shape from the legacy allowlist array,
 * for the read path on configs that pre-date the migration.  Mirrors
 * `migrateAllowedComputersToProviders` in
 * `shared/local-auto-consent.ts` so the two sides of the cut-over
 * agree. */
function providersFromAllowedComputers(allowed: Array<"cloud" | "vm" | "local"> | null | undefined): ComputerProviders {
  if (allowed === null || allowed === undefined) return { ...DEFAULT_COMPUTER_PROVIDERS };
  const providers: ComputerProviders = {
    asciiBox: false,
    selfHostedVps: false,
    localVm: false,
    localMac: false,
  };
  for (const dest of allowed) {
    if (dest === "cloud") {
      providers.asciiBox = true;
      providers.selfHostedVps = true;
    } else if (dest === "vm") {
      providers.localVm = true;
    } else if (dest === "local") {
      providers.localMac = true;
    }
  }
  return providers;
}

/** Resolve the workspace's effective providers, applying the migration
 * fall-through on configs that have not been migrated yet.  Returns
 * both the providers and the resolved VPS mode so the parent can hand
 * them to the toggles without re-doing the same lookup. */
function resolveWorkspaceProviders(config: ConfigStatus | null | undefined): {
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
  return {
    providers: providersFromAllowedComputers(defaults?.allowedComputers),
    vpsMode: defaults?.vpsMode ?? DEFAULT_VPS_MODE,
    resolvedFromLegacy: true,
  };
}

/** What a bot's `computers[]` looks like in the matrix's impact view.
 * Kept here (not in `BotComputerMatrix`) because the impact-confirm
 * modal cares about the SAME source-of-truth the server's allowlist
 * gate uses, which is `bot.computers` (the legacy wire shape). */
function currentSelectionFor(bot: Bot): string[] {
  if (bot.computers === undefined) return ["auto"];
  if (bot.computers.length === 0) return ["off"];
  return [...bot.computers];
}

export function LocalComputerSection() {
  const { state, dispatch } = useStore();
  const resolved = useMemo(() => resolveWorkspaceProviders(state.config), [state.config?.botDefaults]);
  const providers = resolved.providers;
  const vpsMode = resolved.vpsMode;
  const bots = state.bots ?? [];
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The provider pending confirmation: set when the user clicks an
  // enabled provider (would turn it off) and there is at least one bot
  // that currently uses it.  `null` = no modal open.
  const [impact, setImpact] = useState<{ provider: ComputerProviderId; impacted: ImpactedBot[] } | null>(null);
  // Set when the server refuses an apply-defaults with
  // `needsAcknowledgement`: the named bots would gain Auto with nobody
  // having seen the warning.  Non-null shows the shared confirm dialog;
  // confirming resubmits the same defaults with the exact identities
  // shown in the warning.
  const [pendingAck, setPendingAck] = useState<{
    bots: { id: string; name: string }[];
    request: { path: "/api/config" | "/api/bots/apply-defaults"; method: "PUT" | "POST"; body: unknown };
  } | null>(null);

  // The bots that would lose a leg of their grant if the named
  // provider were disabled.  Used both to gate the toggle (no affected
  // bots -> commit without a modal) and to populate the modal list.
  const botsUsingProvider = useCallback(
    (provider: ComputerProviderId): ImpactedBot[] =>
      bots
        .filter((bot) => {
          if (bot.computers === undefined) return false;
          if (bot.computers.length === 0) return false;
          const botProviders = providersForBot(bot, providers);
          return botProviders[provider] === true;
        })
        .map((bot) => ({
          id: bot.id,
          name: bot.name,
          currentSelection: currentSelectionFor(bot),
          providers: providersForBot(bot, providers),
        })),
    [bots, providers],
  );

  // Persist a new providers shape.  Always writes both the new key and
  // the legacy `allowedComputers` (back-filled from the new shape)
  // so the server-side allowlist gate stays in lock-step with the
  // operator-facing toggle.
  const persist = useCallback(
    (nextProviders: ComputerProviders, nextVpsMode: VpsMode) => {
      setSaving(true);
      setError(null);
      api("/api/config", {
        method: "PUT",
        body: JSON.stringify({
          botDefaults: {
            computerProviders: nextProviders,
            vpsMode: nextVpsMode,
            allowedComputers: allowedComputersFromProviders(nextProviders),
          },
        }),
      })
        .then((config: ConfigStatus) => {
          dispatch({ type: "configStatus", config });
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setSaving(false));
    },
    [dispatch],
  );

  const handleProviderToggle = (provider: ComputerProviderId, next: boolean) => {
    if (saving) return;
    // Cross-field invariant: `vpsMode === null` is only legal when the
    // VPS provider is off.  Toggling the VPS on without a mode is a
    // disabled toggle (the parent rendered the toggle as off), but
    // defense-in-depth lives here so a future test that toggles the
    // row programmatically does not silently land a null mode.
    if (provider === "selfHostedVps" && next && vpsMode === null) {
      setError("Pick a VPS mode (Shared or Per-Bot) before enabling the VPS provider");
      return;
    }
    if (!next) {
      // Disable path.  If any bot currently uses the provider, gate
      // the change on the modal; otherwise commit immediately.
      const impacted = botsUsingProvider(provider);
      if (impacted.length === 0) {
        const nextProviders = { ...providers, [provider]: false };
        persist(nextProviders, provider === "selfHostedVps" ? null : vpsMode);
        return;
      }
      setImpact({ provider, impacted });
      return;
    }
    // Enable path: no modal, the only impact is that more bots can use
    // the provider from this point on.
    const nextProviders = { ...providers, [provider]: true };
    persist(nextProviders, vpsMode);
  };

  const handleVpsModeChange = (next: VpsMode) => {
    if (saving) return;
    if (next !== null && !providers.selfHostedVps) {
      setError("Turn the Self-Hosted VPS provider on before picking a mode");
      return;
    }
    if (next === null && providers.selfHostedVps) {
      setError("Turn the Self-Hosted VPS provider off to clear the mode");
      return;
    }
    persist(providers, next);
  };

  // Apply workspace defaults to every bot.  Mirrors the existing
  // `BotComputerDefaults.tsx` consent handshake: the server may refuse
  // with `needsAcknowledgement` if any bot would gain This Computer +
  // Auto with nobody having seen the warning.
  const submitApply = (
    body: { botDefaults: { computerProviders: ComputerProviders; vpsMode: VpsMode; allowedComputers: Array<"cloud" | "vm" | "local"> | null } },
    acknowledgedBots?: { id: string; name: string }[],
  ) => {
    setApplying(true);
    setError(null);
    api("/api/bots/apply-defaults", {
      method: "POST",
      body: JSON.stringify({
        ...body,
        ...(acknowledgedBots ? { acknowledgeLocalAuto: true, acknowledgedBots } : {}),
      }),
    })
      .then((response: ConfigStatus | { applied: number; config: ConfigStatus }) => {
        setPendingAck(null);
        const config = "config" in response ? response.config : response;
        dispatch({ type: "configStatus", config });
      })
      .catch((e) => {
        if (e instanceof ApiError && Array.isArray(e.body?.needsAcknowledgement) && e.body.needsAcknowledgement.length > 0) {
          setPendingAck({ bots: e.body.needsAcknowledgement, request: { path: "/api/bots/apply-defaults", method: "POST", body } });
        } else {
          setError(e.message);
        }
      })
      .finally(() => setApplying(false));
  };

  const applyToAll = () => {
    submitApply({
      botDefaults: {
        computerProviders: providers,
        vpsMode,
        allowedComputers: allowedComputersFromProviders(providers),
      },
    });
  };

  return (
    <>
      <Card
        title="Providers"
        subtitle="The computer providers any bot in this workspace is allowed to use.  Disabling a provider here keeps every bot off it, no matter what a bot's own settings say.  Leave the shipped set on to keep the current behavior."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {COMPUTER_PROVIDER_ORDER.map((id) => (
            <ComputerProviderToggle
              key={id}
              provider={id}
              enabled={providers[id]}
              busy={saving}
              onToggle={(next) => handleProviderToggle(id, next)}
            />
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-1.5 border-t border-hairline/40 pt-4">
          <div className="text-[12px] font-medium text-ink">Self-Hosted VPS Mode</div>
          <VpsModeToggle value={vpsMode} busy={saving} onChange={handleVpsModeChange} />
        </div>
        {resolved.resolvedFromLegacy && (
          <div className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[11.5px] text-warning">
            Loaded from the legacy <code className="font-mono">allowedComputers</code> shape.  The next save will write the new per-provider key alongside it.
          </div>
        )}
      </Card>

      <Card
        title="Bots"
        subtitle="Which providers every bot in this workspace has.  Per-bot edits live in each bot's settings; the matrix is the master view."
      >
        <BotComputerMatrix
          bots={bots}
          workspaceProviders={providers}
          busy={applying || saving}
          onApplyToAll={applyToAll}
        />
      </Card>

      {error && (
        <div className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger" title={error}>
          {error}
        </div>
      )}

      <ComputerImpactConfirmModal
        open={impact !== null}
        disabledProvider={impact?.provider ?? "asciiBox"}
        bots={impact?.impacted ?? []}
        busy={saving}
        onCancel={() => setImpact(null)}
        onConfirm={() => {
          if (!impact) return;
          const nextProviders = { ...providers, [impact.provider]: false };
          setImpact(null);
          persist(nextProviders, impact.provider === "selfHostedVps" ? null : vpsMode);
        }}
      />

      <LocalComputerAutoWarning
        open={pendingAck !== null}
        onCancel={() => setPendingAck(null)}
        bots={pendingAck?.bots}
        busy={applying}
        onConfirm={() => {
          if (!pendingAck) return;
          submitApply(pendingAck.request.body as { botDefaults: { computerProviders: ComputerProviders; vpsMode: VpsMode; allowedComputers: Array<"cloud" | "vm" | "local"> | null } }, pendingAck.bots);
        }}
      />
    </>
  );
}