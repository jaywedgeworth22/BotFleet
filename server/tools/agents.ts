// The agents tools' one implementation.
//
// `createAgentTools(deps)` takes EVERY dependency explicitly.  That is not
// style: `server/tools/*` must never import `server/index.ts`, because
// `index.ts` imports the tool modules and the cycle that made was how the
// old `tool-executor.ts` ended up with its own private copy of the
// `list_bots` filter — one that offered a bot its own row and hid `busy`.
// With the dependencies injected there is nowhere for a second copy to
// live: the host and the `/api/internal/` endpoints call the same
// functions, and `registry.test.ts` asserts no file here reaches `index.ts`.
//
// Caller identity arrives in `AgentToolCallContext`, which only the turn
// tool host constructs.  The HTTP lane bypasses the loopback + COMMS_TOKEN
// hop the MCP lane uses, so a `fromBotId` in the model's arguments is
// ignored everywhere below — the turn's own identity is the only one that
// reaches an endpoint function.

import type { TurnToolCall, TurnToolOutcome, TurnToolRuntime } from "../contracts.ts";
import { sectionKey } from "../store.ts";

/** The slice of a bot record the agents tools read.  Structural on purpose,
 *  so this module never has to know what a full bot is. */
export interface AgentBot {
  id: string;
  name: string;
  section?: string | null;
  hidden?: boolean;
  busy?: boolean;
  title?: string | null;
  description?: string | null;
  modelSelection: { model: string };
}

/** One row of the peer roster, as both lanes see it. */
export interface AgentPeerRow {
  id: string;
  name: string;
  model: string;
  busy: boolean;
  title?: string;
  description?: string;
}

/** What an `/api/internal/` endpoint body returns.  The same shape the HTTP
 *  response carries, so one function serves the endpoint and the host. */
export interface AgentRequestResult {
  status: number;
  body: Record<string, unknown>;
}

/** THE peer filter.  Same section, not hidden, and never the caller itself,
 *  with each peer's `busy` flag — the two facts that stop a model spending a
 *  round asking itself or a peer that cannot answer.  Returns `null` when
 *  the sender is unknown.
 *
 *  Every lane reaches this through `listAgentsResponse`; there is no second
 *  filter anywhere, which is the point of the PR that introduced it. */
export function selectPeerBots(selfId: string, all: readonly AgentBot[]): AgentPeerRow[] | null {
  const sender = all.find((bot) => bot.id === selfId);
  if (!sender) return null;
  return all
    .filter(
      (bot) =>
        bot.id !== selfId && !bot.hidden && sectionKey(bot.section) === sectionKey(sender.section),
    )
    .map((bot) => ({
      id: bot.id,
      name: bot.name,
      model: bot.modelSelection.model,
      busy: !!bot.busy,
      // title/description so a Chief-of-Staff-style bot can judge the team:
      // who does what, and who has no job description yet.
      title: bot.title || undefined,
      description: bot.description || undefined,
    }));
}

/** The `GET /api/internal/agents` body.  `index.ts` exports a one-line
 *  wrapper that binds this to the live store; the host receives that wrapper
 *  as a dependency, so both lanes run this code and not a copy of it. */
export function listAgentsResponse(selfId: string, all: readonly AgentBot[]): AgentRequestResult {
  const bots = selectPeerBots(selfId, all);
  if (!bots) return { status: 403, body: { error: "unknown sender" } };
  // `section` rides along because the pre-registry `list_bots` payload
  // carried it and in-flight conversations quote it back.  It is the
  // CALLER's own section — every row in `bots` is in it by construction —
  // so restoring it here, not in the tool, keeps the one-implementation
  // rule: the `/api/internal/agents` body and the host see the same field.
  const section = all.find((bot) => bot.id === selfId)?.section ?? "";
  return { status: 200, body: { section, bots } };
}

export interface AskBotRequestInput {
  fromBotId: string;
  toBotId: string;
  message: string;
  depth: number;
  fromThreadId?: string;
}

export interface ListRoutinesRequestInput {
  fromBotId: string;
  fromThreadId?: string;
}

/** Every dependency the agents tools have, named.  Each one is an
 *  `/api/internal/` endpoint body exported from `index.ts`, so the tool a
 *  MiniMax bot runs in-process and the tool a Claude bot runs over the
 *  loopback hop are the same function with the same guards. */
export interface AgentToolDeps {
  executeListAgentsRequest(input: { selfId: string }): AgentRequestResult | Promise<AgentRequestResult>;
  executeAskBotRequest(input: AskBotRequestInput): Promise<AgentRequestResult>;
  executeListRoutinesRequest(
    input: ListRoutinesRequestInput,
  ): AgentRequestResult | Promise<AgentRequestResult>;
}

/** Who is calling.  Constructible only inside the turn tool host: this is
 *  the identity the endpoints trust, and it must never be assembled from a
 *  model's arguments. */
export interface AgentToolCallContext {
  readonly botId: string;
  readonly threadId: string;
  readonly commsDepth: number;
}

export type AgentToolExecutor = (
  call: TurnToolCall,
  ctx: AgentToolCallContext,
  runtime: TurnToolRuntime,
) => Promise<TurnToolOutcome>;

