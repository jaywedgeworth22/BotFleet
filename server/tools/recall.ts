// Fleet-recall (Bot RAG) tools for the HTTP driver lane.
//
// Same business logic the CLI-lane MCP proxy runs (server/drivers/
// qdrant-proxy.ts, via server/recall-tools.ts) — called as a plain function
// here instead of over a spawned stdio JSON-RPC pipe, the same shift
// BASH/READ_FILE/WRITE_FILE/EDIT_FILE already made for host-computer tools.
// This module stays free of any `server/index.ts` dependency; the caller
// hands in the resolved settings.

import type { RecallSettings } from "../recall-transport.ts";
import { recallContributeWith, recallSearchWith, recallStatsWith } from "../recall-tools.ts";
import type { ComputerToolExecutor } from "./computer.ts";

export interface RecallToolsOptions {
  settings: RecallSettings;
  /** Default `seat` for recall_contribute when the model omits one. */
  defaultSeat: string;
}

export function createRecallTools(options: RecallToolsOptions): Record<string, ComputerToolExecutor> {
  const recallSearch: ComputerToolExecutor = async (call) => {
    const content = await recallSearchWith(options.settings, call.arguments);
    return { kind: "result", content };
  };

  const recallContribute: ComputerToolExecutor = async (call) => {
    const content = await recallContributeWith(options.settings, options.defaultSeat, call.arguments);
    return { kind: "result", content };
  };

  const recallStats: ComputerToolExecutor = async () => {
    const content = await recallStatsWith(options.settings);
    return { kind: "result", content };
  };

  return {
    recall_search: recallSearch,
    recall_contribute: recallContribute,
    recall_stats: recallStats,
  };
}
