import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  UsageTelemetryOutbox,
  usageTelemetryDestinationHash,
  type DurableTelemetryBatch,
} from "./telemetry-outbox.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "botfleet-telemetry-outbox-"));
  roots.push(root);
  return join(root, "outbox.json");
}

function batch(eventId = "bf:openai:bot-1:1:stable:in"): DurableTelemetryBatch {
  return {
    schemaVersion: 2,
    producerId: "botfleet",
    producerInstanceId: "test-mac",
    events: [{ eventId }],
  };
}

describe("UsageTelemetryOutbox", () => {
  it("persists stable event ids before the first send and removes only an acknowledged batch", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    const deliver = vi.fn(async (posted: DurableTelemetryBatch) => {
      const stored = JSON.parse(readFileSync(path, "utf8"));
      expect(stored.queue[0].batch.events[0].eventId).toBe(posted.events[0]?.eventId);
      return { acknowledged: true, rejected: 0 };
    });
    const outbox = new UsageTelemetryOutbox({ path });
    outbox.configure(() => ({ destinationHash, deliver }));

    outbox.enqueue(destinationHash, batch());
    await outbox.flushNow();

    expect(deliver).toHaveBeenCalledOnce();
    expect(outbox.status().queuedBatches).toBe(0);
    await outbox.dispose();
  });

  it("replays the same batch after a transient failure and process restart", async () => {
    const path = fixture();
    let now = 1_000;
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    const first = new UsageTelemetryOutbox({ path, now: () => now, retryBaseMs: 10 });
    first.configure(() => ({
      destinationHash,
      deliver: async () => ({ acknowledged: false, rejected: 0 }),
    }));
    first.enqueue(destinationHash, batch());
    await first.flushNow();
    expect(first.status()).toMatchObject({ queuedBatches: 1, failedAttempts: 1 });
    await first.dispose();

    now += 20;
    const delivered: DurableTelemetryBatch[] = [];
    const restarted = new UsageTelemetryOutbox({ path, now: () => now, retryBaseMs: 10 });
    expect(restarted.status().failedAttempts).toBe(1);
    restarted.configure(() => ({
      destinationHash,
      deliver: async (posted) => {
        delivered.push(posted);
        // A replay can be an ingest duplicate and is still an acknowledgement.
        return { acknowledged: true, rejected: 0 };
      },
    }));
    await restarted.flushNow();

    expect(delivered.map((posted) => posted.events[0]?.eventId)).toEqual([
      "bf:openai:bot-1:1:stable:in",
    ]);
    expect(restarted.status().queuedBatches).toBe(0);
    await restarted.dispose();
  });

  it("does not replay a queued batch to a changed destination", async () => {
    const path = fixture();
    const oldHash = usageTelemetryDestinationHash("https://old.example.com/api/ingest/usage");
    const newHash = usageTelemetryDestinationHash("https://new.example.com/api/ingest/usage");
    const outbox = new UsageTelemetryOutbox({ path });
    outbox.enqueue(oldHash, batch());
    const deliver = vi.fn(async () => ({ acknowledged: true, rejected: 0 }));
    outbox.configure(() => ({ destinationHash: newHash, deliver }));
    await outbox.flushNow();

    expect(deliver).not.toHaveBeenCalled();
    expect(outbox.status()).toMatchObject({ queuedBatches: 0, droppedBatches: 1 });
    await outbox.dispose();
  });

  it("bounds the queue by dropping the oldest batch with an explicit count", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    const outbox = new UsageTelemetryOutbox({ path, maxBatches: 2 });
    outbox.enqueue(destinationHash, batch("first"));
    outbox.enqueue(destinationHash, batch("second"));
    outbox.enqueue(destinationHash, batch("third"));

    expect(outbox.status()).toMatchObject({ queuedBatches: 2, droppedBatches: 1 });
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.queue.map((entry: { batch: DurableTelemetryBatch }) => entry.batch.events[0]?.eventId))
      .toEqual(["second", "third"]);
    await outbox.dispose();
  });

  it("removes an acknowledged rejection and retains its rejected-event count", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    const outbox = new UsageTelemetryOutbox({ path });
    outbox.configure(() => ({
      destinationHash,
      deliver: async () => ({ acknowledged: true, rejected: 3 }),
    }));
    outbox.enqueue(destinationHash, batch());
    await outbox.flushNow();

    expect(outbox.status()).toMatchObject({ queuedBatches: 0, rejectedEvents: 3 });
    await outbox.dispose();

    const restarted = new UsageTelemetryOutbox({ path });
    expect(restarted.status().rejectedEvents).toBe(3);
    await restarted.dispose();
  });

  it("protects the in-flight head when overflow drops an older unsent batch", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const delivered: string[] = [];
    const outbox = new UsageTelemetryOutbox({ path, maxBatches: 2 });
    outbox.configure(() => ({
      destinationHash,
      deliver: async (posted) => {
        const id = posted.events[0]?.eventId ?? "";
        delivered.push(id);
        if (id === "first") await firstGate;
        return { acknowledged: true, rejected: 0 };
      },
    }));
    outbox.enqueue(destinationHash, batch("first"));
    const flush = outbox.flushNow();
    await vi.waitFor(() => expect(delivered).toEqual(["first"]));
    outbox.enqueue(destinationHash, batch("second"));
    outbox.enqueue(destinationHash, batch("third"));
    releaseFirst();
    await flush;

    expect(delivered).toEqual(["first", "third"]);
    expect(outbox.status()).toMatchObject({ queuedBatches: 0, overflowDroppedBatches: 1 });
    await outbox.dispose();
  });

  it("re-reads configuration after an in-flight send and never sends later batches to the old destination", async () => {
    const path = fixture();
    const oldHash = usageTelemetryDestinationHash("https://old.example.com/api/ingest/usage");
    const newHash = usageTelemetryDestinationHash("https://new.example.com/api/ingest/usage");
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const oldDeliver = vi.fn(async (_posted: DurableTelemetryBatch) => {
      await oldGate;
      return { acknowledged: true, rejected: 0 };
    });
    const newDeliver = vi.fn(async (_posted: DurableTelemetryBatch) => ({ acknowledged: true, rejected: 0 }));
    let current = { destinationHash: oldHash, deliver: oldDeliver };
    const outbox = new UsageTelemetryOutbox({ path });
    outbox.configure(() => current);
    outbox.enqueue(oldHash, batch("old-in-flight"));
    const flush = outbox.flushNow();
    await vi.waitFor(() => expect(oldDeliver).toHaveBeenCalledOnce());
    outbox.enqueue(oldHash, batch("old-unsent"));
    current = { destinationHash: newHash, deliver: newDeliver };
    outbox.configure(() => current);
    outbox.enqueue(newHash, batch("new-unsent"));
    releaseOld();
    await flush;

    expect(oldDeliver).toHaveBeenCalledOnce();
    expect(newDeliver).toHaveBeenCalledOnce();
    expect(newDeliver.mock.calls[0]?.[0].events[0]?.eventId).toBe("new-unsent");
    expect(outbox.status()).toMatchObject({ queuedBatches: 0, destinationChangeDroppedBatches: 1 });
    await outbox.dispose();
  });

  it("does not throw or send a batch that could not be made durable", async () => {
    const path = fixture();
    const destinationHash = usageTelemetryDestinationHash("https://usage.example.com/api/ingest/usage");
    const deliver = vi.fn(async () => ({ acknowledged: true, rejected: 0 }));
    const outbox = new UsageTelemetryOutbox({
      path,
      retryBaseMs: 60_000,
      writeState: () => { throw new Error("disk full"); },
    });

    expect(() => outbox.enqueue(destinationHash, batch())).not.toThrow();
    outbox.configure(() => ({ destinationHash, deliver }));
    await outbox.flushNow();

    expect(deliver).not.toHaveBeenCalled();
    expect(outbox.status().nonDurableBatches).toBe(1);
    expect(outbox.status().persistenceFailures).toBeGreaterThan(0);
    await outbox.dispose();
  });

  it("quarantines a malformed queue instead of silently treating it as empty", async () => {
    const path = fixture();
    writeFileSync(path, JSON.stringify({ version: 2, queue: [{ bad: true }] }));
    const outbox = new UsageTelemetryOutbox({ path });

    expect(outbox.status()).toMatchObject({ queuedBatches: 0, corruptFilesQuarantined: 1 });
    expect(readdirSync(join(path, ".."))).toContainEqual(expect.stringMatching(/outbox\.json\.corrupt-/));
    await outbox.dispose();
  });
});
