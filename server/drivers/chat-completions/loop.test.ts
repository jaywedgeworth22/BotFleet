// The invariant this file exists to hold: ONE `turn.completed` per user
// turn, on EVERY exit.  The table below is parameterised over the closed
// `TurnLoopExit` union, so a new exit cannot be added to loop.ts without a
// row here saying what the user sees when it fires — which is the whole
// reason the union is closed and both lookup tables are `Record<…>`.
import { describe, expect, it, vi } from "vitest";

import type { RuntimeEvent, RuntimeEventBase, TurnToolHost, TurnToolOutcome } from "../../contracts.ts";
import {
  DEFAULT_TURN_LOOP_BUDGET,
  STOP_REASON,
  TERMINAL_OK,
  runTurnLoop,
  type ChatMessage,
  type ChatToolCall,
  type TurnLoopBudget,
  type TurnLoopExit,
  type TurnRoundResult,
} from "./loop.ts";

type TerminalEvent = RuntimeEventBase & {
  type: "turn.completed";
  ok: boolean;
  stopReason?: string | null;
  cost?: number | null;
  usage?: { input: number; output: number; cachedInput?: number };
};

// SAFETY: the filter keeps only `turn.completed` members of the RuntimeEvent
// union, which is exactly the shape TerminalEvent describes.
const terminals = (events: RuntimeEvent[]): TerminalEvent[] =>
  events.filter((e) => e.type === "turn.completed") as unknown as TerminalEvent[];

const call = (id: string, name = "list_bots", args = "{}"): ChatToolCall => ({
  id,
  type: "function",
  function: { name, arguments: args },
});

const answer = (text: string, usage: TurnRoundResult["usage"] = null): TurnRoundResult => ({
  text,
  usage,
});

const wantsTools = (calls: ChatToolCall[], usage: TurnRoundResult["usage"] = null): TurnRoundResult => ({
  text: "",
  toolCalls: calls,
  usage,
});

/** A host that answers every call the same way. */
const hostReturning = (outcome: TurnToolOutcome | ((name: string) => Promise<TurnToolOutcome>)): TurnToolHost => ({
  execute: async (c) => (typeof outcome === "function" ? outcome(c.name) : outcome),
});

interface Harness {
  events: RuntimeEvent[];
  abort: AbortController;
  messages: ChatMessage[];
  roundsSeen: ChatMessage[][];
  run: (over?: {
    toolHost?: TurnToolHost;
    budget?: Partial<TurnLoopBudget>;
    now?: () => number;
    emit?: (event: RuntimeEvent) => void;
    computeCost?: (usage: { input: number; output: number; cachedInput?: number }) => number | null;
  }) => Promise<TurnLoopExit>;
}

type ScriptedRound =
  | TurnRoundResult
  | ((opts: { signal: AbortSignal; round: number }) => Promise<TurnRoundResult>);

/** A model request that only ends when something aborts it — the shape a
 *  hung or very slow provider has, and the only shape that exercises the
 *  request and wall-clock ceilings honestly. */
const hangs = () => async (opts: { signal: AbortSignal }): Promise<TurnRoundResult> =>
  new Promise<TurnRoundResult>((_resolve, reject) => {
    opts.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
      once: true,
    });
  });

function harness(rounds: ScriptedRound[]): Harness {
  const events: RuntimeEvent[] = [];
  const abort = new AbortController();
  const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
  const roundsSeen: ChatMessage[][] = [];
  let seq = 0;
  const base = (): RuntimeEventBase => ({
    eventId: `ev-${++seq}`,
    provider: "fake",
    threadId: "thread-1",
    turnId: "turn-1",
    createdAt: new Date().toISOString(),
  });
  return {
    events,
    abort,
    messages,
    roundsSeen,
    run: (over) =>
      runTurnLoop({
        base,
        emit: over?.emit ?? ((event) => events.push(event)),
        messages,
        signal: abort.signal,
        toolHost: over?.toolHost,
        budget: over?.budget,
        now: over?.now,
        computeCost: over?.computeCost,
        runRound: async (roundMessages, opts) => {
          roundsSeen.push(roundMessages.map((m) => ({ ...m })));
          const scripted = rounds[Math.min(opts.round - 1, rounds.length - 1)];
          if (typeof scripted === "function") return scripted(opts);
          return scripted;
        },
      }),
  };
}

