// Shared "Why this engine?" callout.  Replaces the MiniMax-only
// `<MiniMaxCallout>` so every engine row gets the same prose block —
// the panel used to render detail copy only for the MiniMax row, and a
// reader flipping through Claude / Codex / Cursor had to infer the
// differences themselves.  Reads from the capability registry at
// `src/lib/engine-capabilities.tsx` so the prose and the matrix table
// stay in sync.
//
// Props:
//   - `engineId`  — registry key (e.g. "minimax", "claude", "grok").
//   - `driverKind`— optional runtime driver-kind id.  When the driver
//                   layer reports a name like "grokAgent" the registry
//                   id is "grok"; the helper handles the mapping.
//   - `className` — optional override; default matches the legacy
//                   MiniMax callout's box style.
import * as React from "react";
import {
  EngineCalloutBody,
  engineCapability,
  engineIdFromDriverKind,
  pricingModeLabel,
  type EngineCapabilityEntry,
} from "@/lib/engine-capabilities";

export interface EngineCalloutProps {
  engineId?: string;
  driverKind?: string;
  className?: string;
}

export function EngineCallout(props: EngineCalloutProps): React.ReactElement | null {
  const id = props.engineId ?? engineIdFromDriverKind(props.driverKind);
  if (!id) return null;
  const entry = engineCapability(id);
  return <EngineCalloutBody entry={entry} className={props.className} />;
}

/** Header chip used by `<EngineCapabilitiesMatrix>` — exposes the same
 *  pricing-mode label the callout uses, so the two stay in sync. */
export function PricingModeChip(props: { entry: EngineCapabilityEntry }): React.ReactElement {
  const { entry } = props;
  return (
    <span
      className="rounded-full bg-inset/60 px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary"
      title={entry.pricing.kind === "subscription+api"
        ? `${entry.pricing.subscription.tierLabel}${typeof entry.pricing.subscription.costPerMonth === "number" ? ` · $${entry.pricing.subscription.costPerMonth.toFixed(2)}/mo` : " · bundled"}; API ${entry.pricing.api.inputPer1k}/1k in`
        : undefined}
    >
      {pricingModeLabel(entry.pricing)}
    </span>
  );
}