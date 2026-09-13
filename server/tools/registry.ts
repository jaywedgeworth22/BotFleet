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
  // Starting a peer's turn spends that bot's tokens under its own model and
  // permissions, so it is the one registry tool a person may want to see
  // first.  The verdict itself is NOT decided here: the ask goes through
  // the same fold a CLI engine's does, so this bot's existing auto-approve,
  // always-allow and unattended settings decide it — no per-tool switch.
  approval: {
    policy: "ask",
    summary: (args) => {
      const target = typeof args.bot_id === "string" ? args.bot_id : "another bot";
      const raw = typeof args.task === "string" ? args.task : typeof args.message === "string" ? args.message : "";
      const text = raw.replace(/\s+/g, " ").trim();
      return text ? `ask ${target}: ${text.slice(0, 160)}` : `ask ${target}`;
    },
  },
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

/** Only a chief may build a team, and it is still a peer-comms-shaped
 *  permission — a bot whose depth or driver never mounted the agents
 *  integration must not see it either.  Not the peer-hop ceiling, though:
 *  building a team is not a hop, so `commsDepth` plays no part, the same
 *  reasoning `list_routines` uses for the recursion cap. */
const chiefOnly = (ctx: ToolGateContext) => ctx.agents && ctx.chiefOfStaff;

/** Not a peer hop either, and not chief-gated: any bot with the agents
 *  integration mounted may ask for a credential or manage its own
 *  routines. */
const anyAgentsBot = (ctx: ToolGateContext) => ctx.agents;

const DELEGATE_BOT: HarnessTool = {
  name: "delegate_bot",
  description:
    "Hand a task to another bot ASYNCHRONOUSLY: returns immediately and the peer runs after your current turn finishes. Use this when you want to keep working or hand off a long-running subtask without waiting. The user sees the peer's reply as its own turn; you do NOT receive the reply inline.",
  schema: {
    type: "object",
    properties: {
      bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
      message: { type: "string", description: "What the peer should do / answer." },
      reason: {
        type: "string",
        description: "Optional one-line reason for the delegation (shown to the user as a chip).",
      },
    },
    required: ["bot_id", "message"],
  },
  surfaces: { mcp: true, http: true },
  gate: peerComms,
  sideEffect: "write",
  settles: "immediate",
  promptFragment:
    "Use delegate_bot to hand a task to a peer asynchronously when you do not need its reply inline; the user sees the peer's reply as its own turn.",
  // Starting a peer's turn spends its tokens, same as ask_bot — and unlike
  // ask_bot, this one runs after the current turn ends, so a denied
  // delegation must never have been queued in the first place.
  approval: {
    policy: "ask",
    summary: (args) => {
      const target = typeof args.bot_id === "string" ? args.bot_id : "another bot";
      const raw = typeof args.message === "string" ? args.message : "";
      const text = raw.replace(/\s+/g, " ").trim();
      return text ? `delegate to ${target}: ${text.slice(0, 120)}` : `delegate to ${target}`;
    },
  },
};

const CREATE_BOT: HarnessTool = {
  name: "create_bot",
  description:
    "Create a specialist bot in your section. Only a section's Chief of Staff may use this. The new bot inherits the Chief's engine, starts with connected apps and automatic approvals disabled, and can then receive work through delegate_bot. Create only the smallest useful team (maximum four per turn).",
  schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short, unique display name for the specialist." },
      role: { type: "string", description: "The specialist's job title or role." },
      instructions: {
        type: "string",
        description: "What this specialist is responsible for and how it should work.",
      },
    },
    required: ["name", "role", "instructions"],
  },
  surfaces: { mcp: true, http: true },
  gate: chiefOnly,
  sideEffect: "write",
  settles: "immediate",
  promptFragment:
    "If you are the Chief of Staff, use create_bot to add a specialist to your team (up to four per turn), then delegate_bot to assign it work.",
};

/** Mirrors `CREDENTIAL_TARGETS` in `shared/credential-request.ts`.
 *  Duplicated rather than imported: this file has to stay import-free
 *  (`registry.test.ts` asserts it, because `agents-proxy.ts` loads it inside
 *  a bare child process before the harness exists), so the one place that
 *  needs the real allowlist as DATA cannot reach it.  `registry.test.ts`
 *  also diffs this list against the real one so the two id sets cannot
 *  drift silently. */
export const CREDENTIAL_TARGET_IDS = [
  "xaiApiKey",
  "deepseekApiKey",
  "boxToken",
  "opencodeGoApiKey",
  "ttsKey",
  "openaiImageApiKey",
] as const;

const REQUEST_CREDENTIAL: HarnessTool = {
  name: "request_credential",
  description:
    "Ask the user for a supported API key through BotFleet's secure credential card. Use this instead of asking them to paste a secret into chat. The secret is saved by the desktop app and is never returned to you. After calling this tool, end the turn; BotFleet resumes the task after the user saves or declines.",
  schema: {
    type: "object",
    properties: {
      credential_id: {
        type: "string",
        enum: [...CREDENTIAL_TARGET_IDS],
        description: "The credential the current task requires.",
      },
      reason: {
        type: "string",
        description: "Optional short, non-sensitive explanation of why the task needs it.",
      },
    },
    required: ["credential_id"],
  },
  surfaces: { mcp: true, http: true },
  gate: anyAgentsBot,
  sideEffect: "write",
  settles: "suspend",
  promptFragment:
    "If a supported API key is missing, use request_credential to show the secure in-app card. Never ask the user to paste credentials into chat.",
};

const WEEKDAYS_ENUM = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