describe("runTurnLoop — exactly one terminal event on every exit", () => {
  // One row per member of TurnLoopExit.  Adding a member to the union
  // without adding a row here fails the exhaustiveness assertion below.
  const rows: Array<{
    exit: TurnLoopExit;
    build: () => Promise<{ events: RuntimeEvent[]; exit: TurnLoopExit }>;
  }> = [
    {
      exit: "settled",
      build: async () => {
        const h = harness([answer("done")]);
        return { exit: await h.run(), events: h.events };
      },
    },
    {
      exit: "suspended",
      build: async () => {
        const h = harness([wantsTools([call("c1", "request_credential")])]);
        const exit = await h.run({
          toolHost: hostReturning({
            kind: "suspend",
            content: "card shown",
            stopReason: "awaiting_human",
          }),
        });
        return { exit, events: h.events };
      },
    },
    {
      exit: "tool_round_limit",
      build: async () => {
        const h = harness([wantsTools([call("c1")])]);
        const exit = await h.run({
          budget: { maxRounds: 2 },
          toolHost: hostReturning({ kind: "result", content: "[]" }),
        });
        return { exit, events: h.events };
      },
    },
    {
      exit: "wall_clock",
      build: async () => {
        // the whole-turn budget is spent inside round 1, so round 2 never starts
        let clock = 0;
        const h = harness([
          async () => {
            clock += 5_000;
            return wantsTools([call("c1")]);
          },
        ]);
        const exit = await h.run({
          budget: { wallClockMs: 1_000 },
          now: () => clock,
          toolHost: hostReturning({ kind: "result", content: "[]" }),
        });
        return { exit, events: h.events };
      },
    },
    {
      exit: "request_timeout",
      build: async () => {
        vi.useFakeTimers();
        try {
          const h = harness([hangs()]);
          const running = h.run({ budget: { requestTimeoutMs: 5_000 } });
          await vi.advanceTimersByTimeAsync(6_000);
          const exit = await running;
          return { exit, events: h.events };
        } finally {
          vi.useRealTimers();
        }
      },
    },
    {
      exit: "provider_error",
      build: async () => {
        const h = harness([
          async () => {
            throw new Error("MiniMax HTTP 502: bad gateway");
          },
        ]);
        return { exit: await h.run(), events: h.events };
      },
    },
    {
      exit: "interrupted",
      build: async () => {
        const h = harness([wantsTools([call("c1")]), answer("late")]);
        // Stop lands while the tool is running — the window that used to be
        // a silent no-op
        const exit = await h.run({
          toolHost: {
            execute: async () => {
              h.abort.abort();
              return new Promise<TurnToolOutcome>(() => undefined);
            },
          },
        });
        return { exit, events: h.events };
      },
    },
    {
      exit: "internal_error",
      build: async () => {
        const h = harness([answer("boom")]);
        const events: RuntimeEvent[] = [];
        const exit = await h.run({
          emit: (event) => {
            // an unexpected throw from deep inside the round body: the kind
            // of bug that used to strand a turn with no terminal event
            if (event.type === "item.completed" && event.itemType === "assistant_text") {
              throw new Error("a consumer blew up");
            }
            events.push(event);
          },
        });
        return { exit, events };
      },
    },
  ];

  it("covers every member of the closed exit union", () => {
    const covered = new Set(rows.map((r) => r.exit));
    expect([...covered].sort()).toEqual(Object.keys(STOP_REASON).sort());
    expect(Object.keys(TERMINAL_OK).sort()).toEqual(Object.keys(STOP_REASON).sort());
  });

  for (const row of rows) {
    it(`${row.exit}: emits exactly one turn.completed, with its stop reason`, async () => {
      const { events, exit } = await row.build();
      expect(exit).toBe(row.exit);
      const settled = terminals(events);
      expect(settled).toHaveLength(1);
      expect(settled[0].ok).toBe(TERMINAL_OK[row.exit]);
      expect(settled[0].stopReason).toBe(STOP_REASON[row.exit]);
      // cost is priced in a later PR; a hard-coded 0 would read as "free"
      expect(settled[0].cost).toBeNull();
    });
  }
});

