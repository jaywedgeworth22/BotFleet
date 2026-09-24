// What a NEW bot is given, before anyone opens its settings.
//
// This is a default, not a policy: it fills in for a bot whose computers were
// never configured, and only then.  A bot that was explicitly turned off stays
// off, and a bot with destinations of its own keeps them — see resolveGrants
// in server/computer-grants.ts, which is the one place that rule lives.
//
// The top-level "Allowed Computers" row is the operator-level allowlist: it
// overrides anything below it, so a workspace with "This Computer" turned
// off cannot leak host control into a single bot's grant.  A new install
// leaves it unset (every destination is allowed), matching the shipped
// behavior exactly.
//
// This card is the LEGACY editor for the workspace default — the
// redesigned Computer settings UI (`<LocalComputerSection>`) is the
// primary view.  Its Allowed Computers row is read-only: the primary
// view owns that allowlist and confirms affected bots before a provider
// turns off.  The New Bots row still edits the same on-disk shape; to
// keep both editors consistent we mirror every write onto the new
// `botDefaults.computerProviders` and `botDefaults.vpsMode` fields the
// primary view owns.  A future lane (see audit doc) will delete this
// card once every install has had a release to migrate.
import { useEffect, useState } from "react";
import { ApiError, api, useStore, type ConfigStatus } from "@/state/store";
import { Card } from "./SettingsPrimitives";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { cn } from "@/lib/cn";
import type { ComputerProviders, VpsMode } from "../../shared/local-auto-consent";

/** Derive the legacy allowlist from the new per-provider
 * shape so this legacy card's toggle row renders the same state the
 * primary view shows.  `null` means "every destination is allowed" —
 * the only case every legacy destination is on. */
function allowedFromProviders(providers: ComputerProviders): Destination[] | null {
  const cloud = providers.asciiBox || providers.selfHostedVps;
  const vm = providers.localVm;
  const local = providers.localMac;
  if (cloud && vm && local) return null;
  const result: Destination[] = [];
  if (cloud) result.push("cloud");
  if (vm) result.push("vm");
  if (local) result.push("local");
  return result;
}

type Destination = "cloud" | "vm" | "local";
type Backend = "box" | "vps";
type DefaultsRequest = {
  computers: Destination[];
  cloudBackend: Backend;
  allowedComputers?: Destination[] | null;
  /** New per-provider shape mirrored onto every save so the
   * redesigned primary editor renders the same state.  Optional so
   * the existing call sites that omit it continue to type-check. */
  computerProviders?: ComputerProviders;
  vpsMode?: VpsMode | undefined;
};
type ConsentRequest = {
  kind: "save" | "apply";
  method: "PUT" | "POST";
  path: "/api/config" | "/api/bots/apply-defaults";
  body: { botDefaults: DefaultsRequest };
};

const DESTINATION_LABEL: Record<Destination, string> = {
  cloud: "ASCII.dev Box (VM)",
  vm: "Local VM",
  local: "This Computer",
};

const DESTINATIONS: Destination[] = ["cloud", "vm", "local"];

/** Read-only view of the workspace allowlist in the legacy card.
 *
 * The Providers card (`<LocalComputerSection>`) owns this state and gates
 * every disable behind `<ComputerImpactConfirmModal>`, which lists the bots
 * that would lose a leg of their grant.  An editable copy here would let an
 * operator turn Cloud, Local VM or This Computer off with no such
 * confirmation, so this card only mirrors what the Providers card saved. */