// One flat object, deliberately free of oneOf/const/format: several agent
// CLIs flatten or drop JSON-Schema composition keywords when converting MCP
// tools into their provider's function-call format, and a model that never
// saw the branches guesses shapes forever.  The per-type rules live in
// descriptions and are enforced with guiding errors by
// `schedule.ts#normalizeScheduleInput`, which this schema describes but
// (being import-free) cannot reference directly.
const ROUTINE_SCHEDULE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description:
    'Either {"type":"once","at":RFC3339} for one future run, {"type":"weekly","time":"HH:MM","weekdays":[...]} for chosen days, or {"type":"daily","time":"HH:MM"} to run every day. Sub-day intervals (every N minutes/hours) are not supported.',
  properties: {
    type: {
      type: "string",
      enum: ["once", "weekly", "daily"],
      description: "once = a single future run; weekly = chosen weekdays; daily = every day of the week.",
    },
    at: {
      type: "string",
      description:
        "Only for type once: future RFC3339 date-time with an explicit timezone offset, for example 2026-09-01T09:00:00+05:30 or 2026-09-01T03:30:00Z.",
    },
    time: {
      type: "string",
      description: "For type weekly or daily: local computer time in 24-hour HH:MM format, for example 09:00.",
    },
    weekdays: {
      type: "array",
      items: { type: "string", enum: WEEKDAYS_ENUM },
      description: "Only for type weekly: which days the routine runs, in the computer's local timezone.",
    },
  },
  required: ["type"],
} as const;

const ROUTINE_FIELDS_SCHEMA = {
  name: { type: "string", minLength: 1, maxLength: 80, description: "Short name shown in Routines." },
  instructions: {
    type: "string",
    minLength: 1,
    maxLength: 20_000,
    description: "The complete instructions the bot should follow each time the routine runs.",
  },
  schedule: ROUTINE_SCHEDULE_SCHEMA,
  run_on: {
    type: "string",
    enum: ["maus", "cloud"],
    description: "Where the routine runs. Defaults to maus (this BotFleet setup).",
  },
  duration_minutes: {
    type: "integer",
    minimum: 15,
    maximum: 240,
    description: "Maximum run duration in minutes. Defaults to 30.",
  },
} as const;

const PROPOSE_ROUTINE: HarnessTool = {
  name: "propose_routine",
  description:
    "Prepare a new routine after the user explicitly asks to schedule recurring or future work. Call list_routines first for relative dates or times so you use its authoritative current time and timezone. This only creates a durable confirmation card; it does NOT enable the routine. Resolve ambiguous dates, times, timezone, destination, or instructions with the user first, and always give one-time schedules an explicit RFC3339 offset. After calling it, end the turn and do not claim the routine exists until the user confirms the card.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: ROUTINE_FIELDS_SCHEMA,
    required: ["name", "instructions", "schedule"],
  },
  surfaces: { mcp: true, http: true },
  gate: anyAgentsBot,
  sideEffect: "write",
  settles: "suspend",
  promptFragment:
    "If the user explicitly asks to schedule, run, or change routines, use list_routines and propose_routine or propose_routine_action. A proposal is not applied until the user confirms its in-app card, so never claim the action completed before that confirmation.",
};

const PROPOSE_ROUTINE_ACTION: HarnessTool = {
  name: "propose_routine_action",
  description:
    "Prepare a user-requested change to one of this bot's existing routines. This only creates a durable confirmation card; it does NOT apply the change. Use list_routines first to get the routine id. After calling it, end the turn and do not claim the action completed until the user confirms the card.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      routine_id: { type: "string", minLength: 1, description: "Routine id from list_routines." },
      action: {
        type: "string",
        enum: ["update", "pause", "resume", "run_now", "delete"],
        description: "The requested action. Supply changes only for update.",
      },
      changes: {
        type: "object",
        additionalProperties: false,
        properties: ROUTINE_FIELDS_SCHEMA,
        description: "Fields to change when action is update. Omit for every other action.",
      },
    },
    required: ["routine_id", "action"],
  },
  surfaces: { mcp: true, http: true },
  gate: anyAgentsBot,
  sideEffect: "write",
  settles: "suspend",
  promptFragment:
    "Use propose_routine_action (after list_routines) to pause, resume, run now, update, or delete an existing routine. It only shows a confirmation card; the change applies when the user confirms it.",
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
  gate: anyAgentsBot,
  sideEffect: "read",
  settles: "immediate",
  promptFragment:
    "Use list_routines to read this bot's scheduled work, and treat the current time it returns as authoritative for relative dates.",
};

/** The `create_bot` per-turn cap, shared so the two lanes cannot drift on
 *  the number even though they enforce it in two different places:
 *  `agents-proxy.ts` keeps its own per-process counter (it is a bare child
 *  process — it cannot share a JS closure with the harness), and
 *  `agents.ts#createAgentTools` closes over a fresh counter every time it is
 *  built, which is once per HTTP turn.  That is what makes the HTTP lane's
 *  cap turn-scoped rather than process-scoped: a new turn gets a new host,
 *  gets a new call to `createAgentTools`, gets a new counter. */
export const MAX_CREATED_BOTS_PER_TURN = 4;

/** Every tool the registry owns, in the order the MCP lane publishes them —
 *  spelled out here, not derived, so reordering this array is a deliberate
 *  edit rather than something that silently reorders the MCP wire list. */
export const HARNESS_TOOLS: readonly HarnessTool[] = [
  LIST_BOTS,
  ASK_BOT,
  DELEGATE_BOT,
  CREATE_BOT,
  REQUEST_CREDENTIAL,
  LIST_ROUTINES,
  PROPOSE_ROUTINE,
  PROPOSE_ROUTINE_ACTION,
];

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
