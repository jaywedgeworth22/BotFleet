// Confirmation modal that the redesigned Computer settings UI opens
// before turning a provider OFF.  Lists the bots that would lose a leg
// of their grant, names the provider they would lose, and offers two
// buttons: "Disable anyway" (accent red) and "Cancel" (neutral).  The
// modal deliberately does NOT itself commit the change — it calls back
// to the parent, which dispatches the toggle with the impact already
// acknowledged.  This keeps the dispatch authoritative on the parent
// and lets the parent re-show the toggle row in its OFF state once the
// save round-trips.
//
// Built on the same shell as `src/components/ConfirmDialog.tsx` so the
// panel has one modal style; the diff from that pattern is the list of
// affected bots, which a generic confirm dialog cannot render.
import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ComputerProviderId, ComputerProviders } from "../../shared/local-auto-consent";
import { COMPUTER_PROVIDER_LABEL } from "../../shared/local-auto-consent";

export type ImpactedBot = {
  id: string;
  name: string;
  /** The bot's current `computers[]` value, kept verbatim so the row
   * shows exactly what the operator saw before the toggle. */
  currentSelection: string[];
  /** Per-provider state the bot currently has.  Only the entry for the
   * `disabledProvider` matters for the impact listing — the others are
   * surfaced as context but are not about to be lost. */
  providers: ComputerProviders;
};

export type ComputerImpactConfirmModalProps = {
  open: boolean;
  disabledProvider: ComputerProviderId;
  bots: ImpactedBot[];
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

/** A `<ComputerImpactConfirmModal>` lists the bots that would lose
 * their current selection if the named provider were disabled, and
 * asks once before committing.  Renders nothing when `open` is false
 * so the parent's state machine stays simple. */
export function ComputerImpactConfirmModal({
  open,
  disabledProvider,
  bots,
  busy,
  onCancel,
  onConfirm,
}: ComputerImpactConfirmModalProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open || busy) return;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel, busy]);

  if (!open) return null;

  const providerLabel = COMPUTER_PROVIDER_LABEL[disabledProvider];
  const affected = bots.filter((bot) => bot.providers[disabledProvider] === true);
  const noOneAffected = affected.length === 0;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(event) => !busy && event.target === event.currentTarget && onCancel()}
      data-testid="computer-impact-confirm-modal"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="computer-impact-confirm-title"
        aria-describedby="computer-impact-confirm-body"
        className="w-full max-w-[480px] rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <h2 id="computer-impact-confirm-title" className="text-[15px] font-semibold text-ink">
              Disable {providerLabel}?
            </h2>
            <p id="computer-impact-confirm-body" className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
              {noOneAffected
                ? "No bot currently uses this provider, so disabling it is a no-op."
                : `${affected.length} bot${affected.length === 1 ? "" : "s"} currently use${affected.length === 1 ? "s" : ""} ${providerLabel}.  Disabling it removes that leg of their grant until you re-enable the provider or the bot picks a different one.`}
            </p>
            {!noOneAffected && (
              <ul className="mt-3 max-h-[200px] overflow-y-auto rounded-lg border border-hairline/40 bg-inset">
                {affected.map((bot) => (
                  <li
                    key={bot.id}
                    className="flex items-center justify-between gap-2 border-b border-hairline/40 px-3 py-2 text-[13px] last:border-b-0"
                  >
                    <span className="truncate text-ink">{bot.name}</span>
                    <span className="shrink-0 font-mono text-[11.5px] text-ink-secondary" title={bot.currentSelection.join(", ")}>
                      {bot.currentSelection.join(" · ") || "(no selection)"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={cn(
              "rounded-xl px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50",
              noOneAffected ? "bg-accent" : "bg-danger",
            )}
            data-testid="computer-impact-confirm-button"
          >
            Disable anyway
          </button>
        </div>
      </div>
    </div>
  );
}