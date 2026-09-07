// HTTP-driver tool executor: closes the loop the CLI drivers handle natively.
//
// CLI drivers (Claude, Codex, DSH, Droid, Pi) spawn MCP servers at turn
// time and call the model's tool requests directly.  HTTP drivers (MiniMax,
// OpenAI-compatible) get the same tool list on the wire but the model
// call returns, and the harness has to make the call itself and re-feed
// the result.  This module is that re-feed loop.
//
// It listens on the bus for events on a single thread, captures the
// tool calls the driver emitted, runs them through `runHttpLaneTool`, and
// re-invokes sendTurn with the results appended to the transcript.  The
// loop is bounded by a hard cap on rounds so a runaway model cannot
// burn turns.
//
// Scope of the executor: only the agents tools (list_bots, ask_bot) are
// implemented today.  Computer-use and Composio tools still return
// "not implemented" — they need an MCP-spawning path on the HTTP lane
// that this lane cannot host.  The model sees the result string in the
// next turn and stops calling the missing tool.
//
// The driver only emits `item.started` for a tool call once — the
// streaming start, with the partial argument string.  The OpenAI-
// compatible driver passes the per-chunk args on that event; the
// executor holds the latest string it has seen for the call's id, so a
// re-invocation that fires while the stream is still emitting would
// naturally pick up the latest fragment.  In practice the second event
// is suppressed by the driver's `started` set, so the executor
// captures the partial string and feeds it through `parseToolArguments`,
// which returns `{}` on malformed JSON (the model then re-tries on the
// next turn with the corrected call).

import type {
  ProviderInstance,
  RuntimeEvent,
  SendTurnInput,
} from "./contracts.ts";
import { askBotAndWait, bus, store } from "./index.ts";

export type HttpLaneToolCall = {
  id: string;
  name: string;
  /** Decoded arguments the model passed to the tool.  Always an object —
   *  JSON-shape tools are how every entry on the catalog is declared. */
  arguments: Record<string, unknown>;
};

export type HttpLaneToolResult = {
  id: string;
  result: string;
};

const MAX_TOOL_ROUNDS = 5;
const TOOL_TIMEOUT_MS = 60_000;

/** A single turn's events.  The caller hands a `bus.subscribe` closure
 *  that records into this shape; the helper reads the same fields after
 *  turn.completed fires. */
interface CapturedTurn {
  toolCalls: HttpLaneToolCall[];
  /** True if the driver emitted a `turn.completed` with `ok: true`. */
  ok: boolean;
  /** `stopReason` from `turn.completed`.  `"tool_calls: foo, bar"` means the
   *  executor should run the named tools and re-invoke sendTurn.  Any
   *  other value (or absent) means the turn is settled and the executor
   *  exits the loop. */
  stopReason: string | null;
  /** Combined assistant text emitted this turn, so the caller can keep
   *  the transcript coherent across multiple executor rounds. */
  assistantText: string;
}

/** Subscribe to the bus for events on one thread, call sendTurn, and
 * resolve with the captured tool calls and assistant text.  Always
 * unsubscribes before resolving. */
async function runOneTurn(
  instance: ProviderInstance,
  input: SendTurnInput,
): Promise<CapturedTurn> {
  const captured: CapturedTurn = {
    toolCalls: [],
    ok: false,
    stopReason: null,
    assistantText: "",
  };
  // Map a tool call id to its full state.  The driver emits `item.started`
  // with the partial-args string; we keep the latest string we've seen for
  // the call so a re-emission (or a later fragment on the same id, if the
  // driver ever sends one) lands on the same entry.  The settled
  // `item.completed` is the only place we get a final "ok" signal; we
  // push a frozen copy into `captured.toolCalls` there.
  const partialById = new Map<string, HttpLaneToolCall>();

  const completed = new Promise<CapturedTurn>((resolve) => {
    let settled = false;
    const finish = (result: CapturedTurn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve(result);
    };
    const fail = (_err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      resolve({ ...captured, ok: false, stopReason: "error" });
    };
    const timer = setTimeout(
      () => finish({ ...captured, stopReason: "timeout" }),
      TOOL_TIMEOUT_MS,
    );
    const unsub = bus.subscribe((event: RuntimeEvent) => {
      if (event.threadId !== input.threadId) return;
      switch (event.type) {
        case "item.started": {
          if (event.itemType !== "tool" || !event.itemId || !event.title) break;
          // First or later emission for the same id: keep the latest
          // name and arguments.  The streaming path only sends the
          // partial string, but if a settled re-emit does fire, prefer
          // its full argument string over the partial.
          partialById.set(event.itemId, {
            id: event.itemId,
            name: event.title,
            arguments: parseToolArguments(event.title, event.arguments),
          });
          break;
        }
        case "item.completed": {
          if (event.itemId && event.itemType === "tool") {
            const partial = partialById.get(event.itemId);
            if (partial) {
              captured.toolCalls.push({
                id: partial.id,
                name: partial.name,
                arguments: partial.arguments,
              });
              partialById.delete(event.itemId);
            }
          } else if (event.itemType === "assistant_text") {
            captured.assistantText = captured.assistantText
              ? `${captured.assistantText}\n${event.text}`
              : event.text;
          }
          break;
        }
        case "turn.completed":
          captured.ok = event.ok;
          captured.stopReason = event.stopReason ?? null;
          finish(captured);
          break;
        case "runtime.error":
          // A run-time error from the driver mid-turn — record the
          // message and settle the turn as failed.  The dispatch fold
          // elsewhere also appends an error chip; this just stops the
          // executor from spinning on a turn that never produced a
          // turn.completed.
          fail(new Error(event.message));
          break;
      }
    });

    instance.adapter
      .sendTurn(input)
      .then(() => undefined)
      .catch(fail);
  });

  return completed;
}

