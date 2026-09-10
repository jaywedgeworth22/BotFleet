// Incoming webhook / routine / iMessage as a collapsible work card, not a
// user bubble.
//
// Auto-delivered instructions are stored as role=system so the model still
// sees them as the turn prompt without a blue user bubble.  Older webhook
// rows used role=user; the card still catches those.  The card sits on the
// transcript's left edge like a tool-run fold: a one-line headline, with
// the untrusted payload behind Details.
import { type ReactNode, useState } from "react";
import { ChevronDown, ChevronRight, Webhook } from "lucide-react";

import { cn } from "@/lib/cn";

export interface TriggerCardView {
  headline: string;
  subtitle?: string;
  payload?: string;
}

export function WebhookCard({
  view,
  icon,
  detailsNoun = "Event Payload",
}: {
  view: TriggerCardView;
  icon?: ReactNode;
  detailsNoun?: string;
}) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(view.payload);

  return (
    <div className="my-0.5 flex justify-start">
      <div
        className={cn(
          "w-full min-w-0 max-w-[36rem] rounded-xl border border-hairline/40 bg-panel/60",
          open ? "p-2" : "",
        )}
      >
        <button
          type="button"
          onClick={expandable ? () => setOpen((value) => !value) : undefined}
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
          title={expandable ? (open ? `Collapse ${detailsNoun}` : `Show ${detailsNoun}`) : view.headline}
          className={cn(
            "group flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-ink-secondary",
            expandable ? "cursor-pointer hover:bg-raised/60 rounded-xl" : "cursor-default",
            open && "rounded-lg border-b border-hairline/30 pb-1.5 hover:bg-transparent",
          )}
        >
          {icon ?? <Webhook size={14} className="shrink-0 text-ink-secondary/70" aria-hidden="true" />}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium text-ink" title={view.headline}>
              {view.headline}
            </span>
            {view.subtitle && (
              <span className="truncate text-[11.5px] text-ink-secondary/80" title={view.subtitle}>
                {view.subtitle}
              </span>
            )}
          </span>
          {expandable && (
            <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-accent">
              <span>{open ? "Collapse" : "Details"}</span>
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          )}
        </button>
        {open && view.payload && (
          <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-hairline/25 bg-inset/40 p-3 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary">
            {view.payload}
          </pre>
        )}
      </div>
    </div>
  );
}
