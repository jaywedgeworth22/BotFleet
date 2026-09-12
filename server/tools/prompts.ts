// Prompt copy derived from the tool catalog, not restated beside it.
//
// Before this file, the sentences that told a bot it had agents tools were
// hand-written strings duplicated across index.ts's two dispatch paths (a
// 1:1 turn and a room turn), each gated on a boolean (`integrations.agents`)
// rather than on which tools the bot's actual surface offers.  A driver
// whose only tool surface is the harness catalog — no vendor CLI, no MCP
// mount — got the exact same sentences as a CLI bot, even though
// request_credential, propose_routine, propose_routine_action, create_bot
// and delegate_bot are still legacy tools `agents-proxy.ts` splices into the
// MCP lane only (see registry.ts's own comment), ahead of their PR 7
// registry entries.  So a MiniMax bot was told to call tools it did not
// have, and its Chief-of-Staff bots were told they could build a team they
// could not build.
//
// This module is deliberately dependency-light, like registry.ts: it holds
// pure functions over plain data, so every one of them is testable without
// a harness.

import type { HarnessTool } from "./registry.ts";

/** One sentence per tool that declares a `promptFragment`, in catalog
 *  order, each prefixed with a space so a caller can concatenate the
 *  result directly onto a persona string.  A tool with no fragment — and
 *  any tool that is not in `tools` at all — contributes nothing, which is
 *  the whole point: prompt copy can never outlive the catalog it describes. */
export function promptFragmentsFor(tools: readonly HarnessTool[]): string {
  return tools
    .map((tool) => tool.promptFragment)
    .filter((fragment): fragment is string => Boolean(fragment))
    .map((fragment) => ` ${fragment}`)
    .join("");
}

/** The five agents tools `agents-proxy.ts` still defines directly (named in
 *  registry.ts's own comment) — reachable on the MCP lane only, until PR 7
 *  gives them registry entries the HTTP lane can render too. */
export const LEGACY_MCP_AGENT_TOOLS = [
  "create_bot",
  "delegate_bot",
  "request_credential",
  "propose_routine",
  "propose_routine_action",
] as const;

/** Every agents-tool name this bot's turn can actually call this turn: the
 *  registry names for whichever surface it uses, plus the legacy MCP splice
 *  when MCP is that surface.  Empty when the turn has no agents integration
 *  at all.  `registryToolNames` should already be gated (surface + turn
 *  context) by the caller — see `toolsFor` in registry.ts. */
export function availableAgentToolNames(input: {
  hasAgentsIntegration: boolean;
  mcpSurface: boolean;
  registryToolNames: readonly string[];
}): string[] {
  if (!input.hasAgentsIntegration) return [];
  return input.mcpSurface
    ? [...input.registryToolNames, ...LEGACY_MCP_AGENT_TOOLS]
    : [...input.registryToolNames];
}

/** The secure-credential-card sentence — only when this turn's tool set
 *  actually includes `request_credential`.  Shared by the 1:1 and room
 *  dispatch paths so a fix here fixes both. */
export function credentialPromptFor(availableAgentTools: readonly string[]): string {
  return availableAgentTools.includes("request_credential")
    ? " If a supported API key is missing, use request_credential to show the secure in-app card. Never ask the user to paste credentials into chat."
    : "";
}

/** The routines sentence.  Full wording (list + propose) when the
 *  confirmation-card tools are present; a shorter, still-true sentence when
 *  only the read-only `list_routines` is (today's MiniMax bot); nothing
 *  when neither is.  Shared by the 1:1 and room dispatch paths. */
export function routinePromptFor(availableAgentTools: readonly string[]): string {
  if (availableAgentTools.includes("propose_routine")) {
    return " If the user explicitly asks to list or review, schedule, run, or change routines, use list_routines and propose_routine or propose_routine_action. A proposal is not applied until the user confirms its in-app card, so never claim the action completed before that confirmation.";
  }
  if (availableAgentTools.includes("list_routines")) {
    return " If the user explicitly asks to list or review scheduled routines, use list_routines.";
  }
  return "";
}

/** True when this bot's turn has file-editing tools at all.  A CLI or ACP
 *  driver gets file/shell tools from its vendor CLI; a driver whose
 *  `capabilities.toolLoop` is set has the harness catalog as its ONLY tool
 *  surface, which today is peer comms and routines — no file access to
 *  claim.  `worksInWorkspace` still gates whether a workspace directory
 *  exists for this bot at all (unchanged, and still what decides `cwd` and
 *  checkpointing); this narrows it further so a toolLoop driver, which gets
 *  a workspace for `cwd` bookkeeping alone, is not also told it can read
 *  and write files there. */
export function hasFileTools(worksInWorkspace: boolean, toolLoopDriver: boolean): boolean {
  return worksInWorkspace && !toolLoopDriver;
}
