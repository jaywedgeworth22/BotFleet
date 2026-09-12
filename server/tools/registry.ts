// The harness's one tool registry.
//
// Before this file a tool existed three times: once as an MCP `inputSchema`
// in `drivers/agents-proxy.ts`, once as a chat-completions `parameters`
// block in `turn-tools.ts`, and once as an endpoint body in `index.ts`.
// Nothing held the three together, so they drifted — `list_bots` offered a
// bot its own row on one lane and not the other, and hid `busy` on one lane
// and not the other, within a single PR.  A record here is the single
// description of a tool, and each lane RENDERS it rather than restating it.
//
// This module is deliberately dependency-free: it imports nothing from
// `server/index.ts` and nothing that reaches it.  `agents-proxy.ts` is
// spawned as a separate process inside a bot's agent, so anything it can
// see has to be importable without starting a harness.  `registry.test.ts`
// asserts the ban rather than trusting it.
//
// A record carries:
//   - `schema`      the ONE JSON Schema for the tool's arguments
//   - `surfaces`    which lanes may offer it (MCP, HTTP, or both)
//   - `gate`        a pure predicate over one turn's context
//   - `sideEffect`  "read" or "write" — what a permission broker needs
//   - `settles`     whether the tool returns inline or ends the turn on a card
//   - `promptFragment`  the sentence the system prompt may use for it, so
//                   prompt copy cannot outlive the tool (consumed in PR 5)
//   - `approval`    optional ask policy (consumed when the broker lands)

/** A JSON Schema object, in the subset both lanes accept.  No `oneOf` /
 *  `anyOf` / `allOf` / `const`: several agent CLIs flatten or drop
 *  composition keywords when converting an MCP tool into their provider's
 *  function-call format, and a model that never saw the branches guesses
 *  shapes forever. */
