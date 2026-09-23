// Master view of every bot's per-provider grant.  Renders one row per
// bot with four columns (one per `ComputerProviderId`); each cell shows
// a check-mark when the bot currently has that provider in its grant,
// otherwise a neutral dash.  The header carries an "Apply new default
// to all" button that opens a confirmation modal so an operator can
// batch-set every bot's grant in one click.
//
// The matrix is intentionally read-only at the cell level: clicking a
// cell never opens a per-bot editor.  Per-bot edits live in the bot's
// own Settings panel (`SettingsPanel.tsx`'s Computer section).  The
// matrix is the canonical "what does every bot have" surface, and the
// batch button is the canonical "make everyone match the workspace
// default" surface.
import { useState } from "react";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Bot } from "@/state/store";
import type { ComputerProviders } from "../../shared/local-auto-consent";
import {
  COMPUTER_PROVIDER_LABEL,
  COMPUTER_PROVIDER_ORDER,
} from "../../shared/local-auto-consent";
import { ConfirmDialog } from "./ConfirmDialog";

/** Provider keys per bot.  The matrix derives this from the bot's
 * `computers[]` field (the legacy wire shape) and the workspace
 * `botDefaults.computerProviders` so a cell lights up whether the bot
 * itself selected the provider or inherited the workspace default.
 *
 * For the `"cloud"` destination, the matrix lights up exactly the
 * backend the runtime will pick: the bot's own `cloudBackend` if set,
 * else the workspace default, else `"box"`.  This matches
 * `server/computer-grants.ts:resolveCloudBackend` so the matrix
 * reflects what the bot actually has, not a fictional "cloud as
 * either backend" superset.  Keeping the mapping in one place means a
 * future server-side change to the grant shape only touches this
 * helper, not the cell render. */
export function providersForBot(
  bot: Bot,
  workspaceProviders: ComputerProviders | undefined,
  workspaceCloudBackend?: "box" | "vps",
): ComputerProviders {
  // "off" means the operator disabled the bot — no providers light up.
  if (bot.computers !== undefined && bot.computers.length === 0) {
    return { asciiBox: false, selfHostedVps: false, localVm: false, localMac: false };
  }
  // Auto (computers undefined): the bot inherits whatever the workspace
  // default enables.  A bot with no cloudBackend and no workspace
  // default falls back to "box", matching server-side resolveCloudBackend.
  if (bot.computers === undefined) {
    return {
      asciiBox: Boolean(workspaceProviders?.asciiBox),
      selfHostedVps: Boolean(workspaceProviders?.selfHostedVps),
      localVm: Boolean(workspaceProviders?.localVm),
      localMac: Boolean(workspaceProviders?.localMac),
    };
  }
  // Explicit selection: map each legacy destination back onto the
  // provider keys.  "cloud" lights the resolved backend only —
  // `asciiBox` if the runtime would pick Box, `selfHostedVps` if it
  // would pick VPS.  This stops the matrix from reporting a
  // nonexistent grant when the operator toggles one cloud backend off
  // while the bot's resolved backend is the other.
  let asciiBox = false;
  let selfHostedVps = false;
  let localVm = false;
  let localMac = false;
  const resolvedCloud: "box" | "vps" = bot.cloudBackend ?? workspaceCloudBackend ?? "box";
  for (const dest of bot.computers) {
    if (dest === "cloud") {
      if (resolvedCloud === "box") asciiBox = true;
      else selfHostedVps = true;
    } else if (dest === "vm") {
      localVm = true;
    } else if (dest === "local") {
      localMac = true;
    }
  }
  return { asciiBox, selfHostedVps, localVm, localMac };
}

export type BotComputerMatrixProps = {
  bots: Bot[];
  workspaceProviders: ComputerProviders | undefined;
  /** Disabled while the apply-all-to-bots save is in flight, so the
   * button does not double-fire and the rows do not flicker. */
  busy?: boolean;
  /** Called when the operator confirms "Apply new default to all".
   * The parent is expected to fire `POST /api/bots/apply-defaults`
   * with the workspace defaults and surface any `needsAcknowledgement`
   * the server returns. */
  onApplyToAll: () => void | Promise<void>;
};

export function BotComputerMatrix({ bots, workspaceProviders, busy, onApplyToAll }: BotComputerMatrixProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Bots in any state (active, off, auto) are listed.  Bots without a
  // name still get a row so an empty roster is visible; a future
  // filter can drop them if the list grows.
  return (
    <div className="flex flex-col gap-2" data-testid="bot-computer-matrix">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">
          Per-bot grants
        </div>
        <button
          type="button"
          disabled={busy || bots.length === 0}
          onClick={() => setConfirmOpen(true)}
          className={cn(
            "rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110",
            (busy || bots.length === 0) && "opacity-50",
          )}
          data-testid="matrix-apply-default-button"
        >
          {busy ? "Applying…" : "Apply new default to all"}
        </button>
      </div>
      <div className="overflow-hidden rounded-xl border border-hairline/40">
        <table className="w-full text-left text-[12.5px]">
          <thead className="bg-control text-[11.5px] uppercase tracking-wide text-ink-secondary">
            <tr>
              <th className="px-3 py-2 font-medium">Bot</th>
              {COMPUTER_PROVIDER_ORDER.map((id) => (
                <th key={id} className="px-3 py-2 text-center font-medium">
                  {COMPUTER_PROVIDER_LABEL[id]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bots.length === 0 ? (
              <tr>
                <td colSpan={COMPUTER_PROVIDER_ORDER.length + 1} className="px-3 py-3 text-center text-ink-secondary">
                  No bots yet.
                </td>
              </tr>
            ) : (
              bots.map((bot) => {
                const providers = providersForBot(bot, workspaceProviders);
                const isOff = bot.computers !== undefined && bot.computers.length === 0;
                return (
                  <tr key={bot.id} className="border-t border-hairline/40">
                    <td className="px-3 py-2 text-ink">
                      <span className={cn(isOff && "text-ink-secondary")}>{bot.name}</span>
                      {isOff && (
                        <span className="ml-2 rounded bg-hairline/40 px-1.5 py-0.5 text-[10.5px] uppercase text-ink-secondary">
                          Off
                        </span>
                      )}
                    </td>
                    {COMPUTER_PROVIDER_ORDER.map((id) => {
                      const on = providers[id] === true;
                      return (
                        <td key={id} className="px-3 py-2 text-center">
                          {on ? (
                            <span
                              className="inline-flex size-5 items-center justify-center rounded-full bg-accent/15 text-accent"
                              data-testid={`matrix-cell-${bot.id}-${id}-on`}
                              aria-label={`${bot.name}: ${COMPUTER_PROVIDER_LABEL[id]} on`}
                            >
                              <Check size={12} />
                            </span>
                          ) : (
                            <span
                              className="inline-flex size-5 items-center justify-center text-ink-secondary"
                              data-testid={`matrix-cell-${bot.id}-${id}-off`}
                              aria-label={`${bot.name}: ${COMPUTER_PROVIDER_LABEL[id]} off`}
                            >
                              <Minus size={12} />
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="Apply the workspace default to every bot?"
        body="Every bot in this workspace will be set to the workspace default, intersected with the provider toggles above.  Bots you have already turned off stay off."
        confirmLabel="Apply to all"
        destructive={false}
        busy={busy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={async () => {
          setConfirmOpen(false);
          await onApplyToAll();
        }}
      />
    </div>
  );
}