describe("runTurnLoop — the turn is settled by exactly one place", () => {
  it("drops the driver's active entry BEFORE the terminal event, so a synchronous drain can redispatch", async () => {
    const order: string[] = [];
    const h = harness([answer("done")]);
    await runTurnLoop({
      base: () => ({
        eventId: "e",
        provider: "fake",
        threadId: "thread-1",
        turnId: "turn-1",
        createdAt: new Date().toISOString(),
      }),
      emit: (event) => {
        if (event.type === "turn.completed") order.push("terminal");
      },
      messages: h.messages,
      signal: h.abort.signal,
      onSettled: () => order.push("released"),
      runRound: async () => answer("done"),
    });
    expect(order).toEqual(["released", "terminal"]);
  });

  it("reports an error chip for every non-ok exit except an interrupt", async () => {
    const failing = harness([
      async () => {
        throw new Error("MiniMax HTTP 500");
      },
    ]);
    await failing.run();
    expect(failing.events.filter((e) => e.type === "runtime.error")).toHaveLength(1);
    expect(failing.events.find((e) => e.type === "runtime.error")).toMatchObject({
      message: "MiniMax HTTP 500",
    });

    const stopped = harness([wantsTools([call("c1")])]);
    await stopped.run({
      toolHost: {
        execute: async () => {
          stopped.abort.abort();
          return new Promise<TurnToolOutcome>(() => undefined);
        },
      },
    });
    // an interrupt is a decision, not a failure — no red chip
    expect(stopped.events.filter((e) => e.type === "runtime.error")).toHaveLength(0);
  });

  it("settles as interrupted when Stop lands BETWEEN rounds", async () => {
    const h = harness([wantsTools([call("c1")]), answer("never reached")]);
    const exit = await h.run({
      toolHost: {
        execute: async () => {
          // the tool finishes, then Stop arrives before the next request
          h.abort.abort();
          return { kind: "result", content: "[]" } as TurnToolOutcome;
        },
      },
    });
    expect(exit).toBe("interrupted");
    expect(terminals(h.events)).toHaveLength(1);
    expect(h.roundsSeen).toHaveLength(1);
  });

  it("settles as interrupted when the turn is already aborted at dispatch", async () => {
    const h = harness([answer("should not run")]);
    h.abort.abort();
    const exit = await h.run();
    expect(exit).toBe("interrupted");
    expect(h.roundsSeen).toHaveLength(0);
    expect(terminals(h.events)).toHaveLength(1);
  });
});

