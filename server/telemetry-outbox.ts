import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

export interface DurableTelemetryBatch {
  schemaVersion: 2;
  producerId: string;
  producerInstanceId: string;
  events: Array<{ eventId: string }>;
}

export interface TelemetryDeliveryResult {
  acknowledged: boolean;
  rejected: number;
}

export interface TelemetryOutboxStatus {
  queuedBatches: number;
  oldestQueuedAt: string | null;
  oldestQueuedAgeMs: number | null;
  droppedBatches: number;
  overflowDroppedBatches: number;
  destinationChangeDroppedBatches: number;
  rejectedEvents: number;
  failedAttempts: number;
  persistenceFailures: number;
  nonDurableBatches: number;
  corruptFilesQuarantined: number;
}

const DurableTelemetryBatchSchema = z.object({
  schemaVersion: z.literal(2),
  producerId: z.string().min(1),
  producerInstanceId: z.string().min(1),
  events: z.array(z.object({ eventId: z.string().min(1) }).passthrough()).min(1),
}).passthrough();

const QueuedBatchSchema = z.object({
  queueId: z.string().regex(/^[a-f0-9]{64}$/),
  destinationHash: z.string().regex(/^[a-f0-9]{64}$/),
  enqueuedAt: z.iso.datetime(),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.number().finite(),
  batch: DurableTelemetryBatchSchema,
});

const StoredOutboxSchema = z.object({
  version: z.literal(2),
  queue: z.array(QueuedBatchSchema),
  droppedBatches: z.number().int().nonnegative(),
  overflowDroppedBatches: z.number().int().nonnegative(),
  destinationChangeDroppedBatches: z.number().int().nonnegative(),
  rejectedEvents: z.number().int().nonnegative(),
  failedAttempts: z.number().int().nonnegative(),
  persistenceFailures: z.number().int().nonnegative(),
  corruptFilesQuarantined: z.number().int().nonnegative(),
});

type StoredOutbox = z.infer<typeof StoredOutboxSchema>;

interface DeliveryContext {
  destinationHash: string;
  deliver: (batch: DurableTelemetryBatch) => Promise<TelemetryDeliveryResult>;
}

interface OutboxOptions {
  path?: string;
  maxBatches?: number;
  now?: () => number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  writeState?: (path: string, state: StoredOutbox) => void;
  onDiagnostic?: (name: "delivery_failed" | "events_rejected" | "overflow_dropped" | "destination_changed" | "persistence_failed" | "corrupt_quarantined", count: number) => void;
}

const DEFAULT_OUTBOX_PATH = join(homedir(), ".botfleet", "usage-telemetry-outbox.json");

