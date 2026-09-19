// MiniMax callout — the single source of truth for the engine-level product
// chrome owners see on the engines-settings row and the model-picker rail.
//
// Compact by default so the heading + model list underneath stay visible at
// narrow widths.  A "Why this engine?" disclosure folds the fuller explanation
// (chat vs room semantics, the DeepSeek Harness + MiniMax M3 path for full
// tool support) behind one tap.
import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/cn";

export function MiniMaxCallout() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 rounded bg-accent/10 px-2 py-1.5 text-[11px] leading-relaxed text-ink-secondary border border-accent/20">
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <strong className="text-ink">Talks to the Team.</strong>
          {"  "}Lacks Files, Terminal, the web, and connected apps.
        </div>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="minimax-callout-detail"
          className="shrink-0 rounded px-1 py-0.5 text-[11px] font-medium text-ink-secondary hover:bg-accent/15 hover:text-ink"
        >
          Why this engine?
          <ChevronDown
            size={11}
            className={cn("ml-0.5 inline-block transition-transform", open && "rotate-180")}
          />
        </button>
      </div>
      {open && (
        <div id="minimax-callout-detail" className="mt-1.5 flex flex-col gap-1">
          <span>
            In a chat this bot starts, it can see the other bots, ask one, list routines, request a key, and propose a schedule.
            {"  "}None of that runs when another bot asked it.
          </span>
          <span>
            A section lead can add a specialist, but only in a direct chat — not in a room.
          </span>
          <span>
            Files, Terminal, the web, connected apps, and this computer need Claude, Codex, Antigravity, or Cursor.
            {"  "}Want MiniMax with full tool support?  Use the DeepSeek Harness engine with MiniMax M3 as the model.
          </span>
        </div>
      )}
    </div>
  );
}