describe("runTurnLoop — usage", () => {
  it("sums usage across rounds and carries the total on the terminal event", async () => {
    const h = harness([
      wantsTools([call("c1")], { input: 10, output: 5 }),
      answer("done", { input: 7, output: 3 }),
    ]);
    await h.run({ toolHost: hostReturning({ kind: "result", content: "[]" }) });
    expect(terminals(h.events)[0].usage).toEqual({ input: 17, output: 8 });
  });

  it("reports the usage it already streamed even when the turn fails", async () => {
    const h = harness([
      wantsTools([call("c1")], { input: 40, output: 2 }),
      async () => {
        throw new Error("MiniMax HTTP 503");
      },
    ]);
    await h.run({ toolHost: hostReturning({ kind: "result", content: "[]" }) });
    const settled = terminals(h.events)[0];
    expect(settled.ok).toBe(false);
    // a turn that streamed a large prompt and then 5xx'd is no longer billed at zero
    expect(settled.usage).toEqual({ input: 40, output: 2 });
  });

  it("omits usage entirely when no round reported any", async () => {
    const h = harness([answer("done")]);
    await h.run();
    expect(terminals(h.events)[0].usage).toBeUndefined();
  });

  it("prices the terminal event by SUMMING each round's OWN cost, on the success path", async () => {
    const h = harness([
      wantsTools([call("c1")], { input: 10, output: 5 }),
      answer("done", { input: 7, output: 3 }),
    ]);
    const seen: unknown[] = [];
    await h.run({
      toolHost: hostReturning({ kind: "result", content: "[]" }),
      computeCost: (usage) => {
        seen.push(usage);
        return usage.input + usage.output;
      },
    });
    const settled = terminals(h.events)[0];
    expect(settled.ok).toBe(true);
    expect(settled.usage).toEqual({ input: 17, output: 8 });
    // (10+5) + (7+3) = 25, from TWO calls — never one call against the
    // cumulative {input:17, output:8}
    expect(settled.cost).toBe(25);
    expect(seen).toEqual([
      { input: 10, output: 5 },
      { input: 7, output: 3 },
    ]);
  });

  it("prices a size-tiered model from EACH round's own size, never the turn's cumulative size", async () => {
    // Regression: MiniMax-M3 doubles its rate past 512K input tokens PER
    // REQUEST.  Two 300K-input rounds are each under that threshold and
    // must each price at the base rate — pricing them against the
    // cumulative 600K would apply the doubled rate to the whole turn,
    // roughly doubling the bill for a turn no single request of which
    // MiniMax itself billed at the higher tier.
    const tieredCost = (usage: { input: number; output: number }) =>
      usage.input > 512_000 ? usage.input * 2 : usage.input;
    const h = harness([
      wantsTools([call("c1")], { input: 300_000, output: 0 }),
      answer("done", { input: 300_000, output: 0 }),
    ]);
    await h.run({
      toolHost: hostReturning({ kind: "result", content: "[]" }),
      computeCost: tieredCost,
    });
    const settled = terminals(h.events)[0];
    expect(settled.usage).toEqual({ input: 600_000, output: 0 });
    // base rate both times: 300,000 + 300,000 — NOT the doubled rate
    // 600,000 * 2 a cumulative-totals bug would produce
    expect(settled.cost).toBe(600_000);
  });

  it("prices the terminal event on the error path too, from whatever usage streamed before the failure", async () => {
    const h = harness([
      wantsTools([call("c1")], { input: 40, output: 2 }),
      async () => {
        throw new Error("MiniMax HTTP 503");
      },
    ]);
    const exit = await h.run({
      toolHost: hostReturning({ kind: "result", content: "[]" }),
      computeCost: (usage) => usage.input * 2 + usage.output,
    });
    expect(exit).toBe("provider_error");
    const settled = terminals(h.events)[0];
    expect(settled.ok).toBe(false);
    expect(settled.cost).toBe(82);
  });

  it("never calls computeCost, and never invents a cost, when no round reported usage", async () => {
    const h = harness([answer("done")]);
    const computeCost = vi.fn(() => 99);
    await h.run({ computeCost });
    expect(computeCost).not.toHaveBeenCalled();
    expect(terminals(h.events)[0].cost).toBeNull();
  });

  it("stays null — never 0 — when the driver has no computeCost wired up at all", async () => {
    const h = harness([answer("done", { input: 1, output: 1 })]);
    await h.run();
    expect(terminals(h.events)[0].cost).toBeNull();
  });

  it("makes the WHOLE turn's cost null — never a partial sum — when any round's cost is unknown", async () => {
    // A price table missing a row for whatever model this round ran
    // against returns null for THAT round; the rounds already priced must
    // not be reported as if they were the turn's whole cost.
    let round = 0;
    const h = harness([
      wantsTools([call("c1")], { input: 10, output: 5 }),
      answer("done", { input: 7, output: 3 }),
    ]);
    await h.run({
      toolHost: hostReturning({ kind: "result", content: "[]" }),
      computeCost: () => {
        round += 1;
        return round === 1 ? 5 : null;
      },
    });
    const settled = terminals(h.events)[0];
    expect(settled.usage).toEqual({ input: 17, output: 8 });
    expect(settled.cost).toBeNull();
  });

  it("keeps the live indicator cumulative, never per-round", async () => {
    const h = harness([
      wantsTools([call("c1")], { input: 10, output: 5 }),
      answer("done", { input: 7, output: 3 }),
    ]);
    await h.run({ toolHost: hostReturning({ kind: "result", content: "[]" }) });
    const live = h.events.filter((e) => e.type === "thread.token-usage.updated");
    expect(live.map((e) => (e as { input: number }).input)).toEqual([10, 17]);
  });
});

