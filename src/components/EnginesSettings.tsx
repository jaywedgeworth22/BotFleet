// Engines settings — per-instance CLI path override. One "Set CLI…" button
// per engine reveals a picker: a "detected" dropdown of every binary the
// server found on PATH, plus a manual path input. Saving first probes the
// binary (`<cli> --version`, same PATH a real turn uses); a failed probe
// asks before registering — the classic miss is a path the terminal sees
// but this GUI app can't.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, TriangleAlert } from "lucide-react";

import { api, useStore, type InstanceInfo } from "@/state/store";
import { EngineGroupLabel } from "./EngineGroupLabel";
import { ProviderMark } from "./ProviderIcons";
import { splitEngineRail } from "@/lib/engine-rail";
import { cn } from "@/lib/cn";

interface ProbeResult {
  ok: boolean;
  version?: string;
  message?: string;
}

/** Default the toggle to ON when the persisted config never had the field
 * — the registry treats absent `enabled` as `true` and the UI must match. */
function isEngineEnabled(instance: InstanceInfo): boolean {
  return instance.enabled !== false;
}

function CustomPicker({
  instance,
  cliDefault,
  isBusy,
  onClose,
  onSave,
}: {
  instance: InstanceInfo;
  cliDefault?: string;
  isBusy?: boolean;
  onClose: () => void;
  onSave: (cli: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [candidates, setCandidates] = useState<string[] | null>(instance.cliCandidates ?? null);
  // `selected` starts EMPTY, never at instance.cli: a wrapper override
  // ("/ag claude agp") has no matching <option>, and a select whose value
  // points at a missing option renders the placeholder while still holding
  // the ghost value — the form would look empty yet refuse to save.
  const [selected, setSelected] = useState<string>("");
  const [manual, setManual] = useState<string>(
    // the current override rides the manual input unless it is exactly a
    // detected path (then the dropdown preselects it below)
    instance.cli && !(instance.cliCandidates ?? []).includes(instance.cli) ? instance.cli : "",
  );
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  // The describe() snapshot can be stale (CLI installed since last refresh);
  // re-fetch candidates once when the picker mounts so the dropdown is current.
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    api(`/api/cli-candidates?name=${encodeURIComponent(cliDefault ?? "")}`)
      .then(({ candidates: found }: { candidates: string[] }) => {
        setCandidates(found);
        if (!instance.cli) return;
        // preselect a detected override in the dropdown; a non-detected one
        // (wrapper string, moved binary) rides the manual input instead
        if (found.includes(instance.cli)) setSelected(instance.cli);
        else setManual(instance.cli);
      })
      .catch(() => setCandidates((prev) => prev ?? []));
  }, [cliDefault, instance.cli]);

  const value = manual.trim() || selected;
  const dirty = value !== (instance.cli ?? "");
  const busy = probing || saving || Boolean(isBusy);

  // Editing the path invalidates a previous probe result.
  useEffect(() => {
    setProbe(null);
  }, [value]);

  const persist = () => {
    if (busy || !value || !dirty) return;
    setSaving(true);
    setError(null);
    const committed = value; // freeze: inputs disable during save, but the
    // closure must not see a later keystroke either
    onSave(committed)
      .then((res) => {
        if (res.ok) {
          onClose();
        } else {
          setError(res.error ?? "Failed to save CLI path");
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const save = () => {
    if (busy || !value || !dirty) return;
    setProbing(true);
    setError(null);
    api("/api/cli-test", {
      method: "POST",
      body: JSON.stringify({ cli: value, driver: instance.driverKind }),
    })
      .then((result: ProbeResult) => {
        setProbe(result);
        // ok → save immediately; failed → hold for explicit confirmation
        if (result.ok) persist();
      })
      .catch((e) => setError(e.message))
      .finally(() => setProbing(false));
  };

  return (
    <div className="mt-2.5 flex flex-col gap-2">
      {candidates !== null && candidates.length > 0 && (
        <div className="relative">
          <select
            value={manual.trim() ? "" : selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setManual("");
            }}
            aria-label={`${instance.displayName} detected CLI`}
            disabled={busy}
            className="w-full appearance-none rounded-lg border border-hairline/40 bg-inset px-3 py-2 pr-8 font-mono text-[12px] text-ink focus:border-hairline focus:outline-none disabled:opacity-50"
          >
            <option value="">Select a detected binary…</option>
            {candidates.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <ChevronDown size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-secondary" />
        </div>
      )}
      <input
        type="text"
        value={manual}
        onChange={(e) => setManual(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (!value || !dirty) return; // nothing to save — same hint the disabled button gives
          save();
        }}
        placeholder={candidates?.length ? "Enter path manually…" : "/absolute/path/to/cli"}
        aria-label={`${instance.displayName} custom CLI path`}
        spellCheck={false}
        disabled={busy}
        className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink placeholder:font-sans placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-50"
      />
      {probe && !probe.ok && probe.message && (
        <div role="alert" className="flex gap-1.5 rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-2 text-[12px] leading-relaxed text-warning">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>
            Test failed — {probe.message}
            {" "}Register this path anyway?
          </span>
        </div>
      )}
      {probe?.ok && probe.version && (
        <div className="text-[12px] text-success">Test passed — {probe.version}</div>
      )}
      {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          disabled={busy}
          className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
        {probe && !probe.ok ? (
          <>
            <button
              onClick={() => setProbe(null)}
              disabled={busy}
              className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"
            >
              Edit path
            </button>
            <button
              onClick={() => persist()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-danger hover:bg-raised-hover disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : "Save Anyway"}
            </button>
          </>
        ) : (
          <button
            onClick={save}
            disabled={busy || !value || !dirty}
            className={cn(
              "flex w-[72px] items-center justify-center gap-1.5 rounded-lg py-1.5 text-[13px]",
              "bg-raised text-ink hover:bg-raised-hover",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />Save</>}
          </button>
        )}
      </div>
    </div>
  );
}

function EngineRow({
  instance,
  busyInstanceId,
  onPatch,
}: {
  instance: InstanceInfo;
  busyInstanceId: string | null;
  onPatch: (
    patch: { cli?: string; fullAuto?: boolean; enabled?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasOpenFor = useRef<string | null>(null);

  // A disabled engine keeps the same controls visible — ungrey them while
  // you flip the toggle back on is the right call — but none of them should
  // be *clickable*. Use the per-row `enabled` state, not the snapshot reason,
  // because a separately-disabled wildcard cooldown on an otherwise available
  // engine is the wrong gate (we want settings, not quotas, to block the row).
  const enabled = isEngineEnabled(instance);
  const isBusy = busyInstanceId !== null;
  const isThisBusy = busyInstanceId === instance.instanceId;

  // Close the picker when this instance's override changes to anything else
  // — a save from this row, another tab, or the 5-min refresh. The picker
  // initialized its fields from the OLD value and never re-syncs, so staying
  // open would show stale state.
  useEffect(() => {
    if (wasOpenFor.current !== null && wasOpenFor.current !== instance.cli) {
      setOpen(false);
    }
    wasOpenFor.current = instance.cli ?? null;
  }, [instance.cli]);

  const patchWithLocalError = async (patch: { cli?: string; fullAuto?: boolean; enabled?: boolean }) => {
    setError(null);
    const res = await onPatch(patch);
    if (!res.ok && res.error) {
      setError(res.error);
    }
    return res;
  };

  const reset = () => {
    if (isBusy || !enabled) return;
    void patchWithLocalError({ cli: "" });
  };

  const toggleEnabled = (next: boolean) => {
    if (isBusy) return;
    void patchWithLocalError({ enabled: next });
  };

  return (
    <div>
      <div className="flex items-center gap-2 text-[13px]">
        <label
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-[11.5px] uppercase tracking-wide",
            enabled ? "text-ink-secondary cursor-pointer" : "text-ink-secondary/70 cursor-pointer",
            isBusy && "cursor-not-allowed opacity-60",
          )}
          title={enabled ? "Disable this engine" : "Enable this engine"}
        >
          <input
            type="checkbox"
            aria-label={`${instance.displayName} enabled`}
            className="accent-accent"
            checked={enabled}
            disabled={isBusy}
            onChange={(e) => toggleEnabled(e.target.checked)}
          />
          {enabled ? "On" : "Off"}
        </label>
        <span className={cn("size-1.5 shrink-0 rounded-full", instance.cli ? "bg-accent" : "bg-raised-hover")} />
        <ProviderMark driverKind={instance.driverKind} size={18} />
        <span className={cn("shrink-0 flex items-center gap-1.5", enabled ? "text-ink" : "text-ink-secondary/70")}>
          {instance.displayName}
          {isThisBusy && <Loader2 size={12} className="animate-spin text-accent" />}
        </span>
        {instance.cli ? (
          <span className={cn("truncate font-mono text-[11.5px]", enabled ? "text-accent" : "text-ink-secondary/60")} title={instance.cli}>
            {instance.cli}
          </span>
        ) : (
          instance.cliDefault && (
            <span className={cn("truncate text-[11px]", enabled ? "text-ink-secondary" : "text-ink-secondary/60")} title={`${instance.cliDefault} · default`}>{instance.cliDefault} · default</span>
          )
        )}
        <span className="flex-1" />
        {instance.cli && (
          <button
            onClick={reset}
            disabled={isBusy || !enabled}
            className="shrink-0 text-[11.5px] text-ink-secondary hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isThisBusy ? "Resetting…" : "Reset"}
          </button>
        )}
        <label className={cn(
          "flex items-center gap-1.5 shrink-0 text-[12px] text-ink-secondary",
          enabled && !isBusy ? "hover:text-ink cursor-pointer" : "cursor-not-allowed opacity-60",
        )}>
          <input
            type="checkbox"
            className="accent-accent"
            checked={!!instance.fullAuto}
            disabled={isBusy || !enabled}
            onChange={(e) => void patchWithLocalError({ fullAuto: e.target.checked })}
          />
          Bypass permissions (autonomous mode)
        </label>
        <button
          onClick={() => setOpen((v) => !v)}
          disabled={!enabled || isBusy}
          aria-expanded={open}
          className={cn(
            "shrink-0 rounded-lg border border-hairline/40 px-3 py-1 text-[12px]",
            !enabled || isBusy
              ? "cursor-not-allowed opacity-40"
              : open
                ? "bg-accent/15 text-accent"
                : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
          )}
        >
          Set CLI…
        </button>
      </div>
      {instance.driverKind === "antigravityAgent" && (
        <div className="mt-2 rounded bg-raised/40 px-2 py-1.5 text-[11px] leading-relaxed text-ink-secondary border border-hairline/40">
          Antigravity's print mode has no approval cards.  With the bypass off, file edits go through and shell
          commands are refused.  With it on, every tool runs on this computer without asking, and BotFleet's
          permission guards do not apply.
        </div>
      )}
      {["minimax"].includes(instance.driverKind) && (
        <div className="mt-2 rounded bg-accent/10 px-2 py-1.5 text-[11px] leading-relaxed text-ink-secondary border border-accent/20">
          <strong className="text-ink">Native HTTP API.</strong>
          {"  "}Optimized for fast, low-cost text turns with up to a 1M-token context window.
          {"  "}Streams token-level responses and supports the OpenAI function-calling shape.
          {"  "}The harness gives it two tools today — <code>list_bots</code> and{" "}
          <code>ask_bot</code>, run through the HTTP tool loop — and no file, shell, or browser tools.
          {"  "}For bots that need those, pick an ACP engine (Claude, Codex, DSH, Droid) instead —
          they spawn MCP servers natively and execute the calls.
        </div>
      )}
      {error && <div role="alert" className="mt-1 text-[12px] text-danger">{error}</div>}
      {open && enabled && (
        <CustomPicker
          instance={instance}
          cliDefault={instance.cliDefault}
          isBusy={isBusy}
          onClose={() => setOpen(false)}
          onSave={(cli) => patchWithLocalError({ cli })}
        />
      )}
    </div>
  );
}

export function EnginesSettings() {
  const { state, dispatch } = useStore();
  const [busyInstanceId, setBusyInstanceId] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const handlePatch = useCallback(
    async (
      instanceId: string,
      patch: { cli?: string; fullAuto?: boolean; enabled?: boolean },
    ): Promise<{ ok: boolean; error?: string }> => {
      setBusyInstanceId(instanceId);
      setGlobalError(null);
      try {
        const res = await api(`/api/instances/${encodeURIComponent(instanceId)}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        if (res?.instances) {
          dispatch({ type: "instances", instances: res.instances });
        }
        return { ok: true };
      } catch (e: any) {
        const message = e.message || "Failed to update engine settings";
        setGlobalError(message);
        return { ok: false, error: message };
      } finally {
        setBusyInstanceId(null);
      }
    },
    [dispatch],
  );

  // every KNOWN-driver instance has cliDefault; unknown-driver shadows have
  // neither unless an override was set. Including them keeps a Reset-able row
  // (and a Set CLI… path) for engines the running build doesn't recognize.
  const rows = state.instances.filter((i) => i.cli !== undefined || i.cliDefault !== undefined);
  // Disabled rows are surfaced separately so the active rail is short and
  // scannable; the show/hide toggle defaults to hidden to keep the everyday
  // view focused.
  const [showDisabled, setShowDisabled] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      <div className="text-[12px] leading-relaxed text-ink-secondary">
        <strong className="text-ink">Reset</strong> clears the binary override and goes back to the driver's default CLI.{" "}
        <strong className="text-ink">Bypass permissions</strong> hands the engine full tool autonomy (no approval cards) — useful for headless runs, risky on a workstation.{" "}
        <strong className="text-ink">Set CLI…</strong> points the engine at a specific binary — a versioned build, a wrapper script, or an absolute path.{" "}
        Saving any of these reloads providers and interrupts any running turns.
      </div>
      {busyInstanceId && (
        <div className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-[12px] text-accent">
          <Loader2 size={13} className="animate-spin shrink-0" />
          <span>Updating engine settings…</span>
        </div>
      )}
      {globalError && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          <TriangleAlert size={13} className="shrink-0" />
          <span>{globalError}</span>
        </div>
      )}
      {rows.length === 0 && (
        <div className="text-[13px] text-ink-secondary">No CLI engines detected yet.</div>
      )}
      {(() => {
        const enabled = rows.filter(isEngineEnabled);
        const disabled = rows.filter((row) => !isEngineEnabled(row));
        const { subscription, custom } = splitEngineRail(enabled);
        subscription.sort((a, b) => (a.snapshot.state === "unavailable" ? 1 : 0) - (b.snapshot.state === "unavailable" ? 1 : 0));
        return (
          <>
            {subscription.length > 0 && <EngineGroupLabel>Cloud</EngineGroupLabel>}
            {subscription.map((i) => (
              <EngineRow
                key={i.instanceId}
                instance={i}
                busyInstanceId={busyInstanceId}
                onPatch={(patch) => handlePatch(i.instanceId, patch)}
              />
            ))}
            {custom.length > 0 && <EngineGroupLabel className="pt-1">Local</EngineGroupLabel>}
            {custom.map((i) => (
              <EngineRow
                key={i.instanceId}
                instance={i}
                busyInstanceId={busyInstanceId}
                onPatch={(patch) => handlePatch(i.instanceId, patch)}
              />
            ))}
            {disabled.length > 0 && (
              <>
                <div className="mt-2 flex items-center gap-2">
                  <EngineGroupLabel>Engine CLIs Not Enabled</EngineGroupLabel>
                  <button
                    type="button"
                    onClick={() => setShowDisabled((value) => !value)}
                    aria-expanded={showDisabled}
                    className="text-[11px] text-ink-secondary hover:text-ink"
                  >
                    {showDisabled ? "Hide" : `Show (${disabled.length})`}
                  </button>
                </div>
                {showDisabled && (
                  <div className="flex flex-col gap-3 opacity-80">
                    {disabled.map((i) => (
                      <EngineRow
                        key={i.instanceId}
                        instance={i}
                        busyInstanceId={busyInstanceId}
                        onPatch={(patch) => handlePatch(i.instanceId, patch)}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        );
      })()}
    </div>
  );
}
