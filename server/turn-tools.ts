// Static tool catalog for HTTP drivers (MiniMax, OpenAI-compatible).
//
// CLI drivers (Claude, Codex, DSH, Droid, Pi, ACP engines) mount MCP
// servers at turn time and discover tools at runtime, so they do not
// need a static catalog.  HTTP drivers cannot, so the harness hands the
// model a tool list on the wire and lends the driver a `TurnToolHost`
// for the turn; the driver runs its own model-to-tool rounds against it
// (server/drivers/chat-completions/loop.ts).
//
// The catalog intentionally exposes only the agents tools the host can
// actually run today.  Telling the model about a tool with no
// implementation behind it just invites wasted rounds, so this list and
// the host are derived from the same call at dispatch.
//
// The shape matches `SendTurnInput.tools` in `./contracts.ts`; the
// drivers translate it into OpenAI function-calling format at call
// time, so the JSON Schema here is what the model sees.

import type { SendTurnInput } from "./contracts.ts";

type ToolDefinition = NonNullable<SendTurnInput["tools"]>[number];

const LIST_BOTS: ToolDefinition = {
  name: "list_bots",
  description:
    "List the other bots in your BotFleet section you can message, with their model.  Call this before ask_bot to discover who's available; the result is filtered to your own section and excludes hidden bots.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
};

const ASK_BOT: ToolDefinition = {
  name: "ask_bot",
  description:
    "Send a message to another bot in your section and wait for its reply.  The other bot runs a full turn under its own model and permissions; the reply is returned to you as text.  Pass either the bot's id or `@name` from list_bots.",
  parameters: {
    type: "object",
    properties: {
      bot_id: {
        type: "string",
        description: "The target bot's id (from list_bots) or `@name`.",
      },
      task: {
        type: "string",
        description: "What to say / ask the bot.",
      },
    },
    required: ["bot_id", "task"],
  },
};

const AGENT_TOOLS: ToolDefinition[] = [LIST_BOTS, ASK_BOT];

/** Build the tool catalog for an HTTP-driver turn.  Returns an empty
 * array when no integration surfaces are enabled, so the driver hands
 * the model a plain chat request and the executor is a no-op. */
export function buildTurnTools(integrations: {
  agents?: unknown;
}): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  // Agents tools (peer comms within a section).  The dispatch gates the
  // `integrations.agents` object on `commsDepth < MAX_COMMS_DEPTH` and
  // the driver's `agentsMcp` capability; if either is false the object
  // is missing here and the model cannot call ask_bot.
  if (integrations.agents) {
    out.push(...AGENT_TOOLS);
  }
  return out;
}