describe("runTurnLoop — tool results are real", () => {
  it("emits item.completed AFTER the host returns, with the real ok and detail", async () => {
    const h = harness([wantsTools([call("c1", "ask_bot")]), answer("done")]);
    await h.run({
      toolHost: hostReturning({ kind: "error", content: "peer busy", detail: "peer busy" }),
    });
    const completed = h.events.filter((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ ok: false, detail: "peer busy", itemId: "c1" });
  });

  it("a failing tool is information, not an exit — the loop feeds it back and keeps going", async () => {
    const h = harness([wantsTools([call("c1")]), answer("recovered")]);
    const exit = await h.run({ toolHost: hostReturning({ kind: "error", content: "no such bot" }) });
    expect(exit).toBe("settled");
    expect(h.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: "no such bot" });
  });

  it("a host that throws cannot leave the turn open", async () => {
    const h = harness([wantsTools([call("c1")]), answer("recovered")]);
    const exit = await h.run({
      toolHost: {
        execute: async () => {
          throw new Error("host exploded");
        },
      },
    });
    expect(exit).toBe("settled");
    expect(terminals(h.events)).toHaveLength(1);
    expect(String(h.messages.at(-1)?.content)).toContain("host exploded");
  });

  it("tells the model plainly when no tool host was attached", async () => {
    const h = harness([wantsTools([call("c1")]), answer("ok then")]);
    const exit = await h.run();
    expect(exit).toBe("settled");
    expect(String(h.messages.at(-1)?.content)).toContain("no tool host");
  });

  it("announces a tool the stream never announced, and never announces one twice", async () => {
    const h = harness([wantsTools([call("c1"), call("c2")]), answer("done")]);
    await runTurnLoop({
      base: () => ({
        eventId: "e",
        provider: "fake",
        threadId: "thread-1",
        turnId: "turn-1",
        createdAt: new Date().toISOString(),
      }),
      emit: (event) => h.events.push(event),
      messages: h.messages,
      signal: h.abort.signal,
      // the streaming reader already opened a row for c1
      startedToolIds: new Set(["c1"]),
      toolHost: hostReturning({ kind: "result", content: "[]" }),
      runRound: async (_m, opts) =>
        opts.round === 1 ? wantsTools([call("c1"), call("c2")]) : answer("done"),
    });
    const started = h.events.filter((e) => e.type === "item.started");
    expect(started.map((e) => e.itemId)).toEqual(["c2"]);
  });

  it("closes the chips of tools that never finished when the turn is stopped", async () => {
    const h = harness([wantsTools([call("c1"), call("c2")])]);
    await h.run({
      toolHost: {
        execute: async (c) => {
          if (c.id === "c1") {
            h.abort.abort();
            return new Promise<TurnToolOutcome>(() => undefined);
          }
          return new Promise<TurnToolOutcome>(() => undefined);
        },
      },
    });
    const completed = h.events.filter((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(completed).toHaveLength(2);
    expect(completed.every((e) => (e as { ok: boolean }).ok === false)).toBe(true);
  });
});

describe("runTurnLoop — rounds", () => {
  it("runs a round's calls concurrently and appends the results in CALL order", async () => {
    let inFlight = 0;
    let peak = 0;
    const h = harness([wantsTools([call("slow", "ask_bot"), call("fast", "ask_bot")]), answer("done")]);
    await h.run({
      toolHost: {
        execute: async (c) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          // the second call finishes first; the transcript must not reorder
          await new Promise((r) => setTimeout(r, c.id === "slow" ? 30 : 1));
          inFlight -= 1;
          return { kind: "result", content: `${c.id} result` };
        },
      },
    });
    expect(peak).toBe(2);
    const toolMessages = h.messages.filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["slow", "fast"]);
    expect(toolMessages.map((m) => m.content)).toEqual(["slow result", "fast result"]);
  });

  it("only ever APPENDS to the messages array, so each round re-sends a byte-identical prefix", async () => {
    const h = harness([
      wantsTools([call("c1")], { input: 1, output: 1 }),
      wantsTools([call("c2")], { input: 1, output: 1 }),
      answer("done"),
    ]);
    await h.run({ toolHost: hostReturning({ kind: "result", content: "[]" }) });
    expect(h.roundsSeen).toHaveLength(3);
    for (let i = 1; i < h.roundsSeen.length; i++) {
      const previous = h.roundsSeen[i - 1];
      expect(h.roundsSeen[i].slice(0, previous.length)).toEqual(previous);
      expect(h.roundsSeen[i].length).toBeGreaterThan(previous.length);
    }
  });

  it("never starts a tool batch on the round it cannot report back on", async () => {
    let executed = 0;
    const h = harness([wantsTools([call("c1")])]);
    const exit = await h.run({
      budget: { maxRounds: 1 },
      toolHost: {
        execute: async () => {
          executed += 1;
          return { kind: "result", content: "[]" };
        },
      },
    });
    expect(exit).toBe("tool_round_limit");
    expect(executed).toBe(0);
    // the row still settles rather than spinning forever
    const completed = h.events.filter((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ ok: false });
  });

  it("lets the host lower the round ceiling", async () => {
    const h = harness([wantsTools([call("c1")])]);
    const exit = await h.run({
      toolHost: { maxRounds: 3, execute: async () => ({ kind: "result", content: "[]" }) },
    });
    expect(exit).toBe("tool_round_limit");
    expect(h.roundsSeen).toHaveLength(3);
  });

  it("a tool that overruns its own budget fails without ending the turn", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([wantsTools([call("c1")]), answer("moving on")]);
      const running = h.run({
        budget: { toolTimeoutMs: 5_000 },
        toolHost: { execute: async () => new Promise<TurnToolOutcome>(() => undefined) },
      });
      await vi.advanceTimersByTimeAsync(6_000);
      const exit = await running;
      expect(exit).toBe("settled");
      expect(String(h.messages.find((m) => m.role === "tool")?.content)).toContain("did not finish");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the whole-turn budget cuts off a request that is still streaming", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([hangs()]);
      const running = h.run({ budget: { wallClockMs: 4_000, requestTimeoutMs: 900_000 } });
      await vi.advanceTimersByTimeAsync(5_000);
      const exit = await running;
      expect(exit).toBe("wall_clock");
      expect(terminals(h.events)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the shipped budget", () => {
  it("is the one the design signed off on", () => {
    expect(DEFAULT_TURN_LOOP_BUDGET).toEqual({
      maxRounds: 12,
      requestTimeoutMs: 180_000,
      toolTimeoutMs: 90_000,
      wallClockMs: 900_000,
      toolConcurrency: 4,
    });
  });
});
