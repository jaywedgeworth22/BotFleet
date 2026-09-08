// The driver-owned tool loop for chat-completions engines.
//
// WHY THIS FILE EXISTS.  A CLI engine runs its own model-to-tool rounds
// inside one turn and emits exactly one `turn.started` / `turn.completed`
// pair per user turn.  Every one of the harness's `turn.completed`
// consumers — the watchdog, the Sentry span closer, the routine receipt,
// the repeat detector, the room waiter, the queue drains, the SSE
// broadcast, the usage fold — was written against that shape.  The HTTP
// lane used to break it: each inner round was its own `turn.completed`
// carrying a `"tool_calls: "` prefix, five consumers guarded on the
// prefix and six did not, and every exit that was not "the model finally
// answered" — the round cap, the round timer, a rejected dispatch —
// emitted no terminal event at all, so the bot stayed busy until the
// twenty-minute stall watchdog fired.
//
// Moving the loop in here makes an HTTP turn indistinguishable from a CLI
// turn at the harness boundary, and it does it structurally rather than by
// adding guards:
//
//   1. ONE terminal event, from ONE `finally`.  Nothing else in this file
//      emits `turn.completed`.  No exit — round cap, wall clock, request
//      timeout, provider error, abort, suspend, a host that throws, an
//      unexpected throw — can leave a turn unsettled.  The exit union
//      below is CLOSED and both lookup tables are `Record<TurnLoopExit, …>`,
//      so a new exit cannot be added without a stop reason, an ok flag,
//      and (in loop.test.ts) a test row.
//   2. The messages array lives here and is only appended to, so the
//      prefix the provider already saw stays byte-identical across rounds.
//   3. Usage sums across rounds and is carried on the terminal event, on
//      the error path as well as the success path.
//   4. `item.completed` for a tool carries the REAL outcome, emitted after
//      the host returns — never `ok: true` for work the driver did not do.
//   5. The turn's abort signal is checked between rounds and raced inside
//      every tool call, so Stop terminates from any point in the loop.

import type {
  RuntimeEvent,
  RuntimeEventBase,
  TurnToolCall,
  TurnToolHost,
  TurnToolOutcome,
} from "../../contracts.ts";
import { parseToolArguments, toolFields } from "../../tool-fields.ts";

/** Every way a turn can end.  Closed on purpose: `STOP_REASON` and
 *  `TERMINAL_OK` are `Record<TurnLoopExit, …>`, so adding a member without
 *  deciding what the user sees is a type error, not a silent hang. */
export type TurnLoopExit =
  /** The model returned text with no tool calls. */
  | "settled"
  /** A tool put a card in front of a person; the resume drains a new turn. */
  | "suspended"
  /** `maxRounds` model requests were spent and the model still wanted tools. */
  | "tool_round_limit"
  /** The whole-turn budget ran out. */
  | "wall_clock"
  /** One model request exceeded `requestTimeoutMs`. */
  | "request_timeout"
  /** An HTTP or stream failure from the provider. */
  | "provider_error"
  /** Stop, a sweep, or teardown. */
  | "interrupted"
  /** Anything else — never silently swallowed. */
  | "internal_error";

export const STOP_REASON: Record<TurnLoopExit, string> = {
  settled: "end_turn",
  suspended: "awaiting_human",
  tool_round_limit: "tool_round_limit",
  wall_clock: "timeout",
  request_timeout: "timeout",
  provider_error: "error",
  interrupted: "interrupted",
  internal_error: "error",
};

export const TERMINAL_OK: Record<TurnLoopExit, boolean> = {
  settled: true,
  suspended: true,
  tool_round_limit: false,
  wall_clock: false,
  request_timeout: false,
  provider_error: false,
  interrupted: false,
  internal_error: false,
};

export interface TurnLoopBudget {
  /** Model requests this turn may spend.  The LAST request is never allowed
   *  to start a tool batch, because its results could never be reported back
   *  — running side effects nobody reads is worse than stopping one round
   *  earlier. */
  maxRounds: number;
  /** Ceiling on one model request, enforced by an abort the request itself
   *  carries.  A harness-side timer that fires while the request keeps
   *  streaming is what manufactured orphaned late completions before. */
  requestTimeoutMs: number;
  /** Ceiling on one tool call. */
  toolTimeoutMs: number;
  /** Ceiling on the whole turn, rounds and tools together. */
  wallClockMs: number;
  /** Tool calls from one round that may run at once. */
  toolConcurrency: number;
}

