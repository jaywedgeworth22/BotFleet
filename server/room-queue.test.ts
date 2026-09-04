// A round that arrives while its bot is busy must WAIT, not vanish.
import { beforeEach, describe, expect, it } from "vitest";

import {
  cancelRoomRounds,
  drainRoomRounds,
  queueRoomRound,
  ROOM_QUEUE_MAX,
  ROOM_QUEUE_TTL_MS,
  _queuedRoomCount,
  _resetRoomQueue,
  type RoomQueueStore,
} from "./room-queue.ts";

const NOW = 1_700_000_000_000;

function storeWith(bots: Record<string, { busy?: boolean }>, groups: string[] = ["room"]): RoomQueueStore {
  return {
    bot: (botId) => (bots[botId] ? { id: botId, ...bots[botId] } : null),
    group: (groupId) => (groups.includes(groupId) ? { id: groupId } : undefined),
  };
}

const round = (overrides: Partial<Parameters<typeof queueRoomRound>[0]> = {}) => ({
  groupId: "room",
  threadId: "t1",
  botId: "director",
  hop: 0,
  ...overrides,
});

describe("room round queue", () => {
  beforeEach(() => _resetRoomQueue());

  it("holds a round for a busy bot and runs it once the bot settles", () => {
    expect(queueRoomRound(round(), NOW)).toBe(true);

    const ran: string[] = [];
    drainRoomRounds(storeWith({ director: { busy: true } }), NOW, (r) => { ran.push(r.threadId); });
    expect(ran).toEqual([]);
    expect(_queuedRoomCount()).toBe(1);

    drainRoomRounds(storeWith({ director: { busy: false } }), NOW, (r) => { ran.push(r.threadId); });
    expect(ran).toEqual(["t1"]);
    expect(_queuedRoomCount()).toBe(0);
  });

  it("keeps one entry per bot per thread — asking twice does not mean speaking twice", () => {
    expect(queueRoomRound(round(), NOW)).toBe(true);
    expect(queueRoomRound(round(), NOW + 10)).toBe(false);
    expect(_queuedRoomCount()).toBe(1);
  });

  it("keeps separate entries for two members of one room waiting on two bots", () => {
    expect(queueRoomRound(round({ botId: "director" }), NOW)).toBe(true);
    expect(queueRoomRound(round({ botId: "builder" }), NOW)).toBe(true);

    const ran: string[] = [];
    drainRoomRounds(storeWith({ director: {}, builder: {} }), NOW, (r) => { ran.push(r.botId); });
    expect(ran.sort()).toEqual(["builder", "director"]);
  });

  it("carries the comms depth, so a resumed round still terminates a bot⇄bot chain", () => {
    queueRoomRound(round({ hop: 2, cardContinuation: "yes" }), NOW);
    const seen: Array<{ hop: number; cardContinuation?: string }> = [];
    drainRoomRounds(storeWith({ director: {} }), NOW, (r) => {
      seen.push({ hop: r.hop, cardContinuation: r.cardContinuation });
    });
    expect(seen).toEqual([{ hop: 2, cardContinuation: "yes" }]);
  });

  it("drops a round that waited past its welcome rather than speaking into a moved-on room", () => {
    queueRoomRound(round(), NOW);
    const ran: string[] = [];
    drainRoomRounds(storeWith({ director: {} }), NOW + ROOM_QUEUE_TTL_MS + 1, (r) => { ran.push(r.threadId); });
    expect(ran).toEqual([]);
    expect(_queuedRoomCount()).toBe(0);
  });

  it("forgets a round whose bot or room was deleted while it waited", () => {
    queueRoomRound(round({ botId: "gone" }), NOW);
    queueRoomRound(round({ threadId: "t2", groupId: "deleted-room" }), NOW);

    const ran: string[] = [];
    drainRoomRounds(storeWith({ director: {} }, ["room"]), NOW, (r) => { ran.push(r.threadId); });
    expect(ran).toEqual([]);
    expect(_queuedRoomCount()).toBe(0);
  });

  it("takes an entry out of the map before running it, so two settles cannot fire it twice", () => {
    queueRoomRound(round(), NOW);
    const store = storeWith({ director: {} });
    let reentered = 0;
    drainRoomRounds(store, NOW, () => {
      // a settle racing this one
      drainRoomRounds(store, NOW, () => { reentered += 1; });
    });
    expect(reentered).toBe(0);
  });

  it("stops growing at the backstop rather than queueing forever", () => {
    for (let i = 0; i < ROOM_QUEUE_MAX; i++) {
      expect(queueRoomRound(round({ threadId: `t${i}` }), NOW)).toBe(true);
    }
    expect(queueRoomRound(round({ threadId: "one-too-many" }), NOW)).toBe(false);
    expect(_queuedRoomCount()).toBe(ROOM_QUEUE_MAX);
  });

  it("cancels every round in a room when the person stops it", () => {
    queueRoomRound(round({ botId: "director" }), NOW);
    queueRoomRound(round({ botId: "builder" }), NOW);
    queueRoomRound(round({ groupId: "other", threadId: "t9" }), NOW);

    expect(cancelRoomRounds((r) => r.groupId === "room")).toBe(2);
    expect(_queuedRoomCount()).toBe(1);
  });

  it("cancels only the deleted task's rounds", () => {
    queueRoomRound(round({ threadId: "t1" }), NOW);
    queueRoomRound(round({ threadId: "t2" }), NOW);
    expect(cancelRoomRounds((r) => r.threadId === "t2")).toBe(1);

    const ran: string[] = [];
    drainRoomRounds(storeWith({ director: {} }), NOW, (r) => { ran.push(r.threadId); });
    expect(ran).toEqual(["t1"]);
  });
});
