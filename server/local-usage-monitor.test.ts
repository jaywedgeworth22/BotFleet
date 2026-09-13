import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageQuotaPoller } from "./usage-quota.ts";
import { LOCAL_QUOTA_MAX_AGE_MS, mergeLocalQuotaWindows, parseLocalQuotaSnapshot, readLocalQuotaSnapshot } from "./local-usage-monitor.ts";

const now = Date.parse("2026-09-13T08:00:00Z");
const row = (provider = "openai", extra = {}) => ({
  id: "short", provider, providerKey: provider, label: "5h window", remainingPercent: 42,
  occurredAt: new Date(now).toISOString(), resetAt: "2026-09-13T10:00:00Z", window: "5h", ...extra,
});
const payload = (windows: unknown[] = [row()], extra = {}) => ({
  format: "usage-monitor-local-quotas", version: 1, generatedAt: new Date(now).toISOString(), windows, ...extra,
});

describe("native Usage Monitor handoff", () => {
  it("reads only supported products and never turns local display readings into routing caps", () => {
    const result = parseLocalQuotaSnapshot(payload([
      row("xai", { remainingPercent: 0, skip: true }), row("grok-bot"), row("kimi"), row("gemini-cli"),
      row("github-copilot"), row("windsurf"), row("google-antigravity", { label: "Third-Party Models · Weekly", modelId: null }),
    ]), now);
    expect(result.map((value) => value.provider)).toEqual(["xai", "google-antigravity"]);
    expect(result[0]).toMatchObject({ remainingPercent: 0, status: "exhausted", skip: false });
    expect(result[1].modelId).toBeNull();
  });

  it("rejects incompatible, stale, future, and malformed snapshots", () => {
    expect(parseLocalQuotaSnapshot(payload([], { version: 2 }), now)).toEqual([]);
    expect(parseLocalQuotaSnapshot(payload(), now + LOCAL_QUOTA_MAX_AGE_MS)).toEqual([]);
    expect(parseLocalQuotaSnapshot(payload(), now - 61_000)).toEqual([]);
    expect(parseLocalQuotaSnapshot(payload([row("openai", { remainingPercent: "99" })]), now)).toEqual([]);
    expect(parseLocalQuotaSnapshot(payload([row("openai", { remainingPercent: 101 })]), now)).toEqual([]);
    expect(parseLocalQuotaSnapshot(payload([row("openai", { occurredAt: "old" })]), now)).toEqual([]);
    expect(parseLocalQuotaSnapshot(payload([row("openai", { occurredAt: "2026-09-12T08:00:00Z" })]), now)).toEqual([]);
  });

  it("keeps missing or elapsed quotas unknown without inventing a refill", () => {
    const result = parseLocalQuotaSnapshot(payload([
      row("openai", { resetAt: "2026-09-13T07:59:59Z" }),
      row("xai", { remainingPercent: null, resetAt: null }),
    ]), now);
    expect(result.map((value) => value.remainingPercent)).toEqual([null, null]);
  });

  it("merges whole provider identities without borrowing another account's weekly cap", () => {
    const local = parseLocalQuotaSnapshot(payload([row()]), now);
    const remote = parseLocalQuotaSnapshot(payload([row("openai", { id: "weekly", window: "1w" }), row("minimax")]), now);
    remote[0].provider = "codex";
    delete remote[0].providerKey;
    const merged = mergeLocalQuotaWindows(remote, local);
    expect(merged.map((value) => `${value.provider}:${value.id}`)).toEqual(["openai:short", "minimax:short"]);
  });

  it("preserves account identity for an unknown local quota", () => {
    const local = parseLocalQuotaSnapshot(payload([row("openai", { remainingPercent: null })]), now);
    const remote = parseLocalQuotaSnapshot(payload([row("openai", { id: "weekly", remainingPercent: 95 })]), now);
    expect(mergeLocalQuotaWindows(remote, local)).toEqual(local);
  });

  it("surfaces native quotas without a configured remote server and removes expired local data", async () => {
    const local = parseLocalQuotaSnapshot(payload(), now);
    let readings = local;
    const poller = new UsageQuotaPoller(async () => readings);
    poller.configure({ settings: () => ({}), instances: () => [] });
    await poller.poll();
    expect(poller.getWindows()).toEqual(local);
    expect(poller.getWindows()[0].sourceApp).toBe("usage-monitor-mac:codex");
    readings = [];
    await poller.poll();
    expect(poller.getWindows()).toEqual([]);
  });

  it("reads a bounded regular file and ignores symlinks, bad JSON, and missing files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bf-native-quota-"));
    try {
      const path = join(directory, "quota.json");
      await writeFile(path, JSON.stringify(payload()));
      expect(await readLocalQuotaSnapshot(path, now)).toHaveLength(1);
      const link = join(directory, "link.json");
      await symlink(path, link);
      expect(await readLocalQuotaSnapshot(link, now)).toEqual([]);
      await writeFile(path, "{}");
      expect(await readLocalQuotaSnapshot(path, now)).toEqual([]);
      await writeFile(path, "x".repeat(1_048_577));
      expect(await readLocalQuotaSnapshot(path, now)).toEqual([]);
      expect(await readLocalQuotaSnapshot(join(directory, "missing"), now)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
