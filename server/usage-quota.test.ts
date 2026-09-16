import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { quotaCooldowns } from "./model-fallback.ts";
import {
  driverKindsForWindow,
  familiesForWindow,
  modelsToSkip,
  quotaWindowsUrl,
  UsageQuotaPoller,
  windowLengthMs,
  type QuotaPollerSettings,
  type RemoteQuotaWindow,
} from "./usage-quota.ts";

const opus: RemoteQuotaWindow = {
  id: "claude-opus-4-6-thinking",
  provider: "google-antigravity",
  sourceApp: "antigravity-cli",
  label: "Claude Opus 4.6 (Thinking)",
  modelId: "claude-opus-4-6-thinking",
  modelType: "claude-opus",
  window: "weekly",
  remainingPercent: 0,
  resetAt: "2026-09-09T07:04:37Z",
  status: "exhausted",
  skip: true,
  skipReason: "0% remaining",
};

describe("usage quota mapping", () => {
  it("derives quota-windows URL from the ingest endpoint", () => {
    expect(quotaWindowsUrl("https://usage.jays.services/api/ingest/usage")).toBe(
      "https://usage.jays.services/api/quota-windows",
    );
    expect(quotaWindowsUrl("https://usage.jays.services")).toBe(
      "https://usage.jays.services/api/quota-windows",
    );
  });

  it("never applies Grok Bot allowances to Grok CLI or Cursor engines", () => {
    expect(driverKindsForWindow({ ...opus, provider: "xai", providerKey: "grok-bot", sourceApp: "cursor", label: "Weekly" })).toEqual([]);
    expect(driverKindsForWindow({ ...opus, provider: "Grok Bot", sourceApp: "cursor", label: "Weekly" })).toEqual([]);
    expect(driverKindsForWindow({ ...opus, provider: "xai", sourceApp: "grok-build", label: "Grok CLI" })).toEqual(["grokAgent", "grok"]);
  });

  it("maps Antigravity windows onto the Antigravity driver", () => {
    expect(driverKindsForWindow(opus)).toEqual(["antigravityAgent"]);
  });

  it("skips the exact exhausted model id", () => {
    expect(
      modelsToSkip(opus, {
        instanceId: "antigravity",
        driverKind: "antigravityAgent",
        models: { options: [{ id: "claude-opus-4-6-thinking" }, { id: "gemini-3.6-flash-high" }] },
      }),
    ).toEqual(["claude-opus-4-6-thinking"]);
  });

  it("expands a Claude+GPT group skip across matching catalog ids", () => {
    const group: RemoteQuotaWindow = {
      ...opus,
      id: "3p-weekly",
      label: "Claude and GPT models (weekly)",
      modelId: null,
      modelType: "claude",
    };
    expect(familiesForWindow(group)).toContain("gpt");
    expect(
      modelsToSkip(group, {
        instanceId: "antigravity",
        driverKind: "antigravityAgent",
        models: {
          options: [
            { id: "claude-sonnet-4-6" },
            { id: "gpt-oss-120b-medium" },
            { id: "gemini-3.6-flash-high" },
          ],
        },
      }),
    ).toEqual(["claude-sonnet-4-6", "gpt-oss-120b-medium"]);
  });

  it("maps a Cursor monthly skip onto the whole cursor engine", () => {
    const monthly: RemoteQuotaWindow = {
      id: "cursor-monthly",
      provider: "cursor",
      sourceApp: "cursor-cli",
      label: "Cursor Pro monthly",
      modelId: null,
      modelType: "cursor",
      window: "monthly",
      remainingPercent: 0,
      resetAt: "2026-09-15T00:00:00.000Z",
      status: "exhausted",
      skip: true,
      skipReason: "0% remaining",
    };
    expect(driverKindsForWindow(monthly)).toEqual(["cursorAgent"]);
    expect(
      modelsToSkip(monthly, {
        instanceId: "cursor",
        driverKind: "cursorAgent",
        models: { options: [{ id: "auto" }, { id: "composer-2.5" }] },
      }),
    ).toEqual(["*"]);
  });

  it("maps DeepSeek and DSH windows to their respective driver kinds", () => {
    const dsWindow: RemoteQuotaWindow = {
      id: "deepseek-balance",
      provider: "deepseek",
      sourceApp: "deepseek",
      label: "DeepSeek API",
      modelId: "deepseek-chat",
      modelType: "deepseek",
      window: "monthly",
      remainingPercent: 85,
      resetAt: null,
      status: "available",
      skip: false,
      skipReason: null,
    };
    expect(driverKindsForWindow(dsWindow)).toEqual(["deepseekAgent", "deepseek"]);

    const dshWindow: RemoteQuotaWindow = {
      ...dsWindow,
      id: "dsh-window",
      provider: "dsh",
      sourceApp: "dsh",
      label: "DeepSeek Harness",
    };
    expect(driverKindsForWindow(dshWindow)).toEqual(["dshAgent"]);
  });
});