export interface JsonSchemaObject {
  type: "object";
  additionalProperties?: boolean;
  description?: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

/** The two lanes a tool can be offered on.  "mcp" is a CLI engine reaching
 *  the harness through `agents-proxy` over the loopback + COMMS_TOKEN hop;
 *  "http" is a chat-completions driver whose loop calls the turn tool host
 *  in-process. */
export type ToolSurface = "mcp" | "http";

/** What running the tool does to the world.  A read tool can never need an
 *  approval card; a write tool is the reason the broker exists. */
export type ToolSideEffect = "read" | "write";

/** How the tool finishes.  "immediate" feeds a result back to the model and
 *  the loop continues; "suspend" put a card in front of a person, so the
 *  turn has to end and the existing resume drain dispatches a fresh one. */
export type ToolSettles = "immediate" | "suspend";

/** Everything the gate predicates are allowed to see.  Pure data, so a gate
 *  can be evaluated in a test without a harness. */
export interface ToolGateContext {
  /** The bot's peer-comms integration is mounted for this turn. */
  agents: boolean;
  /** How many peer hops deep this turn already is. */
  commsDepth: number;
  /** The harness's recursion ceiling (`MAX_COMMS_DEPTH`). */
  maxCommsDepth: number;
  /** This bot is its section's Chief of Staff. */
  chiefOfStaff: boolean;
}

/** How a tool asks a person before it runs.  Consumed by the permission
 *  broker; recorded here so the policy lives beside the tool rather than in
 *  a switch somewhere downstream. */
export interface ToolApproval {
  policy: "never" | "ask";
  /** One line for the card, built from the model's arguments. */
  summary(args: Record<string, unknown>): string;
}

/** A wire shape one lane is pinned to and the other is not.
 *
 *  Every deviation is a debt, so it has to be declared here with a reason
 *  rather than appearing as two hand-written definitions.  `registry.test.ts`
 *  asserts that a lane's rendered schema is the canonical one unless the
 *  record declares a deviation, which is what makes silent drift impossible. */
export interface ToolWireDeviation {
  /** Why the lanes cannot share one shape yet.  Required. */
  reason: string;
  description?: string;
  schema?: JsonSchemaObject;
}

export interface HarnessTool {
  name: string;
  /** The canonical description.  A lane renders this unless it declares a
   *  deviation. */
  description: string;
  /** The canonical argument schema.  Same rule. */
  schema: JsonSchemaObject;
  surfaces: Record<ToolSurface, boolean>;
  gate(ctx: ToolGateContext): boolean;
  sideEffect: ToolSideEffect;
  settles: ToolSettles;
  /** The sentence the system prompt may use to introduce this tool.  It is a
   *  FIELD ON THE TOOL so prompt copy cannot outlive the tool it describes. */
  promptFragment?: string;
  approval?: ToolApproval;
  wire?: Partial<Record<ToolSurface, ToolWireDeviation>>;
}

/** What `agents-proxy` publishes on `tools/list`. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

/** What an HTTP driver puts in `SendTurnInput.tools`; the drivers translate
 *  it into OpenAI function-calling format at call time. */
export interface HttpToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

const peerComms = (ctx: ToolGateContext) => ctx.agents && ctx.commsDepth < ctx.maxCommsDepth;

const LIST_BOTS: HarnessTool = {
  name: "list_bots",
  // Pinned by the MCP golden test: this is the string shipped CLI engines
  // already see.  The HTTP lane used to say something different and less
  // true (it did not mention `busy`, which it now reports).
  description:
    "List the other bots (agents) in your BotFleet section you can message, with their model and whether they're busy. Call this before ask_bot to discover who's available.",
  schema: { type: "object", properties: {} },
  surfaces: { mcp: true, http: true },
  gate: peerComms,
  sideEffect: "read",
  settles: "immediate",
  promptFragment:
    "Use list_bots to see the other bots in your section, with their model and whether they are busy.",
};

const ASK_BOT: HarnessTool = {
  name: "ask_bot",
  description:
    "Send a message to another bot in your section and wait for its reply. Use it to delegate a subtask to a specialist bot or ask a peer a question. The other bot runs a full turn under its own model and permissions; the reply is returned to you as text. Returns promptly with a note if that bot is busy.",
  schema: {
    type: "object",
    properties: {
      bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
      message: { type: "string", description: "What to say / ask the bot." },
    },
    required: ["bot_id", "message"],
  },
  surfaces: { mcp: true, http: true },
  gate: peerComms,
  sideEffect: "write",
  settles: "immediate",
  promptFragment:
    "Use ask_bot to send a peer a task and wait for its reply; pass the bot's id or @name from list_bots.",
  wire: {
    http: {
      reason:
        "The HTTP lane shipped this argument as `task`, and renaming it on the wire would break in-flight MiniMax and OpenRouter turns whose transcripts already contain the old spelling.  The executor accepts both names, so the two lanes run one body; only the advertised name differs.",
      description:
        "Send a message to another bot in your section and wait for its reply.  The other bot runs a full turn under its own model and permissions; the reply is returned to you as text.  Pass either the bot's id or `@name` from list_bots.",
      schema: {
        type: "object",
        properties: {
          bot_id: { type: "string", description: "The target bot's id (from list_bots) or `@name`." },
          task: { type: "string", description: "What to say / ask the bot." },
        },
        required: ["bot_id", "task"],
      },
    },
  },
};

const LIST_ROUTINES: HarnessTool = {
  name: "list_routines",
  description:
    "List routines owned by this bot, including their ids, schedules, status, and next run. The result includes the computer's authoritative current time and timezone; use those when interpreting relative dates. Only call this when the user asks about routines or wants to change one.",
  schema: { type: "object", additionalProperties: false, properties: {} },
  surfaces: { mcp: true, http: true },
  // Not a peer hop, so the recursion ceiling does not apply: a bot four
  // hops deep can still be asked what it has scheduled.  It rides the
  // agents integration because that is the surface the tools are mounted on.
  gate: (ctx) => ctx.agents,
  sideEffect: "read",
  settles: "immediate",
  promptFragment:
    "Use list_routines to read this bot's scheduled work, and treat the current time it returns as authoritative for relative dates.",
};

/** Every tool the registry owns, in the order the MCP lane publishes them.
 *  The five write tools still defined inside `agents-proxy.ts` join this
 *  list in a later PR; until then the proxy splices them in by name. */
export const HARNESS_TOOLS: readonly HarnessTool[] = [LIST_BOTS, ASK_BOT, LIST_ROUTINES];

const BY_NAME = new Map(HARNESS_TOOLS.map((tool) => [tool.name, tool]));

export function harnessTool(name: string): HarnessTool | undefined {
  return BY_NAME.get(name);
}

/** The tools this surface may offer for this turn.  One predicate, two
 *  lanes — which is the whole point. */
export function toolsFor(surface: ToolSurface, ctx: ToolGateContext): HarnessTool[] {
  return HARNESS_TOOLS.filter((tool) => tool.surfaces[surface] && tool.gate(ctx));
}

/** The description this lane advertises: the canonical one unless the
 *  record declares a deviation. */
export function descriptionFor(tool: HarnessTool, surface: ToolSurface): string {
  return tool.wire?.[surface]?.description ?? tool.description;
}

/** The argument schema this lane advertises.  Same rule. */
export function schemaFor(tool: HarnessTool, surface: ToolSurface): JsonSchemaObject {
  return tool.wire?.[surface]?.schema ?? tool.schema;
}

export function mcpToolDefinitions(ctx: ToolGateContext): McpToolDefinition[] {
  return toolsFor("mcp", ctx).map((tool) => ({
    name: tool.name,
    description: descriptionFor(tool, "mcp"),
    inputSchema: schemaFor(tool, "mcp"),
  }));
}

export function httpToolDefinitions(ctx: ToolGateContext): HttpToolDefinition[] {
  return toolsFor("http", ctx).map((tool) => ({
    name: tool.name,
    description: descriptionFor(tool, "http"),
    parameters: schemaFor(tool, "http"),
  }));
}
