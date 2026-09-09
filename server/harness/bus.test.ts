// The bus is the seam every client depends on: events must arrive
// stamped with their instanceId, cross-driver leaks must be dropped, and
// neither logging nor a broken listener may take down the stream.
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EVENTS_DIR, ensureDirs } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { EventBus } from "./bus.ts";

const testEvent = (over: Partial<RuntimeEvent> = {}): RuntimeEvent =>
  ({
    eventId: "ev-1",
    provider: "fake",
    threadId: "thread-1",
    createdAt: new Date().toISOString(),
    type: "turn.started",
    ...over,
  }) as RuntimeEvent;

async function liveInstance() {
  const fake = makeFakeDriver();
  await fake.driver.create({
    instanceId: "inst-1",
    displayName: undefined,
    environment: {},
    enabled: true,
    config: {},
  });
  return fake.created.get("inst-1")!;
}

describe("EventBus", () => {
  beforeEach(() => {
    rmSync(EVENTS_DIR, { recursive: true, force: true });
    ensureDirs();
  });

  it("stamps events from an attached adapter with the instanceId", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    emit(testEvent());
    expect(seen).toHaveLength(1);
    expect(seen[0].providerInstanceId).toBe("inst-1");
  });

  it("drops events claiming a different driver kind (cross-driver invariant)", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    emit(testEvent({ provider: "impostor" }));
    expect(seen).toHaveLength(0);
  });

  it("tees every published event to the per-thread NDJSON log", () => {
    const bus = new EventBus();
    bus.publish(testEvent({ threadId: "log-me" }));

    const logged = readFileSync(join(EVENTS_DIR, "log-me.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(logged).toHaveLength(1);
    expect(logged[0].type).toBe("turn.started");
  });

  it("redacts credential-shaped content before writing the NDJSON log", () => {
    const key = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const bus = new EventBus();
    bus.publish(testEvent({
      threadId: "redacted-log",
      type: "runtime.error",
      message: `provider returned ${key}`,
    }));

    const logged = readFileSync(join(EVENTS_DIR, "redacted-log.ndjson"), "utf8");
    expect(logged).not.toContain(key);
    expect(logged).toContain("«redacted");
  });

  it("reports an incomplete log once while continuing live delivery", () => {
    rmSync(EVENTS_DIR, { recursive: true, force: true });
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    bus.publish(testEvent());
    bus.publish(testEvent({ eventId: "ev-2", type: "turn.completed", ok: true }));

    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({
      type: "runtime.error",
      threadId: "thread-1",
      message: expect.stringContaining("event history is incomplete"),
    });
    expect(seen.slice(1).map((event) => event.eventId)).toEqual(["ev-1", "ev-2"]);
    expect(existsSync(EVENTS_DIR)).toBe(false);
  });

  it("writes the incomplete marker before the first event after logging recovers", () => {
    let failing = true;
    const writes: string[] = [];
    const append: typeof appendFileSync = vi.fn((...args: Parameters<typeof appendFileSync>) => {
      if (failing) throw new Error("disk full");
      writes.push(String(args[1]));
    });
    const bus = new EventBus(append);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    bus.publish(testEvent());
    failing = false;
    bus.publish(testEvent({ eventId: "ev-2", type: "turn.completed", ok: true }));
    bus.publish(testEvent({ eventId: "ev-3" }));

    const recovered = writes[0].trim().split("\n").map((line) => JSON.parse(line));
    expect(recovered.map((event) => event.type)).toEqual(["runtime.error", "turn.completed"]);
    expect(recovered[0].message).toContain("event history is incomplete");
    expect(writes[1].trim()).toContain('"eventId":"ev-3"');
    expect(seen.filter((event) => event.type === "runtime.error")).toHaveLength(1);
  });

  it("a throwing listener does not starve the others", () => {
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe(() => {
      throw new Error("bad listener");
    });
    bus.subscribe((e) => seen.push(e));

    bus.publish(testEvent());
    expect(seen).toHaveLength(1);
  });

  it("drops a SECOND turn.completed for the same turn (one terminal event per turn)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const terminal = testEvent({ type: "turn.completed", ok: true, turnId: "turn-1" });
    emit(terminal);
    emit({ ...terminal, eventId: "ev-2" });

    // Every consumer of turn.completed — the watchdog, the routine receipt,
    // the repeat detector, the usage fold — assumes it fires once.  A driver
    // that emits it twice settles a turn twice with no error anywhere, so
    // the bus says so instead of letting it through.
    expect(seen.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("second turn.completed"));
    errors.mockRestore();
  });

  it("delivers a terminal event for a DIFFERENT turn on the same thread", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    emit(testEvent({ type: "turn.completed", ok: true, turnId: "turn-1" }));
    emit(testEvent({ eventId: "ev-2", type: "turn.completed", ok: true, turnId: "turn-2" }));

    expect(seen.filter((e) => e.type === "turn.completed")).toHaveLength(2);
  });

  it("never guesses: a terminal event with no turnId is always delivered", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    emit(testEvent({ type: "turn.completed", ok: true }));
    emit(testEvent({ eventId: "ev-2", type: "turn.completed", ok: true }));

    expect(seen.filter((e) => e.type === "turn.completed")).toHaveLength(2);
  });

  it("unsubscribe and detachAll stop delivery", async () => {
    const { instance, emit } = await liveInstance();
    const bus = new EventBus();
    bus.attach([instance]);
    const seen: RuntimeEvent[] = [];
    const unsub = bus.subscribe((e) => seen.push(e));

    emit(testEvent());
    unsub();
    emit(testEvent());
    expect(seen).toHaveLength(1);

    const seenAfterDetach: RuntimeEvent[] = [];
    bus.subscribe((e) => seenAfterDetach.push(e));
    bus.detachAll();
    emit(testEvent());
    expect(seenAfterDetach).toHaveLength(0);
  });

  it("detach removes a single instance subscription without affecting others", async () => {
    const inst1 = await liveInstance();
    const fake2 = makeFakeDriver();
    await fake2.driver.create({
      instanceId: "inst-2",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: {},
    });
    const inst2 = fake2.created.get("inst-2")!;

    const bus = new EventBus();
    bus.attach([inst1.instance, inst2.instance]);
    const seen: RuntimeEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    bus.detach("inst-1");
    inst1.emit(testEvent());
    inst2.emit(testEvent());

    expect(seen).toHaveLength(1);
    expect(seen[0].providerInstanceId).toBe("inst-2");
  });
});