/** Parse a tool's argument string with a JSON fallback to `{}`.  The
 * OpenAI spec sends the arguments as a JSON-encoded string; older or
 * custom drivers may send a plain object directly. */
export function parseToolArguments(
  _name: string,
  raw: unknown,
): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

/** Run a single tool call.  Currently only the agents tools (list_bots,
 * ask_bot) are implemented.  Anything else returns a clear "not
 * implemented" string so the model stops calling it on the next turn. */
export async function runHttpLaneTool(
  call: HttpLaneToolCall,
  ctx: HttpToolContext,
): Promise<string> {
  const fromBotId = ctx.fromBotId;

  if (call.name === "list_bots") {
    const target = fromBotId ? store.bot(fromBotId) : undefined;
    if (!target) return "(no current bot — list_bots needs a context)";
    const sectionKeyOf = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
    const sameSection = (candidate: typeof target) =>
      sectionKeyOf(candidate.section) === sectionKeyOf(target.section) && !candidate.hidden;
    const peers = store.bots.filter(sameSection);
    return JSON.stringify({
      section: target.section,
      bots: peers.map((peer) => ({
        id: peer.id,
        name: peer.name,
        title: peer.title ?? "",
        description: peer.description ?? "",
        model: peer.modelSelection.model,
      })),
    });
  }

  if (call.name === "ask_bot") {
    const target = String(call.arguments.bot_id ?? call.arguments.bot ?? "").trim();
    const task = String(call.arguments.task ?? call.arguments.message ?? "").trim();
    if (!target || !task) {
      return JSON.stringify({ error: "ask_bot requires both `bot_id` and `task`" });
    }
    const peer = store.bots.find((b) => b.id === target || `@${b.name}` === target);
    if (!peer) return JSON.stringify({ error: `no bot matches ${target}` });
    return await askBotAndWait(peer.id, task, ctx.commsDepth + 1, fromBotId);
  }

  if (call.name === "COMPOSIO_SEARCH_TOOLS"
    || call.name === "COMPOSIO_GET_TOOL_SCHEMAS"
    || call.name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    return `Composio tools are not wired to the HTTP tool executor yet.  The model called ${call.name}; the executor returned this string so the model can stop calling it.  Use a CLI driver (Claude, Codex, DSH, Droid, Pi) to call Composio.`;
  }

  if (call.name === "computer_screenshot"
    || call.name === "computer_click"
    || call.name === "computer_type") {
    return `Computer-use tools are not wired to the HTTP tool executor yet.  The model called ${call.name}; the executor returned this string so the model can stop calling it.  Use a CLI driver (Claude, Codex, DSH, Droid, Pi) to drive a browser.`;
  }

  return `Tool ${call.name} is not implemented in the HTTP tool executor.`;
}

export interface HttpToolContext {
  threadId: string;
  fromBotId?: string;
  commsDepth: number;
}

/** Wrap a driver `sendTurn` with the tool-use loop.  Each round:
 *  1. Call the driver with the current input.
 *  2. If the driver returns tool calls, execute them and re-invoke
 *     with the results appended to the transcript.
 *  3. If the driver returns no tool calls, return the captured text.
 *  Bound by MAX_TOOL_ROUNDS so a runaway model cannot loop forever. */
export async function sendTurnWithToolLoop(
  instance: ProviderInstance,
  input: SendTurnInput,
  ctx: HttpToolContext,
): Promise<{ text: string; ok: boolean; rounds: number }> {
  let currentInput = input;
  let totalText = "";
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const turn = await runOneTurn(instance, currentInput);
    totalText = turn.assistantText || totalText;
    if (!turn.ok) {
      return { text: totalText, ok: false, rounds: round + 1 };
    }
    if (turn.toolCalls.length === 0) {
      return { text: totalText, ok: true, rounds: round + 1 };
    }
    // The driver stopped on tool calls.  Execute each one and feed the
    // results back as a new turn.
    const results: HttpLaneToolResult[] = [];
    for (const call of turn.toolCalls) {
      const result = await runHttpLaneTool(call, ctx);
      results.push({ id: call.id, result });
    }
    currentInput = {
      ...currentInput,
      transcript: [
        ...(currentInput.transcript ?? []),
        {
          role: "assistant",
          text: "",
          toolCalls: turn.toolCalls.map((c) => ({
            id: c.id,
            name: c.name,
            arguments: JSON.stringify(c.arguments),
          })),
        },
        {
          role: "user",
          text: "",
          toolResults: results,
        },
      ],
    };
  }
  return { text: totalText, ok: true, rounds: MAX_TOOL_ROUNDS };
}
