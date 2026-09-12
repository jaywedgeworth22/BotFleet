// The harness's tool executor for one driver-owned turn.
//
// A driver that declares `capabilities.toolLoop` runs its own model-to-tool
// rounds and asks this host to actually run each call.  The host is where
// caller identity lives: `botId` and `threadId` are baked into the closure
// at dispatch, never read from the model's arguments, because this lane
// bypasses the loopback + COMMS_TOKEN hop the MCP lane uses and there is no
// second place to check who is asking.  `AgentToolCallContext` is therefore
// constructible ONLY here — nothing else in the process assembles one.
//
// The host owns no tool bodies.  `server/tools/registry.ts` says which tools
// exist and what they look like on each lane; `server/tools/agents.ts` says
// what they do, with every dependency passed in.  This file is the join:
// gate the catalog, look the call up in it, ASK IF THE RECORD SAYS TO, and
// run it with the turn's identity.
//
// That ask is the one policy decision here, and it is deliberately thin: the
// host reads `approval` off the registry record and hands the question to
// the broker.  It does not decide the answer — auto mode, always-allow, the
// guards and the unattended block all live in the same fold a CLI engine's
// request reaches.  A tool with no `approval` record never asks at all.
//
// `execute` never throws.  Every failure comes back as `{ kind: "error" }`
// with a string the MODEL reads, so a broken tool is one more thing the
// agent can reason about rather than a dead turn.

import type {
  RequestOutcome,
  TurnToolCall,
  TurnToolHost,
  TurnToolOutcome,
  TurnToolRuntime,
} from "../contracts.ts";
import {
  createAgentTools,
  type AgentToolCallContext,
  type AgentToolDeps,
  type AgentToolExecutor,
} from "./agents.ts";
import { harnessTool, toolsFor, type ToolGateContext } from "./registry.ts";

export type { AgentBot as TurnToolBot } from "./agents.ts";

/** The host's dependencies are exactly the agents tools' dependencies: the
 *  `/api/internal/` endpoint bodies `index.ts` exports.  Nothing here
 *  imports `index.ts`, which is what keeps the cycle broken. */
export type TurnToolHostDeps = AgentToolDeps;

export interface TurnToolHostContext {
  /** The bot whose turn this is.  Never taken from tool arguments. */
  botId: string;
  /** The thread the turn is running on — the endpoint bodies check that it
   *  belongs to the caller before they will start a peer turn or read
   *  routines. */
  threadId: string;
  /** How many peer hops deep this turn already is. */
  commsDepth: number;
  /** This bot is its section's Chief of Staff.  No tool gates on it yet;
   *  the write tools that do arrive in a later PR. */
  chiefOfStaff?: boolean;
  deps: TurnToolHostDeps;
  /** Ceiling on model-to-tool rounds; absent = the driver's default. */
  maxRounds?: number;
  /** The harness's permission broker, already bound to this turn's bot and
   *  thread.  Absent = no broker mounted, and an ask-policy tool is refused
   *  rather than run — fail-closed, because "nobody could be asked" must
   *  never read as "nobody objected". */
  requestApproval?: TurnToolHost["requestApproval"];
}

const failed = (content: string, detail?: string): TurnToolOutcome =>
  detail ? { kind: "error", content, detail } : { kind: "error", content };

/** Build the tool host for ONE turn.  The returned host closes over the
 *  caller's identity, so nothing downstream can forge it. */
export function createTurnToolHost(ctx: TurnToolHostContext): TurnToolHost {
  // A Map, not the record itself: `call.name` is whatever the model said.
  const executors = new Map<string, AgentToolExecutor>(Object.entries(createAgentTools(ctx.deps)));
  const gate: ToolGateContext = {
    // The dispatch only builds a host when the agents integration is
    // mounted, so reaching this file at all means the surface is on — and
    // it mounted that integration only after checking `commsDepth` against
    // `MAX_COMMS_DEPTH`.  Re-applying the ceiling here would subtract it
    // twice and silently strip tools the model was just offered, so the
    // gate below is the SAME one `buildTurnTools` used for the catalog.
    // What it still catches is a name the catalog never contained.
    agents: true,
    commsDepth: 0,
    maxCommsDepth: Number.POSITIVE_INFINITY,
    chiefOfStaff: ctx.chiefOfStaff ?? false,
  };
  // The same gate the catalog handed the model.  A hallucinated name, or a
  // real name the model was not offered this turn, finds no executor.
  const available = new Set(toolsFor("http", gate).map((tool) => tool.name));
  const identity: AgentToolCallContext = {
    botId: ctx.botId,
    threadId: ctx.threadId,
    commsDepth: ctx.commsDepth,
  };

  return {
    maxRounds: ctx.maxRounds,
    requestApproval: ctx.requestApproval,
    async execute(call: TurnToolCall, runtime: TurnToolRuntime): Promise<TurnToolOutcome> {
      try {
        const executor = available.has(call.name) ? executors.get(call.name) : undefined;
        if (!executor) {
          return failed(
            `Tool ${call.name} is not available to this bot.  Call only the tools you were given.`,
            "unknown tool",
          );
        }
        // Ask BEFORE the executor runs, never after: an approval that
        // arrives once the side effect has happened is a receipt, not a
        // decision.  A tool with no `approval` record never asks at all —
        // which is every read tool, and the reason `list_bots` does not
        // put a card in front of anyone.
        const approval = harnessTool(call.name)?.approval;
        if (approval?.policy === "ask") {
          let summary: string;
          try {
            summary = approval.summary(call.arguments);
          } catch {
            // A summary a person cannot read is not a card worth showing,
            // but running the tool unasked is worse.  Name the tool and ask.
            summary = call.name;
          }
          const verdict: RequestOutcome = await runtime.requestApproval({ tool: call.name, summary });
          if (verdict !== "allowed-once") {
            // A refusal the MODEL reads, so the turn continues and the
            // agent can say what it was stopped from doing.  `unavailable`
            // is a deny: nobody could be asked, so nothing was granted.
            return failed(
              verdict === "unavailable"
                ? `Tool ${call.name} was not run: nobody was available to approve it.  Tell the user what you wanted to do and ask them to run it.`
                : `Tool ${call.name} was not approved.  Do not retry it — tell the user what you wanted to do and why.`,
              verdict === "unavailable" ? "approval unavailable" : "denied",
            );
          }
        }
        return await executor(call, identity, runtime);
      } catch (e) {
        // The contract says a host never throws.  This is where that
        // promise is kept, so the driver's loop has one shape to handle.
        const message = e instanceof Error ? e.message : String(e);
        return failed(JSON.stringify({ error: message }), message);
      }
    },
  };
}
