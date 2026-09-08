// The harness's tool executor for one driver-owned turn.
//
// A driver that declares `capabilities.toolLoop` runs its own model-to-tool
// rounds and asks this host to actually run each call.  The host is where
// caller identity lives: `botId` and `threadId` are baked into the closure
// at dispatch, never read from the model's arguments, because this lane
// bypasses the loopback + COMMS_TOKEN hop the MCP lane uses and there is no
// second place to check who is asking.
//
// Scope today is the two tools the HTTP lane already offered — `list_bots`
// and `ask_bot` — with their bodies moved off `runHttpLaneTool` so the
// driver-owned loop and the old executor cannot drift.  The registry that
// serves all eight tools, and the permission broker behind the write ones,
// arrive in later PRs; `requestApproval` resolves `"unavailable"` until then,
// which the loop treats as a deny.
//
// `execute` never throws.  Every failure comes back as `{ kind: "error" }`
// with a string the MODEL reads, so a broken tool is one more thing the
// agent can reason about rather than a dead turn.

import type { TurnToolCall, TurnToolHost, TurnToolOutcome } from "../contracts.ts";
import { sectionKey } from "../store.ts";

/** The slice of a bot record the two tools read.  Structural on purpose:
 *  the host takes its dependencies explicitly so `server/tools/*` never
 *  imports `index.ts`, which is what made the old executor a cycle. */
export interface TurnToolBot {
  id: string;
  name: string;
  section?: string | null;
  hidden?: boolean;
  busy?: boolean;
  title?: string | null;
  description?: string | null;
  modelSelection: { model: string };
}

export interface TurnToolHostDeps {
  bot(id: string): TurnToolBot | null | undefined;
  bots(): TurnToolBot[];
  executeAskBotRequest(input: {
    fromBotId: string;
    toBotId: string;
    message: string;
    depth: number;
    fromThreadId?: string;
  }): Promise<{ status: number; body: Record<string, unknown> }>;
}

export interface TurnToolHostContext {
  /** The bot whose turn this is.  Never taken from tool arguments. */
  botId: string;
  /** The thread the turn is running on — `executeAskBotRequest` checks that
   *  it belongs to the caller before it will start a peer turn. */
  threadId: string;
  /** How many peer hops deep this turn already is. */
  commsDepth: number;
  deps: TurnToolHostDeps;
  /** Ceiling on model-to-tool rounds; absent = the driver's default. */
  maxRounds?: number;
}

const ok = (content: string, detail?: string): TurnToolOutcome =>
  detail ? { kind: "result", content, detail } : { kind: "result", content };

const failed = (content: string, detail?: string): TurnToolOutcome =>
  detail ? { kind: "error", content, detail } : { kind: "error", content };

/** Peers this bot can message: same section, not hidden, and NOT the caller
 *  itself — with each peer's `busy` flag.  Byte-for-byte the same filter the
 *  `/api/internal/agents` endpoint applies for the MCP lane, so a MiniMax bot
 *  and a Claude bot are told the same thing.  The old HTTP executor offered
 *  the caller its own row and hid `busy`, which cost a wasted round every
 *  time the model asked itself or a busy peer for something. */
function listBots(ctx: TurnToolHostContext): TurnToolOutcome {
  const self = ctx.deps.bot(ctx.botId);
  if (!self) return failed("(no current bot — list_bots needs a turn context)", "unknown caller");
  const peers = ctx.deps
    .bots()
    .filter(
      (peer) =>
        peer.id !== self.id && !peer.hidden && sectionKey(peer.section) === sectionKey(self.section),
    )
    .map((peer) => ({
      id: peer.id,
      name: peer.name,
      model: peer.modelSelection.model,
      busy: !!peer.busy,
      title: peer.title || undefined,
      description: peer.description || undefined,
    }));
  return ok(
    JSON.stringify({ section: self.section ?? "", bots: peers }),
    peers.length === 1 ? "1 peer" : `${peers.length} peers`,
  );
}

async function askBot(call: TurnToolCall, ctx: TurnToolHostContext): Promise<TurnToolOutcome> {
  const target = String(call.arguments.bot_id ?? call.arguments.bot ?? "").trim();
  const task = String(call.arguments.task ?? call.arguments.message ?? "").trim();
  if (!target || !task) {
    return failed(JSON.stringify({ error: "ask_bot requires both `bot_id` and `task`" }), "bad arguments");
  }
  const peer = ctx.deps.bots().find((b) => b.id === target || `@${b.name}` === target);
  if (!peer) return failed(JSON.stringify({ error: `no bot matches ${target}` }), "no such bot");
  // Every guard the MCP lane gets — depth cap, section, thread ownership,
  // approvePeerComms, mirroring — lives in executeAskBotRequest, which is
  // why the host calls it rather than reimplementing the hop.
  const result = await ctx.deps.executeAskBotRequest({
    fromBotId: ctx.botId,
    toBotId: peer.id,
    message: task,
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
    return failed(JSON.stringify({ error: String(result.body.error) }), String(result.body.error));
  }
  const text = typeof result.body.text === "string" ? result.body.text : "";
  const name = typeof result.body.botName === "string" ? result.body.botName : peer.name;
  if (!text) return failed(JSON.stringify({ error: "no reply" }), "no reply");
  return ok(`${name} replied:\n${text}`, `@${name} replied`);
}

/** Build the tool host for ONE turn.  The returned host closes over the
 *  caller's identity, so nothing downstream can forge it. */
export function createTurnToolHost(ctx: TurnToolHostContext): TurnToolHost {
  return {
    maxRounds: ctx.maxRounds,
    async execute(call: TurnToolCall): Promise<TurnToolOutcome> {
      try {
        if (call.name === "list_bots") return listBots(ctx);
        if (call.name === "ask_bot") return await askBot(call, ctx);
        return failed(
          `Tool ${call.name} is not available to this bot.  Call only the tools you were given.`,
          "unknown tool",
        );
      } catch (e) {
        // The contract says a host never throws.  This is where that
        // promise is kept, so the driver's loop has one shape to handle.
        const message = e instanceof Error ? e.message : String(e);
        return failed(JSON.stringify({ error: message }), message);
      }
    },
  };
}
