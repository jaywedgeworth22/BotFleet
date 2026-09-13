// The registry's contract is forward/backward compatibility: a config
// written by a newer or differently-built app must load as an
// unavailable shadow, never crash the fleet. These tests pin that.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setLastAntigravityQuotaSnapshot } from "../antigravity-quota.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { ProviderRegistry } from "./registry.ts";

// registry.ts resolves MiniMax's key from ~/.mmx/config.json / process env —
// stubbed here so a real key sitting in either on the machine running these
// tests can never make describe() reach the real network. getMiniMaxBalance
// itself is mocked per-test below.
vi.mock("../drivers/minimax.ts", () => ({
  loadLocalMiniMaxConfig: () => ({ apiKey: "", url: "https://api.minimax.io/v1", defaultModel: "" }),
  // vi.fn (not a plain arrow) so tests can inspect what it was called
  // WITH — the resolved key stays a constant, but the environment argument
  // is the real per-instance value registry.ts passed in.
  resolveMinimaxCredentials: vi.fn(() => "test-minimax-key"),
}));
vi.mock("../minimax-balance.ts", () => ({
  getMiniMaxBalance: vi.fn(),
  // registry.ts also imports this — an incomplete mock module would leave
  // it `undefined` and throw inside describeEntry's try/catch, silently
  // reporting every MiniMax instance as unavailable instead of failing the
  // test loudly. Real value: same as loadLocalMiniMaxConfig's mock above.
  getCachedLocalMiniMaxConfig: () => ({ apiKey: "", url: "https://api.minimax.io/v1", defaultModel: "" }),
}));

import { resolveMinimaxCredentials } from "../drivers/minimax.ts";
import { getMiniMaxBalance } from "../minimax-balance.ts";