describe("local subscription caps", () => {
  // Relative to the run, never a pinned date: a fixture whose reset is in the
  // past would stop capping and quietly turn this suite green.
  const now = Date.now();
  const resetAt = new Date(now + (2 * 86_400_000)).toISOString();
  const localWindow = (extra: Partial<RemoteQuotaWindow> = {}): RemoteQuotaWindow => ({
    id: "local-mac:openai:primary",
    provider: "openai",
    providerKey: "openai",
    sourceApp: "usage-monitor-mac:codex",
    source: "Usage Monitor on this Mac",
    label: "Codex weekly",
    modelId: null,
    modelType: "",
    window: "1w",
    remainingPercent: 0,
    resetAt,
    occurredAt: new Date(now).toISOString(),
    // What the local parser produces: a derived status, `skip` left false,
    // and the collector's own verdict beside it.
    status: "exhausted",
    skip: false,
    skipReason: null,
    isExhausted: true,
    fileSkip: true,
    fileSkipReason: "0% remaining",
    ...extra,
  });
  const codex = { instanceId: "codex", driverKind: "codex", models: { options: [{ id: "gpt-5.2-codex" }] } };

  const poller = (windows: RemoteQuotaWindow[], settings: QuotaPollerSettings = {}, instances = [codex]) => {
    const made = new UsageQuotaPoller(async () => ({ windows, freshness: { state: "fresh", generatedAt: new Date(Date.now()).toISOString(), ageMs: 0 }, producer: "agent-bar", issues: {} }));
    made.configure({ settings: () => settings, instances: () => instances });
    return made;
  };

  beforeEach(() => { quotaCooldowns.clearWhere(() => true); });
  afterEach(() => { quotaCooldowns.clearWhere(() => true); });

  it("caps the engine on the collector's own verdict, until the window resets", async () => {
    await poller([localWindow()]).poll();
    const cooldown = quotaCooldowns.list().find((cd) => cd.instanceId === "codex");
    expect(cooldown?.source).toBe("usage-monitor-local");
    expect(cooldown?.model).toBe("*");
    expect(cooldown?.resetsAt).toBe(Date.parse(resetAt));
    expect(cooldown?.error).toBe("0% remaining");
  });

  it("never caps on a derived 0% alone", async () => {
    await poller([localWindow({ isExhausted: false, fileSkip: false, fileSkipReason: null })]).poll();
    expect(quotaCooldowns.list()).toEqual([]);
  });

  it("does not let the remote feed's empty payload clear a local cap", async () => {
    // With no ingest URL and no read token the poller applies an empty remote
    // payload on every poll — which is exactly the live configuration here.
    const made = poller([localWindow()]);
    await made.poll();
    await made.poll();
    expect(quotaCooldowns.list().map((cd) => cd.source)).toEqual(["usage-monitor-local"]);
  });

  it("reproduces today's behaviour with the flag off, and releases a cap it already took", async () => {
    const windows = [localWindow()];
    await poller(windows).poll();
    expect(quotaCooldowns.list()).toHaveLength(1);
    await poller(windows, { localQuotaRouting: false }).poll();
    expect(quotaCooldowns.list()).toEqual([]);
  });

  it("leaves MiniMax and Antigravity to their own pollers", async () => {
    const rows = [
      localWindow({ id: "minimax:weekly", provider: "minimax", providerKey: "minimax", label: "MiniMax weekly" }),
      localWindow({ id: "ag:weekly", provider: "google-antigravity", providerKey: "google-antigravity", label: "Gemini Models · Weekly" }),
    ];
    const instances = [
      { instanceId: "minimax", driverKind: "minimax", models: { options: [{ id: "MiniMax-M3" }] } },
      { instanceId: "antigravity", driverKind: "antigravityAgent", models: { options: [{ id: "gemini-3.6-flash-high" }] } },
    ];
    await poller(rows, {}, instances).poll();
    expect(quotaCooldowns.list()).toEqual([]);
  });

  it("caps one model when the window names one, and the plan when it names none", async () => {
    await poller([localWindow({ id: "codex-model", modelId: "gpt-5.2-codex" })]).poll();
    expect(quotaCooldowns.list().map((cd) => cd.model)).toEqual(["gpt-5.2-codex"]);
  });

  it("derives an end from the window token, caps it at eight days, and skips a row with neither", async () => {
    expect(windowLengthMs("5h")).toBe(5 * 3_600_000);
    expect(windowLengthMs("1w")).toBe(7 * 86_400_000);
    expect(windowLengthMs("5-hour")).toBe(5 * 3_600_000);
    expect(windowLengthMs("billing-cycle")).toBeNull();

    const made = poller([localWindow({ resetAt: null, window: "5h" })]);
    await made.poll();
    const derived = quotaCooldowns.list().find((cd) => cd.instanceId === "codex");
    expect(derived?.resetsAt).toBeGreaterThan(Date.now() + (4 * 3_600_000));
    expect(derived?.resetsAt).toBeLessThanOrEqual(Date.now() + (5 * 3_600_000));
    quotaCooldowns.clearWhere(() => true);

    // A monthly window with no reset would otherwise hold the engine for a
    // billing month on the strength of one stale file.
    await poller([localWindow({ resetAt: null, window: "monthly" })]).poll();
    const capped = quotaCooldowns.list().find((cd) => cd.instanceId === "codex");
    expect(capped?.resetsAt).toBeLessThanOrEqual(Date.now() + (8 * 86_400_000));
    quotaCooldowns.clearWhere(() => true);

    await poller([localWindow({ resetAt: null, window: "billing-cycle" })]).poll();
    expect(quotaCooldowns.list()).toEqual([]);
  });
});