export function AllowedComputersSummary({ allowed }: { allowed: Destination[] | null }) {
  const isAllowed = (d: Destination) => allowed === null || allowed.includes(d);
  return (
    <Card
      title="Allowed Computers"
      subtitle="The destinations any bot in this workspace is allowed to use.  This mirrors the Providers card above; change it there, where turning a provider off first shows which bots it affects."
    >
      <div className="flex overflow-hidden rounded-lg border border-hairline/40" role="list">
        {DESTINATIONS.map((mode, i) => {
          const enabled = isAllowed(mode);
          return (
            <div
              key={mode}
              role="listitem"
              aria-label={`${DESTINATION_LABEL[mode]}: ${enabled ? "allowed" : "not allowed"}`}
              className={cn(
                "flex-1 py-1.5 text-center text-[13px]",
                i > 0 && "border-l border-hairline/40",
                enabled ? "bg-control text-ink font-medium" : "text-ink-secondary",
              )}
            >
              {DESTINATION_LABEL[mode]}
            </div>
          );
        })}
      </div>
      <div className="mt-2 text-[11.5px] text-ink-secondary">
        {allowed === null
          ? "Every destination is allowed — the shipped default."
          : allowed.length === 0
            ? "No destination is allowed.  Every bot is locked to its current choice (or auto) until you re-enable one."
            : `${allowed.length} of 3 destinations allowed.  A bot that picked a disabled destination keeps that choice, but the run is refused.`}
      </div>
    </Card>
  );
}