describe("ProviderRegistry", () => {
  it("creates live instances for known drivers", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake", displayName: "Bot A" } });

    const live = registry.get("a");
    expect(live).not.toBeNull();
    expect(live!.driverKind).toBe("fake");
    expect(live!.displayName).toBe("Bot A");
    expect(registry.instances()).toHaveLength(1);
  });

  it("uses defaultConfig when the entry has no config", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    // decodeConfig must NOT have been called — defaultConfig() is used verbatim
    expect(fake.decodedConfigs).toHaveLength(0);
    expect(registry.get("a")).not.toBeNull();
  });

  it("reports cli as overridden only when the raw config sets it", async () => {
    // Regression: override detection used to read the DECODED config, whose
    // cli field is always filled in with the driver default — every instance
    // then showed as "custom" though nothing was touched.
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      untouched: { driver: "fake", config: { other: true } },
      overridden: { driver: "fake", config: { cli: "/opt/fake/custom-bin" } },
      bare: { driver: "fake" },
    });

    const described = Object.fromEntries((await registry.describe()).map((d) => [d.instanceId, d]));
    expect(described.untouched.cli).toBeUndefined();
    expect(described.bare.cli).toBeUndefined();
    expect(described.overridden.cli).toBe("/opt/fake/custom-bin");
    expect(described.untouched.cliDefault).toBe("fakebin");
    expect(described.untouched.access).toBe("subscription");
  });

  it("publishes custom-only access from driver metadata", async () => {
    const fake = makeFakeDriver();
    Object.assign(fake.driver.metadata, { access: "custom" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ local: { driver: "fake" } });
    const [described] = await registry.describe();
    expect(described.access).toBe("custom");
  });

  it("keeps an unknown driver as an unavailable shadow instead of failing", async () => {
    const registry = new ProviderRegistry([makeFakeDriver().driver]);
    await registry.load({ mystery: { driver: "from-the-future", displayName: "Tomorrow" } });

    expect(registry.get("mystery")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot.state).toBe("unavailable");
    expect(described.snapshot.reason).toContain("from-the-future");
    expect(described.displayName).toBe("Tomorrow");
    expect(described.models.options).toHaveLength(0);
  });

  it("downgrades a config-decode failure to a shadow with the error as reason", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ broken: { driver: "fake", config: { bad: true } } });

    expect(registry.get("broken")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "fake: bad config" });
  });

  it("downgrades a create() rejection to a shadow without touching siblings", async () => {
    const good = makeFakeDriver({ kind: "good" });
    const flaky = makeFakeDriver({ kind: "flaky", failCreate: "boom at create" });
    const registry = new ProviderRegistry([good.driver, flaky.driver]);
    await registry.load({
      g: { driver: "good" },
      f: { driver: "flaky" },
    });

    expect(registry.get("g")).not.toBeNull();
    expect(registry.get("f")).toBeNull();
    const described = await registry.describe();
    const f = described.find((d) => d.instanceId === "f")!;
    expect(f.snapshot).toMatchObject({ state: "unavailable", reason: "boom at create" });
  });

  it("describe() reports a snapshot() failure as unavailable rather than throwing", async () => {
    const fake = makeFakeDriver({ failSnapshot: "provider probe exploded" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "provider probe exploded" });
  });

  it("forwards a live instance's declared effort levels in describe()", async () => {
    const fake = makeFakeDriver({ effortLevels: ["low", "high"] });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toEqual(["low", "high"]);
  });

  it("omits effortLevels from describe() when the driver declares none", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toBeUndefined();
  });

  it("reports whether an instance supports isolated approval review", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    expect((await registry.describe())[0].capabilities.approvalReview).toBe(false);
    Object.assign(registry.get("a")!, { reviewPermission: async () => "ok" });
    expect((await registry.describe())[0].capabilities.approvalReview).toBe(true);
  });

  // GET /api/instances used to re-probe every CLI (--version, auth status,
  // model discovery) on every call, costing real seconds on a machine with
  // many engines installed — the engine rail's passive refreshes now pass
  // maxAgeMs so a burst of callers within that window shares one probe.
  it("describe({ maxAgeMs }) serves the memo until it lapses, then re-probes", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    const spy = vi.spyOn(registry, "describeFresh");

    await registry.describe({ maxAgeMs: 10_000 });
    await registry.describe({ maxAgeMs: 10_000 });
    await registry.describe({ maxAgeMs: 10_000 });
    expect(spy).toHaveBeenCalledTimes(1);

    // no maxAgeMs (or 0) — the explicit "Check again"/CLI-save path — always
    // re-probes regardless of how fresh the memo is.
    await registry.describe();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight describe() among concurrent callers instead of probing per caller", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    const spy = vi.spyOn(registry, "describeFresh");

    await Promise.all([
      registry.describe({ maxAgeMs: 10_000 }),
      registry.describe({ maxAgeMs: 10_000 }),
      registry.describe({ maxAgeMs: 10_000 }),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("disposeAll disposes every live instance and empties the registry", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });

    await registry.disposeAll();
    expect(fake.disposed.sort()).toEqual(["a", "b"]);
    expect(registry.entries()).toHaveLength(0);
    expect(registry.get("a")).toBeNull();
  });

  it("marks a `enabled: false` instance as unavailable in describe() so the default-pick filter excludes it", async () => {
    // The lane-B user requirement: disabling an engine must remove it from
    // routing. The picker filters `described.filter(d => d.snapshot.state === "available")`,
    // so a disabled engine needs to publish snapshot.state === "unavailable".
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      live: { driver: "fake" },
      muted: { driver: "fake", enabled: false },
    });

    const described = Object.fromEntries((await registry.describe()).map((d) => [d.instanceId, d]));
    expect(described.live.snapshot.state).toBe("available");
    expect(described.muted.snapshot.state).toBe("unavailable");
    expect(described.muted.snapshot.reason).toBe("Disabled in settings");
    // The boolean flag itself surfaces for the UI to render the toggle.
    expect(described.muted.enabled).toBe(false);
  });

  it("reloadInstance reloads only the specified instance and disposes the previous one", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      a: { driver: "fake", displayName: "A v1" },
      b: { driver: "fake", displayName: "B v1" },
    });

    expect(registry.get("a")?.displayName).toBe("A v1");
    expect(registry.get("b")?.displayName).toBe("B v1");

    const reloaded = await registry.reloadInstance("a", { driver: "fake", displayName: "A v2" });
    expect(reloaded).not.toBeNull();
    expect(reloaded?.displayName).toBe("A v2");
    expect(registry.get("a")?.displayName).toBe("A v2");
    expect(registry.get("b")?.displayName).toBe("B v1");
    // Only instance 'a' was disposed
    expect(fake.disposed).toEqual(["a"]);
  });

  it("removeInstance disposes and drops only the named instance, leaving siblings untouched", async () => {
    // A deleted custom engine must not force the whole fleet through
    // reloadProviders(): that disposes EVERY provider and settles every
    // busy bot elsewhere as interrupted, destroying unrelated work over an
    // unused engine going away.
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      a: { driver: "fake", displayName: "A v1" },
      b: { driver: "fake", displayName: "B v1" },
    });

    await registry.removeInstance("a");

    expect(fake.disposed).toEqual(["a"]);
    expect(registry.get("a")).toBeNull();
    expect(registry.get("b")?.displayName).toBe("B v1");
    expect(registry.instances()).toHaveLength(1);
    expect((await registry.describe()).map((d) => d.instanceId)).toEqual(["b"]);
  });

  it("describeWithFreshInstance updates only the specified instance in the memoized list", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      a: { driver: "fake", displayName: "A v1" },
      b: { driver: "fake", displayName: "B v1" },
    });

    const initial = await registry.describe({ maxAgeMs: 60_000 });
    expect(initial.find((i) => i.instanceId === "a")?.displayName).toBe("A v1");

    await registry.reloadInstance("a", { driver: "fake", displayName: "A v2" });
    const fresh = await registry.describeWithFreshInstance("a");

    expect(fresh.find((i) => i.instanceId === "a")?.displayName).toBe("A v2");
    expect(fresh.find((i) => i.instanceId === "b")?.displayName).toBe("B v1");
  });

  describe("dual-window quota badge", () => {
    beforeEach(() => {
      vi.mocked(getMiniMaxBalance).mockReset();
      // Clear call history only (not the implementation) — several tests
      // in this block don't care about resolveMinimaxCredentials at all
      // and rely on its module-mocked "test-minimax-key" return staying in
      // place across tests.
      vi.mocked(resolveMinimaxCredentials).mockClear();
    });

    it("still reports Antigravity's own dual '5hr/Week' badge (pinning the pre-generalization behavior)", async () => {
      setLastAntigravityQuotaSnapshot({
        timestamp: new Date().toISOString(),
        models: [{ label: "Gemini 3.1 Pro", modelId: "gemini-3.1-pro-high", remainingPercentage: 0.5, isExhausted: false }],
        promptCredits: { remainingPercentage: 0.4 },
      });
      try {
        const fake = makeFakeDriver({ kind: "antigravity" });
        const registry = new ProviderRegistry([fake.driver]);
        await registry.load({ antigravity: { driver: "antigravity" } });
        const [described] = await registry.describe();
        expect(described.snapshot.quota?.windowsLabel).toBe("5hr/Week");
        expect(described.snapshot.quota?.models?.["gemini-3.1-pro-high"]?.secondaryRemainingPercent).toBe(40);
      } finally {
        setLastAntigravityQuotaSnapshot(null);
      }
    });

    it("generalizes the dual-window badge to a non-Antigravity engine (MiniMax's Token Plan quota)", async () => {
      vi.mocked(getMiniMaxBalance).mockResolvedValue({
        source: "token-plan",
        capExists: true,
        status: "ok",
        balanceUsd: null,
        remainingPercent: 62,
        secondaryRemainingPercent: 40,
        windowsLabel: "5hr/Week",
        models: {
          general: {
            remainingPercent: 62,
            secondaryRemainingPercent: 40,
            windowsLabel: "5hr/Week",
            resetsAt: Date.now() + 3_600_000,
            intervalResetsAt: Date.now() + 3_600_000,
            weeklyResetsAt: Date.now() + 86_400_000,
            intervalStatus: "active",
            weeklyStatus: "active",
          },
        },
        resetsAt: Date.now() + 3_600_000,
        weeklyResetsAt: Date.now() + 86_400_000,
        fetchedAt: Date.now(),
        error: null,
      });
      const fake = makeFakeDriver({ kind: "minimax" });
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ minimax: { driver: "minimax" } });
      const [described] = await registry.describe();
      // The regression this pins: before generalizing, windowsLabel was
      // computed only `if (inst.instanceId === "antigravity")` — a second,
      // unrelated engine with real dual-window per-model data got no badge
      // at all, no matter what its own models reported.
      expect(described.snapshot.quota?.windowsLabel).toBe("5hr/Week");
      // "general" is MiniMax's own pool name — it is mapped onto the
      // instance's CATALOG model id ("minimax-1", the fake driver's
      // default), never left under the literal "general" key, because
      // every real consumer (ModelPicker.tsx, turn-safety.ts) keys by
      // catalog model id.
      expect(described.snapshot.quota?.models?.general).toBeUndefined();
      expect(described.snapshot.quota?.models?.["minimax-1"]).toMatchObject({
        remainingPercent: 62,
        secondaryRemainingPercent: 40,
        windowsLabel: "5hr/Week",
      });
      expect(getMiniMaxBalance).toHaveBeenCalledWith("test-minimax-key", "https://api.minimax.io/v1");
    });

    it("falls back to the bare '5hr' badge when only the interval window is known", async () => {
      vi.mocked(getMiniMaxBalance).mockResolvedValue({
        source: "token-plan",
        capExists: true,
        status: "ok",
        balanceUsd: null,
        remainingPercent: 62,
        secondaryRemainingPercent: null,
        windowsLabel: "5hr",
        models: {
          general: {
            remainingPercent: 62,
            secondaryRemainingPercent: null,
            windowsLabel: "5hr",
            resetsAt: null,
            intervalResetsAt: null,
            weeklyResetsAt: null,
            intervalStatus: "unknown",
            weeklyStatus: "unknown",
          },
        },
        resetsAt: null,
        weeklyResetsAt: null,
        fetchedAt: Date.now(),
        error: null,
      });
      const fake = makeFakeDriver({ kind: "minimax" });
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ minimax: { driver: "minimax" } });
      const [described] = await registry.describe();
      expect(described.snapshot.quota?.windowsLabel).toBe("5hr");
    });

    it("maps the 'general' pool onto every catalog model id and keeps an unrelated 'video' pool out of `models` entirely", async () => {
      // Regression: server/minimax-balance.ts's `models` dict is keyed by
      // MiniMax's own POOL name ("general" = chat, "video" = video
      // generation), not by catalog model id. Every real consumer
      // (ModelPicker.tsx's per-row badge/"Partial quota" chip,
      // turn-safety.ts's eligibleAutoFallbackChain) keys by catalog model
      // id — so an exhausted, unrelated "video" pool must never appear
      // under a chat model's id or mislabel the whole engine as capped.
      vi.mocked(getMiniMaxBalance).mockResolvedValue({
        source: "token-plan",
        capExists: true,
        status: "ok",
        balanceUsd: null,
        remainingPercent: 62,
        secondaryRemainingPercent: 40,
        windowsLabel: "5hr/Week",
        models: {
          general: { remainingPercent: 62, secondaryRemainingPercent: 40, windowsLabel: "5hr/Week", resetsAt: null, intervalResetsAt: null, weeklyResetsAt: null, intervalStatus: "active", weeklyStatus: "active" },
          video: { remainingPercent: 0, secondaryRemainingPercent: 0, windowsLabel: "5hr/Week", resetsAt: null, intervalResetsAt: null, weeklyResetsAt: null, intervalStatus: "active", weeklyStatus: "active" },
        },
        resetsAt: null,
        weeklyResetsAt: null,
        fetchedAt: Date.now(),
        error: null,
      });
      const fake = makeFakeDriver({
        kind: "minimax",
        models: { default: "MiniMax-M3", options: [{ id: "MiniMax-M3", label: "MiniMax M3" }, { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed" }] },
      });
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ minimax: { driver: "minimax" } });
      const [described] = await registry.describe();
      // Every chat model reads "general"'s reading (uncapped at 62%) —
      // not the exhausted "video" pool.
      expect(described.snapshot.quota?.models?.["MiniMax-M3"]?.capped).toBe(false);
      expect(described.snapshot.quota?.models?.["MiniMax-M2.7-highspeed"]?.capped).toBe(false);
      expect(described.snapshot.quota?.models?.["MiniMax-M3"]?.remainingPercent).toBe(62);
      // Neither MiniMax's own pool names land in `models` — "general" isn't
      // a catalog id, and "video" is a different quota pool entirely.
      expect(described.snapshot.quota?.models?.general).toBeUndefined();
      expect(described.snapshot.quota?.models?.video).toBeUndefined();
    });

    it("caps every chat model when 'general' itself is at 0%, independent of a healthy 'video' pool", async () => {
      vi.mocked(getMiniMaxBalance).mockResolvedValue({
        source: "token-plan",
        capExists: true,
        status: "capped",
        balanceUsd: null,
        remainingPercent: 0,
        secondaryRemainingPercent: 0,
        windowsLabel: "5hr/Week",
        models: {
          general: { remainingPercent: 0, secondaryRemainingPercent: 0, windowsLabel: "5hr/Week", resetsAt: null, intervalResetsAt: null, weeklyResetsAt: null, intervalStatus: "active", weeklyStatus: "active" },
          video: { remainingPercent: 95, secondaryRemainingPercent: 95, windowsLabel: "5hr/Week", resetsAt: null, intervalResetsAt: null, weeklyResetsAt: null, intervalStatus: "active", weeklyStatus: "active" },
        },
        resetsAt: null,
        weeklyResetsAt: null,
        fetchedAt: Date.now(),
        error: null,
      });
      const fake = makeFakeDriver({
        kind: "minimax",
        models: { default: "MiniMax-M3", options: [{ id: "MiniMax-M3", label: "MiniMax M3" }, { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed" }] },
      });
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ minimax: { driver: "minimax" } });
      const [described] = await registry.describe();
      expect(described.snapshot.quota?.models?.["MiniMax-M3"]?.capped).toBe(true);
      expect(described.snapshot.quota?.models?.["MiniMax-M2.7-highspeed"]?.capped).toBe(true);
    });

    it("resolves a second MiniMax instance's own environment/config.url instead of the reserved instance's", async () => {
      // Regression: registry.ts and server/index.ts both called
      // resolveMinimaxCredentials({}, local) with an EMPTY environment and
      // derived the URL from process.env/local only — a second connection
      // with its own key/host was balance-checked as if it were the
      // reserved instance. resolveMinimaxCredentials is mocked module-wide
      // to always return the same string (see the top-of-file vi.mock), so
      // this test proves the fix by inspecting what it was CALLED WITH
      // (the environment) and by the URL that reached getMiniMaxBalance
      // (real registry.ts logic, not mocked) — not by varying the key.
      vi.mocked(getMiniMaxBalance).mockResolvedValue({
        source: "token-plan",
        capExists: true,
        status: "ok",
        balanceUsd: null,
        remainingPercent: 90,
        secondaryRemainingPercent: null,
        windowsLabel: "5hr",
        models: { general: { remainingPercent: 90, secondaryRemainingPercent: null, windowsLabel: "5hr", resetsAt: null, intervalResetsAt: null, weeklyResetsAt: null, intervalStatus: "active", weeklyStatus: "active" } },
        resetsAt: null,
        weeklyResetsAt: null,
        fetchedAt: Date.now(),
        error: null,
      });
      const fake = makeFakeDriver({ kind: "minimax" });
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({
        minimax: { driver: "minimax" },
        secondMinimax: { driver: "minimax", environment: { MINIMAX_API_KEY: "second-instance-key" }, config: { url: "https://api.minimaxi.com/v1" } },
      });
      await registry.describe();
      const calls = vi.mocked(resolveMinimaxCredentials).mock.calls;
      const reservedCall = calls.find((c) => Object.keys(c[0]).length === 0);
      const secondCall = calls.find((c) => c[0].MINIMAX_API_KEY === "second-instance-key");
      expect(reservedCall).toBeDefined();
      expect(secondCall).toBeDefined();
      // Each instance's own resolved URL reached getMiniMaxBalance: the
      // reserved one falls back to the mocked local.url, the second one
      // uses its own decoded config.url.
      expect(getMiniMaxBalance).toHaveBeenCalledWith("test-minimax-key", "https://api.minimax.io/v1");
      expect(getMiniMaxBalance).toHaveBeenCalledWith("test-minimax-key", "https://api.minimaxi.com/v1");
    });

    it("leaves windowsLabel undefined for an engine with no dual-window source at all", async () => {
      vi.mocked(getMiniMaxBalance).mockResolvedValue({
        source: "unavailable",
        capExists: false,
        status: "unknown",
        balanceUsd: null,
        remainingPercent: null,
        secondaryRemainingPercent: null,
        windowsLabel: undefined,
        models: null,
        resetsAt: null,
        weeklyResetsAt: null,
        fetchedAt: Date.now(),
        error: "no key configured",
      });
      const fake = makeFakeDriver();
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ a: { driver: "fake" } });
      const [described] = await registry.describe();
      expect(described.snapshot.quota?.windowsLabel).toBeUndefined();
      // A non-MiniMax, non-Antigravity engine must never trigger the
      // MiniMax balance lookup at all.
      expect(getMiniMaxBalance).not.toHaveBeenCalled();
    });
  });
});
