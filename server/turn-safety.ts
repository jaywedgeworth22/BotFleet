import type { CloudBackend, ModelSelection } from "./contracts.ts";

/** The bot's computer settings as they were when a turn was dispatched, which
 * is what that turn mounted.  A later bot edit changes the stored grants but
 * not the live mounts, so a provider disable must be judged against these. */
export interface TurnComputerInputs {
  computers: readonly ("cloud" | "vm" | "local")[] | undefined;
  cloudBackend: CloudBackend | undefined;
  /** The destination an automation dispatched the turn to: a cloud routine,
   * webhook or resource trigger mounts the cloud computer whatever the bot's
   * own computers say. */
  runOn?: "maus" | "cloud";
  /** The providers the turn actually mounted, once its computers resolved.
   * Auto can fall back from an unavailable cloud computer to This Computer,
   * so the grant alone over-counts what the turn holds. */
  mounted?: readonly ("asciiBox" | "selfHostedVps" | "localVm" | "localMac")[];
}

export interface ActiveTurnOwner {
  dispatchId: number;
  botId: string;
  selection: ModelSelection;
  fallbackPolicy: ModelSelection;
  computerInputs?: TurnComputerInputs;
}

/** The engine/model that owns each live dispatch.  A fallback is a per-turn
 * override, so the persisted bot selection cannot answer this question.
 * Bot busy state permits one live dispatch per thread and provider instance;
 * reject a violated claim instead of letting a late completion settle a newer
 * owner.  EventBus separately rejects duplicate terminal events by turn id. */
export class ActiveTurnOwners {
  private readonly byThread = new Map<string, Map<string, ActiveTurnOwner>>();
  private readonly latestDispatchByThread = new Map<string, number>();
  private nextDispatchId = 1;

  claim(threadId: string, owner: Omit<ActiveTurnOwner, "dispatchId">): ActiveTurnOwner {
    let owners = this.byThread.get(threadId);
    if (!owners) {
      owners = new Map();
      this.byThread.set(threadId, owners);
    }
    if (owners.has(owner.selection.instanceId)) {
      throw new Error(
        `thread ${threadId} already has a live turn on provider instance ${owner.selection.instanceId}`,
      );
    }
    const claimed = { ...owner, dispatchId: this.nextDispatchId++ };
    owners.set(owner.selection.instanceId, claimed);
    this.latestDispatchByThread.set(threadId, claimed.dispatchId);
    return claimed;
  }

  /** Remains meaningful after settle: asynchronous provider calls can return
   * after their terminal event, and may update durable cursor state only when
   * no newer dispatch has claimed this conversation. */
  isLatest(threadId: string, dispatchId: number): boolean {
    return this.latestDispatchByThread.get(threadId) === dispatchId;
  }

  forEvent(threadId: string, providerInstanceId?: string): ActiveTurnOwner | undefined {
    const owners = this.byThread.get(threadId);
    if (!owners) return undefined;
    if (providerInstanceId) return owners.get(providerInstanceId);
    return owners.size === 1 ? owners.values().next().value : undefined;
  }

  current(threadId: string): ActiveTurnOwner | undefined {
    const owners = this.byThread.get(threadId);
    if (!owners) return undefined;
    return [...owners.values()].at(-1);
  }

  forBot(botId: string): (ActiveTurnOwner & { threadId: string }) | undefined {
    let latest: (ActiveTurnOwner & { threadId: string }) | undefined;
    for (const [threadId, owners] of this.byThread) {
      for (const owner of owners.values()) {
        if (owner.botId !== botId || (latest && owner.dispatchId <= latest.dispatchId)) continue;
        latest = { ...owner, threadId };
      }
    }
    return latest;
  }

  /** Record what a live dispatch actually mounted.  A dispatch that has
   * already settled, or been replaced, is left alone. */
  recordMounted(threadId: string, dispatchId: number, mounted: NonNullable<TurnComputerInputs["mounted"]>): void {
    const owners = this.byThread.get(threadId);
    if (!owners) return;
    for (const owner of owners.values()) {
      if (owner.dispatchId !== dispatchId) continue;
      owner.computerInputs = {
        ...(owner.computerInputs ?? { computers: undefined, cloudBackend: undefined }),
        mounted: [...mounted],
      };
    }
  }

  threadForBot(botId: string): string | undefined {
    return this.forBot(botId)?.threadId;
  }

  settle(threadId: string, providerInstanceId?: string): ActiveTurnOwner | undefined {
    const owner = this.forEvent(threadId, providerInstanceId);
    if (!owner) return undefined;
    const owners = this.byThread.get(threadId)!;
    owners.delete(owner.selection.instanceId);
    if (owners.size === 0) this.byThread.delete(threadId);
    return owner;
  }

  clearThread(threadId: string): void {
    this.byThread.delete(threadId);
  }
}

