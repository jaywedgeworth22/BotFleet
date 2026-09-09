// Fan-in event bus — port of upstream's ProviderService fan-in +
// EventNdjsonLogger tee, minus Effect. Every adapter's event stream merges
// into one bus; each event is stamped with its providerInstanceId, teed to
// a per-thread canonical NDJSON log (the debugging trick both upstream and
// agentcal lean on), and delivered to subscribers (the SSE endpoint and
// the server-side message folder).
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { EVENTS_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { newId, type ProviderInstance, type RuntimeEvent, type RuntimeEventListener } from "../contracts.ts";

const INCOMPLETE_LOG_MESSAGE =
  "Canonical event history is incomplete: BotFleet could not write one or more events to disk. Live updates will continue.";

/** How many settled turns the duplicate-terminal detector remembers.  A
 * bound, not a lifetime: the check exists to catch a driver bug within the
 * same conversation, not to keep a ledger. */
const SETTLED_TURN_MEMORY = 512;

export class EventBus {
  private listeners = new Set<RuntimeEventListener>();
  private unsubscribes = new Map<string, () => void>();
  private pendingLogWarnings = new Map<string, RuntimeEvent>();
  /** `threadId:turnId` of every turn that has already produced a terminal
   * event.  Insertion-ordered, so the oldest entry is the one evicted. */
  private settledTurns = new Set<string>();
  private readonly appendLog: typeof appendFileSync;

  constructor(appendLog: typeof appendFileSync = appendFileSync) {
    this.appendLog = appendLog;
  }

  attach(instances: ProviderInstance[]) {
    for (const instance of instances) {
      this.detach(instance.instanceId);
      const unsub = instance.adapter.onEvent((event) => {
        // hard invariant borrowed from correlateRuntimeEventWithInstance:
        // an adapter may only emit events for its own driver kind
        if (event.provider !== instance.driverKind) {
          console.error(`bus: dropped cross-driver event from ${instance.instanceId}`);
          return;
        }
        // Second hard invariant: exactly one terminal event per turn.  Every
        // consumer of turn.completed — the watchdog, the Sentry span closer,
        // the routine receipt, the repeat detector, the room waiter, the
        // usage fold, the queue drains — assumes it fires once, and a driver
        // that emits it twice settles a turn twice with no error anywhere.
        // This is a DETECTOR, not a gate: it drops the duplicate and says
        // so, so a driver bug shows up as a log line instead of a double
        // receipt.  It buys coverage for consumers nobody has written yet.
        if (this.isDuplicateTerminal(event)) {
          console.error(
            `bus: dropped a second turn.completed for ${event.threadId}:${event.turnId} from ${instance.instanceId} — a driver emitted two terminal events for one turn (harness bug)`,
          );
          return;
        }
        this.publish({ ...event, providerInstanceId: instance.instanceId });
      });
      this.unsubscribes.set(instance.instanceId, unsub);
    }
  }

  detach(instanceId: string) {
    const unsub = this.unsubscribes.get(instanceId);
    if (unsub) {
      unsub();
      this.unsubscribes.delete(instanceId);
    }
  }

  /** True when this turn has already settled.  A terminal event with no
   * turnId cannot be correlated, so it is always let through — the check
   * never guesses. */
  private isDuplicateTerminal(event: RuntimeEvent): boolean {
    if (event.type !== "turn.completed" || !event.turnId) return false;
    const key = `${event.threadId}:${event.turnId}`;
    if (this.settledTurns.has(key)) return true;
    this.settledTurns.add(key);
    if (this.settledTurns.size > SETTLED_TURN_MEMORY) {
      const oldest = this.settledTurns.values().next();
      if (!oldest.done) this.settledTurns.delete(oldest.value);
    }
    return false;
  }

  publish(event: RuntimeEvent) {
    const pendingWarning = this.pendingLogWarnings.get(event.threadId);
    const persistedEvents = pendingWarning ? [pendingWarning, redactSecrets(event)] : [redactSecrets(event)];
    try {
      // the canonical log is a file people paste into bug reports; scrub
      // credential-shaped content (tool titles, request summaries, reply
      // text) the same way the native tee does
      this.appendLog(
        join(EVENTS_DIR, `${event.threadId}.ndjson`),
        persistedEvents.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
        { mode: 0o600 },
      );
      if (pendingWarning) this.pendingLogWarnings.delete(event.threadId);
    } catch (error) {
      // Never feed this warning back through publish(): that would retry the
      // same failed write and recurse. Deliver it once for this outage, then
      // persist the same marker before the first event written after recovery.
      if (!pendingWarning) {
        const warning: RuntimeEvent = {
          eventId: newId(),
          provider: event.provider,
          providerInstanceId: event.providerInstanceId,
          threadId: event.threadId,
          createdAt: new Date().toISOString(),
          turnId: event.turnId,
          type: "runtime.error",
          message: INCOMPLETE_LOG_MESSAGE,
        };
        this.pendingLogWarnings.set(event.threadId, warning);
        console.error("bus: canonical event log write failed", error);
        this.deliver(warning);
      }
    }
    this.deliver(event);
  }

  private deliver(event: RuntimeEvent) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (e) {
        console.error("bus: listener threw", e);
      }
    }
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  detachAll() {
    for (const unsub of this.unsubscribes.values()) unsub();
    this.unsubscribes.clear();
  }
}
