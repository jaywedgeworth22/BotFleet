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
// primary view.  This card still edits the same on-disk shape; to keep
// both editors consistent we mirror every write onto the new
// `botDefaults.computerProviders` and `botDefaults.vpsMode` fields the
// primary view owns.  A future lane (see audit doc) will delete this
// card once every install has had a release to migrate.
import { useEffect, useState } from "react";
import { ApiError, api, useStore, type ConfigStatus } from "@/state/store";
import { Card } from "./SettingsPrimitives";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { cn } from "@/lib/cn";
import { DEFAULT_VPS_MODE, type ComputerProviders, type VpsMode } from "../../shared/local-auto-consent";

/** Derive the new per-provider shape from the legacy allowlist array so
 * the primary editor (LocalComputerSection) renders the same on-disk
 * state this legacy card just wrote.
 *
 * The legacy "cloud" destination cannot tell ASCII.dev Box from the
 * Self-Hosted VPS, so a legacy save must not decide that split: while
 * cloud stays allowed, the Box/VPS values the primary editor last wrote
 * are carried over unchanged.  Without that, any save here (even just
 * changing the New Bots default) would quietly turn a provider back on
 * that the operator had turned off in the primary editor.  Only when
 * cloud goes from blocked to allowed does it enable both, which is what
 * the legacy "cloud" always meant. */
function providersFromAllowed(
  allowed: Destination[] | null,
  previous: ComputerProviders | undefined,
): ComputerProviders {
  const cloudAllowed = allowed === null || allowed.includes("cloud");
  const keepCloudSplit = previous !== undefined && (previous.asciiBox || previous.selfHostedVps);
  return {
    asciiBox: cloudAllowed && (keepCloudSplit ? Boolean(previous?.asciiBox) : true),
    selfHostedVps: cloudAllowed && (keepCloudSplit ? Boolean(previous?.selfHostedVps) : true),
    localVm: allowed === null || allowed.includes("vm"),
    localMac: allowed === null || allowed.includes("local"),
  };
}

/** Inverse: derive the legacy allowlist from the new per-provider
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

/** The allowlist is persisted as either absent (every destination is allowed,
 * the shipped default) or an array of destinations.  On the wire we say the
 * first state as an explicit `null`, and the server drops the stored key when
 * it sees one — omitting the field instead would merge into whatever is
 * already on disk, so turning the last destination back on would appear to
 * work and then come back narrowed on the next reload. */
function allowedForWire(value: Destination[] | null | undefined): Destination[] | null {
  if (value === null || value === undefined) return null;
  return value;
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

  const save = (
    next: { computers?: Destination[]; backend?: Backend; allowed?: Destination[] | null },
  ) => {
    const nextComputers = [...(next.computers ?? computers)];
    const nextBackend = next.backend ?? backend;
    const nextAllowed = next.allowed === undefined ? allowed : next.allowed;
    setComputers(nextComputers);
    setBackend(nextBackend);
    setAllowed(nextAllowed);
    // Mirror the legacy allowlist onto the new `computerProviders`
    // shape so the redesigned primary editor renders the same state.
    // The Box/VPS split and the VPS mode are owned by the primary view;
    // see providersFromAllowed for how they are carried over.
    const nextProviders = providersFromAllowed(nextAllowed, saved?.computerProviders);
    submit({
      kind: "save",
      method: "PUT",
      path: "/api/config",
      body: {
        botDefaults: {
          computers: nextComputers,
          cloudBackend: nextBackend,
          allowedComputers: allowedForWire(nextAllowed),
          computerProviders: nextProviders,
          // Keep the stored mode while the VPS stays on; clear it when this
          // save turns the VPS off, and pick the default when it turns it on,
          // so the primary view never sees an on-VPS with no mode.
          vpsMode: nextProviders.selfHostedVps ? (saved?.vpsMode ?? DEFAULT_VPS_MODE) : null,
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

  const destinations: Destination[] = ["cloud", "vm", "local"];
  const options: Array<[Destination, string]> = destinations.map((d) => [d, DESTINATION_LABEL[d]]);
  const isAllowed = (d: Destination) => allowed === null || allowed.includes(d);
  // When the allowlist disables every destination, the workspace default
  // picker is showing the operator what would be applied if they ever
  // re-enabled a destination — and "Set all bots to default" will save it
  // unchanged, because the apply endpoint filters the default through the
  // same allowlist.
  const allowedCount = allowed === null ? 3 : allowed.length;
  const applyDisabled = applying || saving || allowedCount === 0;

  return (
    <>
      <Card
        title="Allowed Computers"
        subtitle="The destinations any bot in this workspace is allowed to use.  Disabling a destination here keeps every bot off it, no matter what a bot's own settings say.  Leave everything on to keep the shipped behavior."
      >
        <div className="flex overflow-hidden rounded-lg border border-hairline/40">
          {options.map(([mode, label], i) => {
            const enabled = isAllowed(mode);
            return (
              <button
                key={mode}
                disabled={saving}
                onClick={() => {
                  // The allowlist is either "everything" (null) or an array.
                  // Clicking the one ON in an everything-allowed state turns
                  // it into "everywhere except this one"; clicking a disabled
                  // destination back on adds it back.
                  if (allowed === null) {
                    save({ allowed: destinations.filter((d) => d !== mode) });
                  } else {
                    const next = enabled
                      ? allowed.filter((d) => d !== mode)
                      : [...allowed, mode];
                    save({ allowed: next.length === destinations.length ? null : next });
                  }
                }}
                className={cn(
                  "flex-1 py-1.5 text-[13px]",
                  i > 0 && "border-l border-hairline/40",
                  saving && "opacity-60",
                  enabled
                    ? "bg-control text-ink font-medium"
                    : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                )}
              >
                {label}
              </button>
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