export interface ExactTurnLease {
  readonly botId: string;
  readonly threadId: string;
  readonly dispatchId: number;
}

/** A resource marker owned by one exact dispatch.  A later turn may reuse the
 * same bot and thread before an older asynchronous finalizer finishes, so a
 * thread id alone is not an ownership token. */
export class ExactTurnLeases {
  private readonly byBot = new Map<string, ExactTurnLease>();

  claim(botId: string, threadId: string, dispatchId: number): ExactTurnLease {
    const lease = { botId, threadId, dispatchId };
    this.byBot.set(botId, lease);
    return lease;
  }

  forBot(botId: string): ExactTurnLease | undefined {
    return this.byBot.get(botId);
  }

  hasBot(botId: string): boolean {
    return this.byBot.has(botId);
  }

  release(lease: ExactTurnLease): boolean {
    if (this.byBot.get(lease.botId) !== lease) return false;
    return this.byBot.delete(lease.botId);
  }

  clearBot(botId: string): void {
    this.byBot.delete(botId);
  }

  get size(): number {
    return this.byBot.size;
  }
}

/** One claim in a `TurnOwnerClaims` map, with the pair that owns it. */
export interface TurnOwnerClaim<T> {
  readonly threadId: string;
  readonly botId: string;
  readonly value: T;
}

/** A per-turn resource held against a THREAD AND A BOT rather than a thread.
 *
 * A 1:1 thread has exactly one bot, so for that lane the two keys are the same
 * key.  A room thread is shared by every member, and nothing serializes them
 * at the thread level: `drainRoomQueue` starts every eligible queued round in
 * one pass and `runGroupMemberTurn`'s only entry guard is the per-bot
 * `bot.busy`, so two members really can be in flight on one thread at once.
 * Keyed by thread alone, the second member's claim evicted the first — one
 * resource stranded until the harness restarts, the other handed back while
 * its turn was still using it.
 *
 * Some callers know only the thread: `turn.completed` is a thread-keyed event
 * and names no speaker.  Those use `releaseSoleOwner`, which releases when the
 * thread holds exactly one claim and DECLINES rather than guess when it holds
 * two — the dispatches themselves release their own exact keys, so declining
 * costs nothing and guessing wrong takes a container away from a live turn. */
export class TurnOwnerClaims<T> {
  private readonly byKey = new Map<string, TurnOwnerClaim<T>>();

  // Length-prefixed rather than delimited, because both ids are opaque
  // strings: a thread called `a:b` with a bot called `c` must not land on
  // the same key as a thread called `a` with a bot called `b:c`.
  private static key(threadId: string, botId: string): string {
    return `${threadId.length}:${threadId}:${botId}`;
  }

  set(threadId: string, botId: string, value: T): void {
    this.byKey.set(TurnOwnerClaims.key(threadId, botId), { threadId, botId, value });
  }

  get(threadId: string, botId: string): T | undefined {
    return this.byKey.get(TurnOwnerClaims.key(threadId, botId))?.value;
  }

  /** Take back one exact claim, returning what it held so the caller can
   * unwind it — or undefined when that pair holds nothing. */
  release(threadId: string, botId: string): T | undefined {
    const key = TurnOwnerClaims.key(threadId, botId);
    const claim = this.byKey.get(key);
    if (!claim) return undefined;
    this.byKey.delete(key);
    return claim.value;
  }

  /** Take back the claim on a thread that has exactly one, for a caller that
   * knows the thread but not the speaker.  Undefined when the thread holds
   * none, and undefined when it holds more than one. */
  releaseSoleOwner(threadId: string): T | undefined {
    const owners = this.ownersOf(threadId);
    if (owners.length !== 1) return undefined;
    return this.release(threadId, owners[0]!);
  }

  /** Every bot holding a claim on this thread. */
  ownersOf(threadId: string): string[] {
    const owners: string[] = [];
    for (const claim of this.byKey.values()) if (claim.threadId === threadId) owners.push(claim.botId);
    return owners;
  }

  /** Any one claim on this thread, for callers that only need to know whether
   * the thread is holding something — the runtime-event touch, which keeps a
   * live claim from expiring and does not care whose it is. */
  anyOnThread(threadId: string): T | undefined {
    for (const claim of this.byKey.values()) if (claim.threadId === threadId) return claim.value;
    return undefined;
  }

  /** The bot's claim, whichever thread it is on — what a provider reload has
   * to go on, since it clears a bot rather than a conversation. */
  findByBot(botId: string): TurnOwnerClaim<T> | undefined {
    for (const claim of this.byKey.values()) if (claim.botId === botId) return claim;
    return undefined;
  }

  get size(): number {
    return this.byKey.size;
  }
}

export interface AutoFallbackCandidate {
  instanceId: string;
  enabled?: boolean;
  snapshot: {
    state: "available" | "unavailable";
    authenticated?: boolean;
    quota?: {
      capped: boolean;
      models?: Record<string, { capped: boolean }>;
    };
  };
  models: { default: string };
}