export const DEFAULT_TURN_LOOP_BUDGET: TurnLoopBudget = {
  maxRounds: 12,
  requestTimeoutMs: 180_000,
  toolTimeoutMs: 90_000,
  wallClockMs: 900_000,
  toolConcurrency: 4,
};

/** One OpenAI chat message.  The loop owns the array; the driver only turns
 *  it into a request body. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
}

export interface TurnUsage {
  input: number;
  output: number;
  cachedInput?: number;
}

/** What one model request produced. */
export interface TurnRoundResult {
  text: string;
  toolCalls?: ChatToolCall[];
  usage: TurnUsage | null;
}

export interface TurnLoopDeps {
  /** Event envelope for this turn — eventId, provider, threadId, turnId. */
  base: () => RuntimeEventBase;
  emit: (event: RuntimeEvent) => void;
  /** One model request.  MUST honour `signal` and MUST reject on an HTTP or
   *  stream failure; the loop classifies the rejection. */
  runRound: (
    messages: ChatMessage[],
    opts: { signal: AbortSignal; round: number },
  ) => Promise<TurnRoundResult>;
  /** Round 1's messages.  The loop appends to this array in place. */
  messages: ChatMessage[];
  toolHost?: TurnToolHost;
  /** The turn's interrupt signal — `interruptTurn`, `stopAll`, `dispose`. */
  signal: AbortSignal;
  /** Tool ids the streaming reader already announced with `item.started`,
   *  shared with the driver so a call is never announced twice. */
  startedToolIds?: Set<string>;
  budget?: Partial<TurnLoopBudget>;
  /** Called inside the `finally`, immediately BEFORE the terminal event.
   *  The driver drops its `active` entry here: a consumer of
   *  `turn.completed` may dispatch the next queued turn synchronously, and
   *  it must not find this thread still busy. */
  onSettled?: (exit: TurnLoopExit) => void;
  now?: () => number;
}

/** A tool's arguments are declared as a JSON object schema; anything else on
 *  the wire is a malformed call, which the host reports back to the model. */
