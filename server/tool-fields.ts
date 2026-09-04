// The two extra fields every driver puts on `item.started`.
//
// `shared/tool-activity.ts` holds the vocabulary because the client needs the
// same table; this is the Node-side convenience that fills in the home
// directory and hands back exactly the shape the event wants, so a driver
// spreads one call instead of repeating the same three lines nine times.
import { homedir } from "node:os";

import { toolActivity } from "../shared/tool-activity.ts";
import type { ToolKind } from "../shared/tool-activity.ts";

export interface ToolFields {
  target?: string;
  toolKind?: ToolKind;
}

/** `target` + `toolKind` for a tool step, from whatever payload the engine
 * reported.  `hint` is the engine's own kind when it has one (ACP does) — it
 * beats guessing from the name. */
export function toolFields(
  name: string | undefined,
  rawInput: unknown,
  options: { hint?: string; locations?: unknown } = {},
): ToolFields {
  const activity = toolActivity(name, {
    hint: options.hint,
    rawInput,
    locations: options.locations,
    home: homedir(),
  });
  return { target: activity.target, toolKind: activity.kind };
}