/** The names this module implements.  They are the registry's names, and
 *  `registry.test.ts` is what keeps the two lists in step. */
export type AgentToolName = "list_bots" | "ask_bot" | "list_routines";

/** One executor per name — a named contract rather than an open dictionary,
 *  so adding a tool to the registry without implementing it is a type error
 *  rather than an "unknown tool" string a user discovers at runtime. */
export type AgentTools = Record<AgentToolName, AgentToolExecutor>;

/** The peer roster as the tools read it: the caller's own section plus the
 *  rows in it.  One record so `list_bots` can re-emit `section` without a
 *  second trip to the endpoint. */
interface Roster {
  section: string;
  rows: AgentPeerRow[];
}

const ok = (content: string, detail?: string): TurnToolOutcome =>
  detail ? { kind: "result", content, detail } : { kind: "result", content };

const failed = (content: string, detail?: string): TurnToolOutcome =>
  detail ? { kind: "error", content, detail } : { kind: "error", content };

const errorText = (body: Record<string, unknown>, fallback: string): string =>
  typeof body.error === "string" && body.error ? body.error : fallback;

/** Build the agents tools' executors.  Keyed by the registry name, so the
 *  host can look up exactly what the catalog advertised and nothing else. */
export function createAgentTools(deps: AgentToolDeps): AgentTools {
  async function roster(ctx: AgentToolCallContext): Promise<Roster | string> {
    const result = await deps.executeListAgentsRequest({ selfId: ctx.botId });
    if (result.status !== 200 || !Array.isArray(result.body.bots)) {
      return errorText(result.body, "the peer roster is unavailable");
    }
    // SAFETY: `executeListAgentsRequest` is `listAgentsResponse`, whose only
    // 200 body is `{ section, bots: AgentPeerRow[] }` built by
    // `selectPeerBots`.  The `Array.isArray` guard above rules out the 403
    // shape.
    return {
      section: typeof result.body.section === "string" ? result.body.section : "",
      rows: result.body.bots as AgentPeerRow[],
    };
  }

  return {
    async list_bots(_call, ctx): Promise<TurnToolOutcome> {
      const list = await roster(ctx);
      if (typeof list === "string") {
        return failed(JSON.stringify({ error: list }), list);
      }
      const { section, rows } = list;
      return ok(
        JSON.stringify({ section, bots: rows }),
        rows.length === 1 ? "1 peer" : `${rows.length} peers`,
      );
    },

    async ask_bot(call, ctx): Promise<TurnToolOutcome> {
      // Both spellings: the MCP lane advertises `message`, the HTTP lane
      // advertises `task` (see the declared wire deviation in registry.ts).
      // One body, two advertised names, so neither lane can drift.
      const target = String(call.arguments.bot_id ?? call.arguments.bot ?? "").trim();
      const text = String(call.arguments.message ?? call.arguments.task ?? "").trim();
      if (!target || !text) {
        return failed(
          JSON.stringify({ error: "ask_bot requires both `bot_id` and `task`" }),
          "bad arguments",
        );
      }
      const list = await roster(ctx);
      if (typeof list === "string") return failed(JSON.stringify({ error: list }), list);
      // Resolved against the roster the model was actually shown, so a bot
      // it cannot see is a bot it cannot reach.
      const peer = list.rows.find((row) => row.id === target || `@${row.name}` === target);
      if (!peer) return failed(JSON.stringify({ error: `no bot matches ${target}` }), "no such bot");
      // Every guard that matters — depth cap, section, thread ownership,
      // approvePeerComms, mirroring — lives in executeAskBotRequest, which
      // is why this calls it rather than reimplementing the hop.
      const result = await deps.executeAskBotRequest({
        fromBotId: ctx.botId,
        toBotId: peer.id,
        message: text,
        depth: ctx.commsDepth,
        fromThreadId: ctx.threadId,
      });
      if (result.body.busy) {
        return failed(
          JSON.stringify({ error: "That bot is busy right now — try again after it finishes." }),
          "peer busy",
        );
      }
      if (result.body.error) {
        const message = String(result.body.error);
        return failed(JSON.stringify({ error: message }), message);
      }
      const reply = typeof result.body.text === "string" ? result.body.text : "";
      const name = typeof result.body.botName === "string" ? result.body.botName : peer.name;
      if (!reply) return failed(JSON.stringify({ error: "no reply" }), "no reply");
      return ok(`${name} replied:\n${reply}`, `@${name} replied`);
    },

    async list_routines(_call, ctx): Promise<TurnToolOutcome> {
      const result = await deps.executeListRoutinesRequest({
        fromBotId: ctx.botId,
        fromThreadId: ctx.threadId,
      });
      if (result.status !== 200) {
        const message = errorText(result.body, "routines are unavailable");
        return failed(JSON.stringify({ error: message }), message);
      }
      const routines = Array.isArray(result.body.routines) ? result.body.routines : [];
      return ok(
        JSON.stringify({
          now: result.body.now,
          timeZone: result.body.timeZone,
          routines,
        }),
        routines.length === 1 ? "1 routine" : `${routines.length} routines`,
      );
    },
  };
}