/** Preserve the existing one-hop automatic failover while refusing candidates
 * a recent engine probe or cooldown registry says cannot take the turn. */
export function eligibleAutoFallbackChain(
  candidates: readonly AutoFallbackCandidate[],
  input: {
    botId: string;
    currentInstanceId: string;
    isCooling: (botId: string, instanceId: string, model: string) => boolean;
    priority: readonly string[];
  },
): ModelSelection[] {
  const viable = candidates
    .map((candidate, order) => ({ candidate, order }))
    .filter(({ candidate }) => {
      const model = candidate.models.default;
      return (
        candidate.instanceId !== input.currentInstanceId &&
        candidate.enabled !== false &&
        candidate.snapshot.state === "available" &&
        candidate.snapshot.authenticated !== false &&
        candidate.snapshot.quota?.capped !== true &&
        candidate.snapshot.quota?.models?.[model]?.capped !== true &&
        Boolean(model) &&
        !input.isCooling(input.botId, candidate.instanceId, model)
      );
    })
    .sort((a, b) => {
      const rank = (instanceId: string) => {
        const index = input.priority.indexOf(instanceId);
        return index === -1 ? input.priority.length : index;
      };
      return rank(a.candidate.instanceId) - rank(b.candidate.instanceId) || a.order - b.order;
    });
  const pick = viable[0]?.candidate;
  return pick ? [{ instanceId: pick.instanceId, model: pick.models.default }] : [];
}

export interface ThreadRuntimeInstance {
  instanceId: string;
  adapter: {
    hasSession(threadId: string): boolean;
    interruptTurn(threadId: string): Promise<void>;
  };
}

export interface ThreadOwnerInspection {
  owners: ThreadRuntimeInstance[];
  inspectionFailed: boolean;
}

export type StalledReleaseDecision = "release" | "retry" | "superseded";

/** A missing terminal event needs repeated ownership checks: a child may take
 * longer than the first grace window to exit.  A newer dispatch ends the old
 * recovery loop, while live or uncertain ownership keeps it retrying. */
export function stalledReleaseDecision(
  newerTurnWatching: boolean,
  inspection: ThreadOwnerInspection,
  completionPending = false,
): StalledReleaseDecision {
  if (newerTurnWatching) return "superseded";
  if (completionPending || inspection.inspectionFailed || inspection.owners.length > 0) return "retry";
  return "release";
}

/** Keep one recheck outstanding while an old provider still owns the thread.
 * Back off to a bounded interval, and stop as soon as ownership
 * is released or a newer dispatch supersedes this recovery. */
export function scheduleStalledReleaseRecheck(
  attempt: () => StalledReleaseDecision,
  schedule: (callback: () => void, delayMs: number) => void,
  delayMs = 6_000,
  maxDelayMs = 60_000,
): void {
  schedule(() => {
    if (attempt() !== "retry") return;
    scheduleStalledReleaseRecheck(attempt, schedule, Math.min(delayMs * 2, maxDelayMs), maxDelayMs);
  }, delayMs);
}

export function mayReleaseStalledTurn(
  newerTurnWatching: boolean,
  inspection: ThreadOwnerInspection,
  completionPending = false,
): boolean {
  return stalledReleaseDecision(newerTurnWatching, inspection, completionPending) === "release";
}

export interface InterruptOutcome {
  stopped: boolean;
  refused: boolean;
  ownerCount: number;
  inspectionFailed: boolean;
}

export function inspectThreadOwners(
  instances: readonly ThreadRuntimeInstance[],
  threadId: string,
  onError: (instanceId: string, error: Error) => void = () => undefined,
): ThreadOwnerInspection {
  const owners: ThreadRuntimeInstance[] = [];
  let inspectionFailed = false;
  for (const instance of instances) {
    try {
      if (instance.adapter.hasSession(threadId)) owners.push(instance);
    } catch (error) {
      inspectionFailed = true;
      onError(instance.instanceId, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return { owners, inspectionFailed };
}

export async function interruptThreadOwners(
  instances: readonly ThreadRuntimeInstance[],
  threadId: string,
  onInspectError?: (instanceId: string, error: Error) => void,
  onInterruptError: (instanceId: string, error: Error) => void = () => undefined,
): Promise<InterruptOutcome> {
  const inspection = inspectThreadOwners(instances, threadId, onInspectError);
  const results = await Promise.all(
    inspection.owners.map(async (instance) => {
      try {
        await instance.adapter.interruptTurn(threadId);
        return true;
      } catch (error) {
        onInterruptError(instance.instanceId, error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    }),
  );
  const stopped = results.some(Boolean);
  return {
    stopped,
    refused: !stopped && results.some((ok) => !ok),
    ownerCount: inspection.owners.length,
    inspectionFailed: inspection.inspectionFailed,
  };
}