export function usageTelemetryDestinationHash(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

function emptyState(): StoredOutbox {
  return {
    version: 2,
    queue: [],
    droppedBatches: 0,
    overflowDroppedBatches: 0,
    destinationChangeDroppedBatches: 0,
    rejectedEvents: 0,
    failedAttempts: 0,
    persistenceFailures: 0,
    corruptFilesQuarantined: 0,
  };
}

function defaultWriteState(path: string, state: StoredOutbox): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * Small durable queue for already-sanitized Usage Monitor batches.  It never
 * stores a bearer token or endpoint.  A one-way endpoint hash fences queued
 * batches from a different destination after configuration changes.
 */
export class UsageTelemetryOutbox {
  private readonly path: string;
  private readonly maxBatches: number;
  private readonly now: () => number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly onDiagnostic: OutboxOptions["onDiagnostic"];
  private readonly writeState: NonNullable<OutboxOptions["writeState"]>;
  private state: StoredOutbox;
  private dispatcher: (() => DeliveryContext | null) | null = null;
  private flushing: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;
  private inFlightQueueId: string | null = null;
  private readonly pendingDurability = new Set<string>();

  constructor(options: OutboxOptions = {}) {
    this.path = options.path ?? DEFAULT_OUTBOX_PATH;
    this.maxBatches = Math.max(1, Math.floor(options.maxBatches ?? 500));
    this.now = options.now ?? Date.now;
    this.retryBaseMs = Math.max(1, options.retryBaseMs ?? 1_000);
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 300_000);
    this.onDiagnostic = options.onDiagnostic;
    this.writeState = options.writeState ?? defaultWriteState;
    this.state = this.readState();
    if (this.state.corruptFilesQuarantined > 0) this.persist();
  }

  configure(dispatcher: (() => DeliveryContext | null) | null): void {
    this.dispatcher = dispatcher;
    if (dispatcher && !this.disposed) this.schedule(0);
  }

  enqueue(destinationHash: string, batch: DurableTelemetryBatch): void {
    if (this.disposed) return;
    while (this.state.queue.length >= this.maxBatches) {
      const dropIndex = this.state.queue.findIndex((entry) => entry.queueId !== this.inFlightQueueId);
      if (dropIndex < 0) {
        this.state.droppedBatches += 1;
        this.state.overflowDroppedBatches += 1;
        this.diagnostic("overflow_dropped", 1);
        this.persist();
        return;
      }
      const [dropped] = this.state.queue.splice(dropIndex, 1);
      if (dropped) this.pendingDurability.delete(dropped.queueId);
      this.state.droppedBatches += 1;
      this.state.overflowDroppedBatches += 1;
      this.diagnostic("overflow_dropped", 1);
    }
    const enqueuedAt = new Date(this.now()).toISOString();
    const queueId = createHash("sha256")
      .update(`${destinationHash}\0${batch.producerInstanceId}\0${batch.events.map((event) => event.eventId).join("\0")}`)
      .digest("hex");
    this.state.queue.push({
      queueId,
      destinationHash,
      enqueuedAt,
      attempts: 0,
      nextAttemptAt: 0,
      batch,
    });
    this.pendingDurability.add(queueId);
    // Stable event ids are on disk before the first network attempt begins.
    this.persist();
    this.schedule(0);
  }

  status(): TelemetryOutboxStatus {
    const oldestQueuedAt = this.state.queue[0]?.enqueuedAt ?? null;
    const oldestMs = oldestQueuedAt ? Date.parse(oldestQueuedAt) : Number.NaN;
    return {
      queuedBatches: this.state.queue.length,
      oldestQueuedAt,
      oldestQueuedAgeMs: Number.isFinite(oldestMs) ? Math.max(0, this.now() - oldestMs) : null,
      droppedBatches: this.state.droppedBatches,
      overflowDroppedBatches: this.state.overflowDroppedBatches,
      destinationChangeDroppedBatches: this.state.destinationChangeDroppedBatches,
      rejectedEvents: this.state.rejectedEvents,
      failedAttempts: this.state.failedAttempts,
      persistenceFailures: this.state.persistenceFailures,
      nonDurableBatches: this.pendingDurability.size,
      corruptFilesQuarantined: this.state.corruptFilesQuarantined,
    };
  }

  async flushNow(): Promise<void> {
    if (this.disposed) return;
    if (this.flushing) return this.flushing;
    this.flushing = this.flushLoop().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flushing;
  }

  private async flushLoop(): Promise<void> {
    while (!this.disposed && this.state.queue.length > 0) {
      if (this.pendingDurability.size > 0 && !this.persist()) {
        this.schedule(this.retryBaseMs);
        return;
      }
      // Configuration is live.  Re-read it before every batch so a change
      // during an awaited request cannot route later batches to the old URL.
      const context = this.dispatcher?.() ?? null;
      if (!context) return;
      const mismatched = this.state.queue.filter((entry) => entry.destinationHash !== context.destinationHash);
      if (mismatched.length > 0) {
        const mismatchedIds = new Set(mismatched.map((entry) => entry.queueId));
        this.state.queue = this.state.queue.filter((entry) => !mismatchedIds.has(entry.queueId));
        for (const entry of mismatched) this.pendingDurability.delete(entry.queueId);
        this.state.droppedBatches += mismatched.length;
        this.state.destinationChangeDroppedBatches += mismatched.length;
        this.diagnostic("destination_changed", mismatched.length);
        if (!this.persist()) {
          this.schedule(this.retryBaseMs);
          return;
        }
        continue;
      }
      const entry = this.state.queue[0];
      const delay = entry.nextAttemptAt - this.now();
      if (delay > 0) {
        this.schedule(delay);
        return;
      }
      let result: TelemetryDeliveryResult;
      this.inFlightQueueId = entry.queueId;
      try {
        result = await context.deliver(entry.batch);
      } catch {
        result = { acknowledged: false, rejected: 0 };
      } finally {
        this.inFlightQueueId = null;
      }
      const liveIndex = this.state.queue.findIndex((queued) => queued.queueId === entry.queueId);
      if (result.acknowledged) {
        if (liveIndex >= 0) this.state.queue.splice(liveIndex, 1);
        this.pendingDurability.delete(entry.queueId);
        const rejected = Math.max(0, Math.floor(result.rejected || 0));
        this.state.rejectedEvents += rejected;
        if (rejected > 0) this.diagnostic("events_rejected", rejected);
        this.persist();
        continue;
      }
      if (liveIndex < 0) continue;
      const liveEntry = this.state.queue[liveIndex];
      liveEntry.attempts += 1;
      this.state.failedAttempts += 1;
      this.diagnostic("delivery_failed", 1);
      const backoff = Math.min(
        this.retryMaxMs,
        this.retryBaseMs * 2 ** Math.min(liveEntry.attempts - 1, 20),
      );
      liveEntry.nextAttemptAt = this.now() + backoff;
      this.persist();
      this.schedule(backoff);
      return;
    }
  }

  private schedule(delayMs: number): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushNow().catch(() => {
        this.state.failedAttempts += 1;
        this.diagnostic("delivery_failed", 1);
        this.schedule(this.retryBaseMs);
      });
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private readState(): StoredOutbox {
    if (!existsSync(this.path)) return emptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      const result = StoredOutboxSchema.safeParse(parsed);
      if (result.success) return result.data;
      throw new Error("invalid outbox shape");
    } catch {
      const state = emptyState();
      const quarantine = `${this.path}.corrupt-${this.now()}`;
      try {
        renameSync(this.path, quarantine);
        state.corruptFilesQuarantined = 1;
        this.diagnostic("corrupt_quarantined", 1);
      } catch {
        state.persistenceFailures = 1;
        this.diagnostic("persistence_failed", 1);
      }
      return state;
    }
  }

  private persist(): boolean {
    try {
      this.writeState(this.path, this.state);
      this.pendingDurability.clear();
      return true;
    } catch {
      this.state.persistenceFailures += 1;
      this.diagnostic("persistence_failed", 1);
      return false;
    }
  }

  private diagnostic(
    name: "delivery_failed" | "events_rejected" | "overflow_dropped" | "destination_changed" | "persistence_failed" | "corrupt_quarantined",
    count: number,
  ): void {
    try {
      this.onDiagnostic?.(name, count);
    } catch {
      // Diagnostic reporting must never interrupt queue persistence.
    }
  }
}
