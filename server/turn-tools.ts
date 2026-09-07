// Static tool catalog for HTTP drivers (MiniMax, OpenAI-compatible).
//
// CLI drivers (Claude, Codex, DSH, Droid, Pi) spawn MCP servers and
// discover tools at runtime — they have the full catalog from each
// running server.  HTTP drivers cannot spawn servers, so the harness
// hands them a hand-curated list of the tool names the model may call,
// in OpenAI function-calling shape.  The model picks from the list and
// emits a `tool_calls` response; the harness (or a follow-up tool
// loop) is responsible for actually executing the call and threading
// the result back in.
//
// Each entry maps an integration key on SendTurnInput.integrations to
// the function definitions the model should see when that integration
// is mounted.  An integration that is NOT mounted does not contribute
// tools.  This is the same gating rule the driver-side capabilities
// use — the model never sees a tool whose server is not in the
// integrations object for this turn.

import type { SendTurnInput } from "./contracts.ts";

export type OpenAITool = {
  name: string;
  description?: string;
  parameters?: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
};

const AGENT_TOOLS: OpenAITool[] = [
  {
    name: "list_bots",
    description: "List every bot in the fleet, optionally filtered by section or capability.",
    parameters: {
      type: "object",
      properties: {
        section: { type: "string", description: "Optional room section to filter by." },
        capability: {
          type: "string",
          description: "Optional capability name, e.g. agentsMcp, computerMcp.",
        },
      },
      required: [],
    },
  },
  {
    name: "ask_bot",
    description: "Delegate a sub-task to another bot.  Returns the peer's reply verbatim.",
    parameters: {
      type: "object",
      properties: {
        bot: { type: "string", description: "The recipient bot's @handle or id." },
        task: { type: "string", description: "The sub-task instructions to send." },
      },
      required: ["bot", "task"],
    },
  },
];

const COMPOSIO_TOOLS: OpenAITool[] = [
  {
    name: "COMPOSIO_SEARCH_TOOLS",
    description: "Find a connected-app tool by what it does (e.g. 'send a gmail').",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "COMPOSIO_GET_TOOL_SCHEMAS",
    description: "Read the JSON Schema for one or more connected-app tools.",
    parameters: {
      type: "object",
      properties: { slugs: { type: "array", items: { type: "string" } } },
      required: ["slugs"],
    },
  },
  {
    name: "COMPOSIO_MULTI_EXECUTE_TOOL",
    description: "Run a connected-app tool with the given arguments.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["slug", "arguments"],
    },
  },
];

const COMPUTER_TOOLS: OpenAITool[] = [
  {
    name: "computer_screenshot",
    description: "Capture the current frame of the granted computer desktop.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "computer_click",
    description: "Click at normalized coordinates on the granted computer desktop.",
    parameters: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string" } },
      required: ["x", "y"],
    },
  },
  {
    name: "computer_type",
    description: "Type the given text into the focused element on the granted computer desktop.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

/** Build the list of OpenAI function-calling definitions for one turn, based
 * on which integrations the harness has mounted.  Returns an empty array
 * when no relevant integration is present. */
export function buildTurnTools(integrations: SendTurnInput["integrations"]): OpenAITool[] {
  if (!integrations) return [];
  const tools: OpenAITool[] = [];
  if (integrations.agents) tools.push(...AGENT_TOOLS);
  if (integrations.composio) tools.push(...COMPOSIO_TOOLS);
  if (integrations.computer || integrations.localComputer || (integrations.computers && integrations.computers.length > 0)) {
    tools.push(...COMPUTER_TOOLS);
  }
  return tools;
}
