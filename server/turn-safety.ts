import type { ModelSelection } from "./contracts.ts";

export interface ActiveTurnOwner {
  dispatchId: number;
  botId: string;
  selection: ModelSelection;
  fallbackPolicy: ModelSelection;
}

/** The engine/model that owns each live dispatch.  A fallback is a per-turn
 * override, so the persisted bot selection cannot answer this question.
 * Bot busy state permits one live dispatch per thread and provider instance;
 * reject a violated claim instead of letting a late completion settle a newer
 * owner.  EventBus separately rejects duplicate terminal events by turn id. */
export class ActiveTurnOwners {
  private readonly byThread = new Map<string, Map<string, ActiveTurnOwner>>();
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
    return claimed;
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
): StalledReleaseDecision {
  if (newerTurnWatching) return "superseded";
  if (inspection.inspectionFailed || inspection.owners.length > 0) return "retry";
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
): boolean {
  return stalledReleaseDecision(newerTurnWatching, inspection) === "release";
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
