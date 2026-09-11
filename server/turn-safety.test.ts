import { describe, expect, it, vi } from "vitest";

import {
  ActiveTurnOwners,
  eligibleAutoFallbackChain,
  inspectThreadOwners,
  interruptThreadOwners,
  mayReleaseStalledTurn,
  type AutoFallbackCandidate,
  type ThreadRuntimeInstance,
} from "./turn-safety.ts";

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
    expect(mayReleaseStalledTurn(next.dispatchId !== first.dispatchId, {
      owners: [],
      inspectionFailed: false,
    })).toBe(false);
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
    expect(mayReleaseStalledTurn(true, noOwners)).toBe(false);
    expect(mayReleaseStalledTurn(false, { owners: [runtime("live", () => true)], inspectionFailed: false })).toBe(false);
    expect(mayReleaseStalledTurn(false, { owners: [], inspectionFailed: true })).toBe(false);
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
