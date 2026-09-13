import { describe, expect, it, vi } from "vitest";

import {
  ActiveTurnOwners,
  ExactTurnLeases,
  eligibleAutoFallbackChain,
  inspectThreadOwners,
  interruptThreadOwners,
  mayReleaseStalledTurn,
  scheduleStalledReleaseRecheck,
  stalledReleaseDecision,
  type AutoFallbackCandidate,
  type StalledReleaseDecision,
  type ThreadRuntimeInstance,
} from "./turn-safety.ts";
import { vpsAliasChangeError, VPS_ALIAS_CHANGE_ERROR } from "./cloud-backend.ts";

const candidate = (
  instanceId: string,
  patch: Partial<AutoFallbackCandidate> = {},
): AutoFallbackCandidate => ({
  instanceId,
  models: { default: `${instanceId}-model` },
  snapshot: { state: "available", authenticated: true },
  ...patch,
});

describe("active turn ownership", () => {
  it("attributes a fallback completion to the dispatched override and preserves a newer owner", () => {
    const owners = new ActiveTurnOwners();
    const policy = {
      instanceId: "primary",
      model: "primary-model",
      fallbacks: [{ instanceId: "fallback", model: "fallback-model" }],
    };
    owners.claim("thread-1", {
      botId: "bot-1",
      selection: policy,
      fallbackPolicy: policy,
    });
    owners.claim("thread-1", {
      botId: "bot-1",
      selection: policy.fallbacks[0],
      fallbackPolicy: policy,
    });

    expect(owners.forEvent("thread-1", "fallback")?.selection).toEqual(policy.fallbacks[0]);
    expect(owners.settle("thread-1", "primary")?.selection.instanceId).toBe("primary");
    expect(owners.current("thread-1")?.selection.instanceId).toBe("fallback");
    expect(owners.threadForBot("bot-1")).toBe("thread-1");
    expect(owners.forBot("bot-1")?.selection.instanceId).toBe("fallback");
  });

  it("rejects two live claims for the same thread and provider instance", () => {
    const owners = new ActiveTurnOwners();
    const selection = { instanceId: "primary", model: "primary-model" };
    owners.claim("thread-1", { botId: "bot-1", selection, fallbackPolicy: selection });

    expect(() => owners.claim("thread-1", {
      botId: "bot-1",
      selection: { ...selection, model: "newer-model" },
      fallbackPolicy: selection,
    })).toThrow(/already has a live turn/);
    expect(owners.current("thread-1")?.selection.model).toBe("primary-model");
  });

  it("gives a later same-thread dispatch a distinct generation", () => {
    const owners = new ActiveTurnOwners();
    const selection = { instanceId: "primary", model: "primary-model" };
    const first = owners.claim("thread-1", { botId: "bot-1", selection, fallbackPolicy: selection });
    owners.settle("thread-1", selection.instanceId);
    const next = owners.claim("thread-1", { botId: "bot-1", selection, fallbackPolicy: selection });

    expect(next.dispatchId).not.toBe(first.dispatchId);
    expect(owners.isLatest("thread-1", first.dispatchId)).toBe(false);
    expect(owners.isLatest("thread-1", next.dispatchId)).toBe(true);
    owners.settle("thread-1", selection.instanceId);
    expect(owners.isLatest("thread-1", first.dispatchId)).toBe(false);
    expect(owners.isLatest("thread-1", next.dispatchId)).toBe(true);
    expect(mayReleaseStalledTurn(next.dispatchId !== first.dispatchId, {
      owners: [],
      inspectionFailed: false,
    })).toBe(false);
  });
});

describe("exact turn leases", () => {
  it("does not let an older finalizer release a successor on the same bot and thread", () => {
    const leases = new ExactTurnLeases();
    const oldLease = leases.claim("bot-1", "thread-1", 1);
    const releaseOldFinalScreenshot = () => leases.release(oldLease);
    const successor = leases.claim("bot-1", "thread-1", 2);

    expect(releaseOldFinalScreenshot()).toBe(false);
    expect(leases.forBot("bot-1")).toBe(successor);
    expect(vpsAliasChangeError("old-vps", "new-vps", leases.size > 0)).toBe(VPS_ALIAS_CHANGE_ERROR);
    expect(leases.release(successor)).toBe(true);
    expect(leases.size).toBe(0);
  });
});