export function BotComputerDefaults() {
  const { state, dispatch } = useStore();
  const saved = state.config?.botDefaults;
  const [computers, setComputers] = useState<Destination[]>([]);
  const [backend, setBackend] = useState<Backend>("box");
  const [allowed, setAllowed] = useState<Destination[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the server refuses an apply with `needsAcknowledgement` — the
  // named bots would gain This Computer + Auto with nobody having seen the
  // warning.  Non-null shows the shared confirm dialog; confirming resubmits
  // the same defaults and the exact identities shown in the warning.
  const [pendingAck, setPendingAck] = useState<{
    bots: { id: string; name: string }[];
    request: ConsentRequest;
  } | null>(null);
  const vpsConfigured = Boolean(state.config?.vps?.configured);

  useEffect(() => {
    setComputers(saved?.computers ?? []);
    setBackend(saved?.cloudBackend ?? "box");
    // Read the allowlist from the new per-provider shape first, then
    // fall back to the legacy field for installs that pre-date the
    // migration.  This keeps both editors rendering the same state
    // even when only one of them was the last writer.
    setAllowed(saved?.computerProviders ? allowedFromProviders(saved.computerProviders) : (saved?.allowedComputers ?? null));
  }, [saved?.computers, saved?.cloudBackend, saved?.allowedComputers, saved?.computerProviders]);

  const restoreSavedDefaults = () => {
    setComputers(saved?.computers ?? []);
    setBackend(saved?.cloudBackend ?? "box");
    setAllowed(saved?.computerProviders ? allowedFromProviders(saved.computerProviders) : (saved?.allowedComputers ?? null));
  };

  const submit = (request: ConsentRequest, acknowledgedBots?: { id: string; name: string }[]) => {
    if (request.kind === "save") setSaving(true);
    else setApplying(true);
    setError(null);
    api(request.path, {
      method: request.method,
      body: JSON.stringify({
        ...request.body,
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
          setPendingAck(null);
          setError(e.message);
          if (request.kind === "save") restoreSavedDefaults();
        }
      })
      .finally(() => {
        if (request.kind === "save") setSaving(false);
        else setApplying(false);
      });
  };

  // Provider policy is read-only in this legacy card (see
  // AllowedComputersSummary): turning a provider off must go through the
  // Providers card's affected-bot confirmation, and every provider save there
  // carries a compare-and-swap snapshot.  So a save here sends only the
  // computer defaults.  Re-sending the allowlist, provider flags or VPS mode
  // from this card's copy of the config let a stale card write old flags
  // back over a newer save; the server keeps the stored ones untouched.
  const save = (next: { computers?: Destination[]; backend?: Backend }) => {
    const nextComputers = [...(next.computers ?? computers)];
    const nextBackend = next.backend ?? backend;
    setComputers(nextComputers);
    setBackend(nextBackend);
    submit({
      kind: "save",
      method: "PUT",
      path: "/api/config",
      body: {
        botDefaults: {
          computers: nextComputers,
          cloudBackend: nextBackend,
        },
      },
    });
  };

  const applyDefaults = () => {
    submit({
      kind: "apply",
      method: "POST",
      path: "/api/bots/apply-defaults",
      body: { botDefaults: { computers: [...computers], cloudBackend: backend } },
    });
  };

  const options: Array<[Destination, string]> = DESTINATIONS.map((d) => [d, DESTINATION_LABEL[d]]);
  // When the allowlist disables every destination, the workspace default
  // picker is showing the operator what would be applied if they ever
  // re-enabled a destination — and "Set all bots to default" will save it
  // unchanged, because the apply endpoint filters the default through the
  // same allowlist.
  const allowedCount = allowed === null ? 3 : allowed.length;
  const applyDisabled = applying || saving || allowedCount === 0;

  return (
    <>
      <AllowedComputersSummary allowed={allowed} />

      <Card
        title="New Bots"
        subtitle="Which computers a bot gets before anyone opens its settings.  Pick more than one and it chooses per task.  Leave all of them off to keep the shipped behavior: reuse whatever already exists, create nothing."
      >
        <div className="flex overflow-hidden rounded-lg border border-hairline/40">
          {options.map(([mode, label], i) => (
            <button
              key={mode}
              disabled={saving}
              onClick={() =>
                save({ computers: computers.includes(mode) ? computers.filter((c) => c !== mode) : [...computers, mode] })
              }
              className={cn(
                "flex-1 py-1.5 text-[13px]",
                i > 0 && "border-l border-hairline/40",
                saving && "opacity-60",
                computers.includes(mode)
                  ? "bg-control text-ink font-medium"
                  : "text-ink-secondary hover:bg-control/60 hover:text-ink",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {computers.includes("cloud") && (
          <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
            {(["box", "vps"] as const).map((option, i) => (
              <button
                key={option}
                disabled={saving || (option === "vps" && !vpsConfigured)}
                title={option === "vps" && !vpsConfigured ? "Add the VPS SSH alias under Connections first" : undefined}
                onClick={() => save({ backend: option })}
                className={cn(
                  "flex-1 py-1.5 text-[12px]",
                  i > 0 && "border-l border-hairline/40",
                  option === "vps" && !vpsConfigured && "cursor-not-allowed opacity-40",
                  backend === option
                    ? "bg-control text-ink font-medium"
                    : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                )}
              >
                {option === "vps" ? "Self-hosted VPS" : "ASCII.dev Box (VM)"}
              </button>
            ))}
          </div>
        )}
        {computers.includes("cloud") && !vpsConfigured && (
          <div className="mt-2 text-[11.5px] text-ink-secondary">
            To use Self-hosted VPS, add an SSH host alias in App Settings → Connections.
          </div>
        )}
        <div className="mt-2 text-[11.5px] text-ink-secondary">
          {computers.length === 0
            ? "New bots use whatever computer already exists, and create nothing."
            : `New bots get ${computers.length > 1 ? "all of these" : "this"}.  Bots you have already set up keep their own choice, and a bot you turned off stays off.`}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            disabled={applyDisabled}
            onClick={() => void applyDefaults()}
            title={
              allowedCount === 0
                ? "Allow at least one destination first."
                : "Apply this default to every bot, filtered through the allowlist above."
            }
            className={cn(
              "rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110",
              applyDisabled && "opacity-50",
            )}
          >
            {applying ? "Applying…" : "Set All Bots To Default"}
          </button>
          <span className="text-[11.5px] text-ink-secondary">
            Applies the current default to every bot, intersected with the allowlist above.
          </span>
        </div>
      </Card>
      {error && <div className="mt-2 text-[11.5px] text-danger">{error}</div>}
      <LocalComputerAutoWarning
        open={pendingAck !== null}
        onCancel={() => {
          if (pendingAck?.request.kind === "save") restoreSavedDefaults();
          setPendingAck(null);
        }}
        bots={pendingAck?.bots}
        busy={applying || saving}
        onConfirm={() => pendingAck && submit(pendingAck.request, pendingAck.bots)}
      />
    </>
  );
}
