// MiniMax callout — the single source of truth for the engine-level product
// chrome owners see on the engines-settings row and the model-picker rail.
//
// Compact by default so the heading + model list underneath stay visible at
// narrow widths.  A "Why This Engine?" disclosure folds the fuller explanation
// (chat vs room semantics and the DeepSeek Harness + MiniMax M3 option)
// behind one tap.
import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/cn";

export function MiniMaxCallout({ instanceId }: { instanceId: string }) {
  const [open, setOpen] = useState(false);
  // The disclosure id must be unique per engine instance: the engines page
  // can render several MiniMax callouts, and duplicate ids break
  // aria-controls for every callout after the first.
  const detailId = `minimax-callout-detail-${instanceId}`;
  return (
    <div className="mt-2 rounded bg-accent/10 px-2 py-1.5 text-[11px] leading-relaxed text-ink-secondary border border-accent/20">
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <strong className="text-ink">Talks to the Team.</strong>
          {"  "}Includes Files, Terminal, and this computer.
        </div>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={detailId}
          className="shrink-0 rounded px-1 py-0.5 text-[11px] font-medium text-ink-secondary hover:bg-accent/15 hover:text-ink"
        >
          Why This Engine?
          <ChevronDown
            size={11}
            aria-hidden="true"
            className={cn("ml-0.5 inline-block transition-transform", open && "rotate-180")}
          />
        </button>
      </div>
      {open && (
        <div id={detailId} className="mt-1.5 flex flex-col gap-1">
          <span>
            In a chat this bot starts, it can see the other bots, ask one, list routines, request a key, and propose a schedule.
            {"  "}None of that runs when another bot asked it.
          </span>
          <span>
            A section lead can add a specialist, but only in a direct chat — not in a room.
          </span>
          <span>
            MiniMax direct does not include web access or connected apps.
            {"  "}DeepSeek Harness with MiniMax M3 adds connected apps and more tools, but it cannot accept image attachments.
          </span>
        </div>
      )}
    </div>
  );
}