describe("automatic fallback eligibility", () => {
  it("skips unavailable, signed-out, capped, and cooling engines without disturbing stable priority", () => {
    const cooling = new Set(["cooling:cooling-model"]);
    const chain = eligibleAutoFallbackChain(
      [
        candidate("current"),
        candidate("unavailable", { snapshot: { state: "unavailable" } }),
        candidate("signed-out", { snapshot: { state: "available", authenticated: false } }),
        candidate("capped", { snapshot: { state: "available", quota: { capped: true } } }),
        candidate("model-capped", {
          snapshot: {
            state: "available",
            quota: { capped: false, models: { "model-capped-model": { capped: true } } },
          },
        }),
        candidate("cooling"),
        candidate("second"),
        candidate("first"),
      ],
      {
        botId: "bot-1",
        currentInstanceId: "current",
        isCooling: (_botId, instanceId, model) => cooling.has(`${instanceId}:${model}`),
        priority: ["unavailable", "signed-out", "capped", "model-capped", "cooling", "first", "second"],
      },
    );

    expect(chain).toEqual([{ instanceId: "first", model: "first-model" }]);
  });

  it("keeps registry order when viable candidates have equal priority", () => {
    expect(eligibleAutoFallbackChain(
      [candidate("custom-b"), candidate("custom-a")],
      {
        botId: "bot-1",
        currentInstanceId: "current",
        isCooling: () => false,
        priority: ["claude", "codex"],
      },
    )).toEqual([{ instanceId: "custom-b", model: "custom-b-model" }]);
  });

  it("treats a MiniMax candidate as eligible when its chat model is uncapped, regardless of an unrelated video-pool exhaustion", () => {
    // server/harness/registry.ts maps MiniMax's "general" (chat) pool onto
    // every catalog model id and keeps other pools ("video", …) out of
    // `models` entirely — this pins that THIS function (keying strictly by
    // `candidate.models.default`, i.e. a catalog model id) reads that
    // shape correctly: a video pool being exhausted must never surface
    // here at all, since it was never placed under any model id.
    const chain = eligibleAutoFallbackChain(
      [
        candidate("current"),
        candidate("minimax", {
          models: { default: "MiniMax-M3" },
          snapshot: {
            state: "available",
            quota: { capped: false, models: { "MiniMax-M3": { capped: false } } },
          },
        }),
      ],
      {
        botId: "bot-1",
        currentInstanceId: "current",
        isCooling: () => false,
        priority: ["minimax"],
      },
    );
    expect(chain).toEqual([{ instanceId: "minimax", model: "MiniMax-M3" }]);
  });

  it("excludes a MiniMax candidate whose chat model IS capped, keyed by the catalog model id", () => {
    const chain = eligibleAutoFallbackChain(
      [
        candidate("current"),
        candidate("minimax", {
          models: { default: "MiniMax-M3" },
          snapshot: {
            state: "available",
            quota: { capped: false, models: { "MiniMax-M3": { capped: true } } },
          },
        }),
      ],
      {
        botId: "bot-1",
        currentInstanceId: "current",
        isCooling: () => false,
        priority: ["minimax"],
      },
    );
    expect(chain).toEqual([]);
  });
});

describe("runtime-owner interruption", () => {
  const runtime = (
    instanceId: string,
    hasSession: () => boolean,
    interruptTurn: () => Promise<void> = async () => undefined,
  ): ThreadRuntimeInstance => ({
    instanceId,
    adapter: { hasSession, interruptTurn: vi.fn(interruptTurn) },
  });

  it("reports an inspection failure so a watchdog cannot release uncertain ownership", () => {
    const onError = vi.fn();
    const inspection = inspectThreadOwners([
      runtime("broken", () => { throw new Error("probe failed"); }),
      runtime("owner", () => true),
    ], "thread-1", onError);

    expect(inspection.owners.map((owner) => owner.instanceId)).toEqual(["owner"]);
    expect(inspection.inspectionFailed).toBe(true);
    expect(onError).toHaveBeenCalledWith("broken", expect.any(Error));
  });

  it("releases only after every owner exited and no newer dispatch is watched", () => {
    const noOwners = { owners: [], inspectionFailed: false };
    expect(mayReleaseStalledTurn(false, noOwners)).toBe(true);
    expect(stalledReleaseDecision(false, noOwners)).toBe("release");
    expect(mayReleaseStalledTurn(true, noOwners)).toBe(false);
    expect(stalledReleaseDecision(true, noOwners)).toBe("superseded");
    const liveOwner = { owners: [runtime("live", () => true)], inspectionFailed: false };
    expect(mayReleaseStalledTurn(false, liveOwner)).toBe(false);
    expect(stalledReleaseDecision(false, liveOwner)).toBe("retry");
    const uncertain = { owners: [], inspectionFailed: true };
    expect(mayReleaseStalledTurn(false, uncertain)).toBe(false);
    expect(stalledReleaseDecision(false, uncertain)).toBe("retry");
    expect(stalledReleaseDecision(false, noOwners, true)).toBe("retry");
  });

  it("rechecks retained ownership with bounded backoff until release", () => {
    const decisions: StalledReleaseDecision[] = ["retry", "retry", "retry", "retry", "retry", "release"];
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    scheduleStalledReleaseRecheck(
      () => decisions.shift() ?? "release",
      (callback, delayMs) => scheduled.push({ callback, delayMs }),
    );

    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([6_000]);
    scheduled.shift()!.callback();
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([12_000]);
    scheduled.shift()!.callback();
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([24_000]);
    scheduled.shift()!.callback();
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([48_000]);
    scheduled.shift()!.callback();
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([60_000]);
    scheduled.shift()!.callback();
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([60_000]);
    scheduled.shift()!.callback();
    expect(scheduled).toEqual([]);
  });

  it("stops rechecking when a newer dispatch supersedes the stalled turn", () => {
    const scheduled: Array<() => void> = [];
    scheduleStalledReleaseRecheck(
      () => "superseded",
      (callback) => scheduled.push(callback),
    );
    scheduled.shift()!();
    expect(scheduled).toEqual([]);
  });

  it("distinguishes a refused stop from an owner that actually accepted interruption", async () => {
    const refused = runtime("refused", () => true, async () => { throw new Error("still live"); });
    const stopped = runtime("stopped", () => true);
    const onError = vi.fn();

    await expect(interruptThreadOwners([refused], "thread-1", undefined, onError)).resolves.toEqual({
      stopped: false,
      refused: true,
      ownerCount: 1,
      inspectionFailed: false,
    });
    await expect(interruptThreadOwners([refused, stopped], "thread-1")).resolves.toEqual({
      stopped: true,
      refused: false,
      ownerCount: 2,
      inspectionFailed: false,
    });
    expect(onError).toHaveBeenCalledWith("refused", expect.any(Error));
  });
});
