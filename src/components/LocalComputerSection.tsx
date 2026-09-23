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
//   per-bot or "not used" (Shared is hidden until it has a runtime).
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
  DEFAULT_VPS_MODE,
  migrateAllowedComputersToProviders,
  type ComputerProviderId,
  type ComputerProviders,
  type VpsMode,
} from "../../shared/local-auto-consent";

/** Derive the legacy `allowedComputers: Destination[]` array from the
 * new per-provider shape so the server-side allowlist gate
 * (`server/computer-grants.ts`) keeps answering the same question
 * through the cut-over.  The legacy `"cloud"` destination is
 * ambiguous between ASCII Box and Self-Hosted VPS; for the cut-over
 * we keep the legacy field's contract narrow (`["cloud"]` means
 * "either cloud backend is allowed", `null` means "every legacy
 * destination is allowed") and rely on `server/computer-grants.ts`'s
 * later `computerProviders` consult to enforce the per-backend
 * distinction.  Returns `null` only when ALL four providers are on
 * AND `selfHostedVps` is on (the only combination where every legacy
 * destination is meaningfully on). */
function allowedComputersFromProviders(providers: ComputerProviders): Array<"cloud" | "vm" | "local"> | null {
  const cloud = providers.asciiBox || providers.selfHostedVps;
  const vm = providers.localVm;
  const local = providers.localMac;
  // Every provider on (the legitimate "null = every destination is
  // allowed" answer).  Returning null here is correct: it matches the
  // legacy "no allowlist = every destination is allowed" semantics.
  if (cloud && vm && local) return null;
  // Otherwise, write an explicit narrowed array.  A partial-cloud
  // shape (only one of {asciiBox, selfHostedVps} on) intentionally
  // serializes `"cloud"` here so the server-side allowlist keeps the
  // box-vs-vps decision; the later `computerProviders` consult in
  // server/computer-grants.ts then picks the right backend.
  const result: Array<"cloud" | "vm" | "local"> = [];
  if (cloud) result.push("cloud");
  if (vm) result.push("vm");
  if (local) result.push("local");
  return result;
}

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
  const legacy = providersFromAllowedComputers(defaults?.allowedComputers);
  return {
    providers: legacy.providers,
    vpsMode: legacy.providers.selfHostedVps ? (defaults?.vpsMode ?? legacy.vpsMode ?? DEFAULT_VPS_MODE) : null,
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
  // Auto bots (`computers === undefined`) are included: their grant is
  // the workspace default, so disabling a provider does effectively
  // remove a leg of their grant, and the modal must list them so the
  // operator confirms before that change ships.
  const botsUsingProvider = useCallback(
    (provider: ComputerProviderId): ImpactedBot[] =>
      bots
        .filter((bot) => {
          if (bot.computers !== undefined && bot.computers.length === 0) return false;
          const botProviders = providersForBot(
            bot,
            providers,
            state.config?.botDefaults?.cloudBackend,
            state.config?.botDefaults?.computers,
          );
          return botProviders[provider] === true;
        })
        .map((bot) => ({
          id: bot.id,
          name: bot.name,
          currentSelection: currentSelectionFor(bot),
          providers: providersForBot(
            bot,
            providers,
            state.config?.botDefaults?.cloudBackend,
            state.config?.botDefaults?.computers,
          ),
        })),
    [bots, providers, state.config?.botDefaults?.cloudBackend, state.config?.botDefaults?.computers],
  );

  // Persist a new providers shape.  Always writes both the new key and
  // the legacy `allowedComputers` (back-filled from the new shape)
  // so the server-side allowlist gate stays in lock-step with the
  // operator-facing toggle.  When the server refuses with
  // `needsAcknowledgement` (e.g. enabling This Computer would newly
  // grant local Auto access to an auto-approved bot), the existing
  // `<LocalComputerAutoWarning>` dialog is opened so the operator can
  // consent and resubmit; a plain error is not surfaced in that case.
  const persist = useCallback(
    (nextProviders: ComputerProviders, nextVpsMode: VpsMode) => {
      const body = {
        botDefaults: {
          computerProviders: nextProviders,
          vpsMode: nextVpsMode,
          allowedComputers: allowedComputersFromProviders(nextProviders),
        },
      };
      setSaving(true);
      setError(null);
      api("/api/config", { method: "PUT", body: JSON.stringify(body) })
        .then((config: ConfigStatus) => {
          dispatch({ type: "configStatus", config });
        })
        .catch((e) => {
          if (e instanceof ApiError && Array.isArray(e.body?.needsAcknowledgement) && e.body.needsAcknowledgement.length > 0) {
            setPendingAck({
              bots: e.body.needsAcknowledgement,
              request: { path: "/api/config", method: "PUT", body },
            });
            return;
          }
          setError(e.message);
        })
        .finally(() => setSaving(false));
    },
    [dispatch],
  );

  const handleProviderToggle = (provider: ComputerProviderId, next: boolean) => {
    if (saving) return;
    if (!next) {
      // Disable path.  If any bot currently uses the provider, gate
      // the change on the modal; otherwise commit immediately.
      const impacted = botsUsingProvider(provider);
      if (impacted.length === 0) {
        const nextProviders = { ...providers, [provider]: false };
        // Disabling the VPS provider clears its mode.  Other providers
        // leave the existing mode untouched (the VPS mode is its
        // question; the cloudBackend for the ASCII Box provider is
        // unrelated).
        persist(nextProviders, provider === "selfHostedVps" ? null : vpsMode);
        return;
      }
      setImpact({ provider, impacted });
      return;
    }
    // Enable path: no modal, the only impact is that more bots can use
    // the provider from this point on.  When re-enabling the VPS
    // provider after a disable, atomically restore the shipped
    // default mode so the toggle and the mode control do not
    // deadlock — the operator would otherwise have to pick a mode
    // before re-enabling, with no UI path to do either first.
    const nextProviders = { ...providers, [provider]: true };
    const nextVpsMode = provider === "selfHostedVps" && vpsMode === null ? DEFAULT_VPS_MODE : vpsMode;
    persist(nextProviders, nextVpsMode);
  };

  // The mode control and the VPS toggle drive the same state, so neither
  // may refuse on account of the other.  Picking a mode while the VPS is
  // off turns it on with that mode in one save; picking "Not Used" while it
  // is on goes through the same disable path as the toggle, impact confirm
  // included.
  const handleVpsModeChange = (next: VpsMode) => {
    if (saving) return;
    if (next === null) {
      if (providers.selfHostedVps) handleProviderToggle("selfHostedVps", false);
      return;
    }
    persist({ ...providers, selfHostedVps: true }, next);
  };

  // Apply workspace defaults to every bot.  Mirrors the existing
  // `BotComputerDefaults.tsx` consent handshake: the server may refuse
  // with `needsAcknowledgement` if any bot would gain This Computer +
  // Auto with nobody having seen the warning.  The handler stores the
  // original request (path + method + body) so the acknowledgement
  // dialog can resubmit to the SAME endpoint — a `PUT /api/config`
  // toggle must not accidentally route through `/api/bots/apply-defaults`.
  const submitRequest = (
    request: { path: "/api/config" | "/api/bots/apply-defaults"; method: "PUT" | "POST"; body: unknown },
    acknowledgedBots?: { id: string; name: string }[],
    busySignal?: "apply" | "save",
  ) => {
    if (busySignal === "apply") setApplying(true);
    else if (busySignal === "save") setSaving(true);
    setError(null);
    api(request.path, {
      method: request.method,
      body: JSON.stringify({
        ...(request.body as Record<string, unknown>),
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
          setPendingAck({ bots: e.body.needsAcknowledgement, request });
        } else {
          setError(e.message);
        }
      })
      .finally(() => {
        if (busySignal === "apply") setApplying(false);
        else if (busySignal === "save") setSaving(false);
      });
  };

  const applyToAll = () => {
    submitRequest(
      {
        path: "/api/bots/apply-defaults",
        method: "POST",
        body: {
          botDefaults: {
            computerProviders: providers,
            vpsMode,
            allowedComputers: allowedComputersFromProviders(providers),
          },
        },
      },
      undefined,
      "apply",
    );
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
          workspaceDefaultComputers={state.config?.botDefaults?.computers}
          workspaceCloudBackend={state.config?.botDefaults?.cloudBackend}
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
        busy={applying || saving}
        onConfirm={() => {
          if (!pendingAck) return;
          // Resubmit to the SAME endpoint the original request went to.
          // The acknowledgement dialog is a single consent handshake;
          // routing a provider toggle through /api/bots/apply-defaults
          // would unexpectedly reconfigure every bot on confirm.
          const busySignal = pendingAck.request.path === "/api/bots/apply-defaults" ? "apply" : "save";
          submitRequest(pendingAck.request, pendingAck.bots, busySignal);
        }}
      />
    </>
  );
}