function decodeArguments(raw: unknown): Record<string, unknown> {
  const parsed = parseToolArguments(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

/** Node's setTimeout handle carries `unref`; the DOM's does not, and this
 *  file is typed against both.  A budget nobody is waiting on must never
 *  hold the process open. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const handle: { unref?: () => void } = timer;
  handle.unref?.();
}

/** Rejects when `signal` aborts, and detaches its listener either way so a
 *  long turn does not accumulate one per race. */
function abortRejection(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort: () => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  // an unobserved rejection is normal here — the race's winner may be the
  // work, not the abort
  promise.catch(() => undefined);
  return { promise, dispose: () => signal.removeEventListener("abort", onAbort) };
}

/**
 * Run one user turn to completion and emit EXACTLY ONE `turn.completed`.
 *
 * Resolves with the exit that produced the terminal event.  Never rejects:
 * an unexpected throw becomes `internal_error`, which is still one terminal
 * event.  The caller detaches it (`void runTurnLoop(...)`) so `sendTurn`
 * still resolves at dispatch, the way every CLI driver's does.
 */
export async function runTurnLoop(deps: TurnLoopDeps): Promise<TurnLoopExit> {
  const budget: TurnLoopBudget = { ...DEFAULT_TURN_LOOP_BUDGET, ...deps.budget };
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const messages = deps.messages;
  const announced = deps.startedToolIds ?? new Set<string>();
  const maxRounds = Math.max(1, deps.toolHost?.maxRounds ?? budget.maxRounds);

  const totals: TurnUsage = { input: 0, output: 0 };
  let sawUsage = false;

  const turnSignal = deps.signal;
  const wall = new AbortController();
  let wallHit = false;
  const wallTimer = setTimeout(() => {
    wallHit = true;
    wall.abort();
  }, budget.wallClockMs);
  // never hold the process open for a budget nobody is waiting on
  unrefTimer(wallTimer);

  let exit: TurnLoopExit = "internal_error";
  let stopReasonOverride: string | null = null;
  let errorMessage: string | null = null;

  const emitToolStarted = (call: ChatToolCall) => {
    if (!call.id || announced.has(call.id)) return;
    announced.add(call.id);
    deps.emit({
      ...deps.base(),
      type: "item.started",
      itemType: "tool",
      itemId: call.id,
      title: call.function.name || "tool",
      ...toolFields(call.function.name, parseToolArguments(call.function.arguments)),
      arguments: call.function.arguments,
    });
  };

  /** Run one tool.  Resolves with the outcome the model is told about, and
   *  rejects ONLY when the turn itself is over (interrupt or wall clock) —
   *  a tool that fails or times out is information, not an exit. */
  const runOneTool = async (call: ChatToolCall): Promise<TurnToolOutcome> => {
    const host = deps.toolHost;
    const decoded: TurnToolCall = {
      id: call.id,
      name: call.function.name,
      arguments: decodeArguments(call.function.arguments),
    };
    if (!host) {
      return {
        kind: "error",
        content: `Tool ${decoded.name} is not available on this turn — no tool host was attached.`,
        detail: "no tool host",
      };
    }
    const toolAbort = new AbortController();
    let toolTimedOut = false;
    const toolTimer = setTimeout(() => {
      toolTimedOut = true;
      toolAbort.abort();
    }, budget.toolTimeoutMs);
    unrefTimer(toolTimer);
    const signal = AbortSignal.any([turnSignal, wall.signal, toolAbort.signal]);
    const race = abortRejection(signal);
    try {
      return await Promise.race([
        // the contract says a host never throws; this normalises the one
        // that does rather than letting it end the turn
        host
          .execute(decoded, {
            signal,
            requestApproval: async () => "unavailable",
          })
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e);
            return { kind: "error", content: `Tool ${decoded.name} failed: ${message}`, detail: message } as TurnToolOutcome;
          }),
        race.promise,
      ]);
    } catch (e) {
      // the turn is over — let the loop settle it
      if (turnSignal.aborted || wallHit) throw e;
      if (toolTimedOut) {
        return {
          kind: "error",
          content: `Tool ${decoded.name} did not finish within ${Math.round(budget.toolTimeoutMs / 1000)}s and was stopped.`,
          detail: "timed out",
        };
      }
      throw e;
    } finally {
      clearTimeout(toolTimer);
      race.dispose();
    }
  };

  /** Run a round's calls with bounded concurrency.  Outcomes come back in
   *  CALL order regardless of completion order, because the provider must
   *  see its tool results in the order it asked for them. */
  const runToolBatch = async (calls: ChatToolCall[]): Promise<TurnToolOutcome[]> => {
    const outcomes: Array<TurnToolOutcome | undefined> = new Array(calls.length);
    let next = 0;
    let failure: unknown = null;
    const worker = async () => {
      for (;;) {
        const index = next++;
        if (index >= calls.length || failure) return;
        const call = calls[index];
        const outcome = await runOneTool(call);
        outcomes[index] = outcome;
        // AFTER the host returned, carrying the host's real verdict — never
        // ok:true for work the driver did not do.
        const row = {
          ...deps.base(),
          type: "item.completed" as const,
          itemType: "tool" as const,
          itemId: call.id,
          ok: outcome.kind !== "error",
          arguments: call.function.arguments,
        };
        deps.emit(outcome.detail ? { ...row, detail: outcome.detail } : row);
      }
    };
    const lanes = Math.max(1, Math.min(budget.toolConcurrency, calls.length));
    await Promise.all(
      Array.from({ length: lanes }, () =>
        worker().catch((reason: Error) => {
          failure ??= reason;
        }),
      ),
    );
    if (failure) {
      // the turn ended mid-batch: close the chips that never settled so the
      // transcript does not keep a tool row spinning forever
      for (let i = 0; i < calls.length; i++) {
        if (outcomes[i]) continue;
        deps.emit({
          ...deps.base(),
          type: "item.completed",
          itemType: "tool",
          itemId: calls[i].id,
          ok: false,
          detail: "the turn ended before this tool finished",
          arguments: calls[i].function.arguments,
        });
      }
      throw failure;
    }
    // SAFETY: every index was filled above; the only path that leaves a hole
    // throws before this line.
    return outcomes as TurnToolOutcome[];
  };

  try {
    for (let round = 1; round <= maxRounds; round++) {
      if (turnSignal.aborted) {
        exit = "interrupted";
        break;
      }
      if (wallHit || now() - startedAt >= budget.wallClockMs) {
        exit = "wall_clock";
        break;
      }

      const request = new AbortController();
      let requestTimedOut = false;
      const requestTimer = setTimeout(() => {
        requestTimedOut = true;
        request.abort();
      }, budget.requestTimeoutMs);
      unrefTimer(requestTimer);
      let result: TurnRoundResult;
      try {
        result = await deps.runRound(messages, {
          signal: AbortSignal.any([turnSignal, wall.signal, request.signal]),
          round,
        });
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        if (turnSignal.aborted) exit = "interrupted";
        else if (wallHit) {
          exit = "wall_clock";
          errorMessage = `the turn ran past its ${Math.round(budget.wallClockMs / 1000)}s budget and was stopped`;
        } else if (requestTimedOut) {
          exit = "request_timeout";
          errorMessage = `the model did not answer within ${Math.round(budget.requestTimeoutMs / 1000)}s`;
        } else {
          exit = "provider_error";
          errorMessage = error.message;
        }
        break;
      } finally {
        clearTimeout(requestTimer);
      }

      if (result.usage) {
        sawUsage = true;
        totals.input += result.usage.input;
        totals.output += result.usage.output;
        const cached = result.usage.cachedInput;
        if (cached !== undefined) totals.cachedInput = (totals.cachedInput ?? 0) + cached;
        // Cumulative, never per-round: this event is a LIVE INDICATOR whose
        // meaning differs per driver and which consumers are told never to
        // sum.  The terminal event carries the authoritative figure.
        const live = { ...deps.base(), type: "thread.token-usage.updated" as const };
        deps.emit(
          totals.cachedInput === undefined
            ? { ...live, input: totals.input, output: totals.output }
            : { ...live, input: totals.input, output: totals.output, cachedInput: totals.cachedInput },
        );
      }
      if (result.text.trim()) {
        deps.emit({ ...deps.base(), type: "item.completed", itemType: "assistant_text", text: result.text });
      }

      const calls = (result.toolCalls ?? []).filter((call) => call.id);
      if (calls.length === 0) {
        exit = "settled";
        break;
      }

      // The prefix the provider already saw is never rewritten — only
      // appended to — which is what keeps prompt caching reachable and what
      // removed the duplicate-replay bug the transcript rebuild had.
      messages.push({ role: "assistant", content: result.text ?? "", tool_calls: calls });

      if (round === maxRounds) {
        for (const call of calls) {
          emitToolStarted(call);
          deps.emit({
            ...deps.base(),
            type: "item.completed",
            itemType: "tool",
            itemId: call.id,
            ok: false,
            detail: `the turn hit its ${maxRounds}-round limit before this tool ran`,
            arguments: call.function.arguments,
          });
        }
        exit = "tool_round_limit";
        errorMessage = `the turn used all ${maxRounds} tool rounds and was stopped`;
        break;
      }

      for (const call of calls) emitToolStarted(call);
      const outcomes = await runToolBatch(calls);
      for (let i = 0; i < calls.length; i++) {
        messages.push({ role: "tool", tool_call_id: calls[i].id, content: outcomes[i].content });
      }

      const suspended = outcomes.find((outcome) => outcome.kind === "suspend");
      if (suspended && suspended.kind === "suspend") {
        exit = "suspended";
        stopReasonOverride = suspended.stopReason;
        break;
      }
    }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    if (turnSignal.aborted) exit = "interrupted";
    else if (wallHit) {
      exit = "wall_clock";
      errorMessage = `the turn ran past its ${Math.round(budget.wallClockMs / 1000)}s budget and was stopped`;
    } else {
      exit = "internal_error";
      errorMessage = error.message;
    }
  } finally {
    clearTimeout(wallTimer);
    // Drop the driver's active entry BEFORE the terminal event: the fold
    // that handles turn.completed drains queued sends synchronously, and a
    // fresh dispatch must not find this thread still busy.
    deps.onSettled?.(exit);
    // An interrupt is not an error — every other non-ok exit gets a chip
    // saying what happened, because "the bot went idle for no stated
    // reason" is the failure mode this whole file exists to end.
    if (errorMessage && exit !== "interrupted") {
      deps.emit({ ...deps.base(), type: "runtime.error", message: errorMessage });
    }
    const completed = {
      ...deps.base(),
      type: "turn.completed" as const,
      ok: TERMINAL_OK[exit],
      stopReason: stopReasonOverride ?? STOP_REASON[exit],
      // priced in a later PR; a hard-coded 0 would read as "this turn was
      // free", which is worse than an honest blank
      cost: null,
    };
    // The one terminal event.  Nothing else in this file emits this type.
    deps.emit(sawUsage ? { ...completed, usage: { ...totals } } : completed);
  }

  return exit;
}
