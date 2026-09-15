import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RemoteQuotaWindow } from "./usage-quota.ts";

const MAX_BYTES = 1_048_576;
export const LOCAL_QUOTA_MAX_AGE_MS = 10 * 60_000;
const PROVIDERS = new Set(["anthropic", "openai", "google-antigravity", "cursor", "xai", "minimax", "deepseek"]);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max = 200): string | null =>
  typeof value === "string" && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : null;
const timestamp = (value: unknown): string | null => {
  const valueText = text(value, 40);
  return valueText && Number.isFinite(Date.parse(valueText)) ? valueText : null;
};

/** Same-user, quota-only cache from the native Usage Monitor app.
 *  This is display data.  It never creates routing cooldowns or supplies auth. */
export function parseLocalQuotaSnapshot(value: unknown, now = Date.now()): RemoteQuotaWindow[] {
  const payload = record(value);
  if (!payload || payload.format !== "usage-monitor-local-quotas" || payload.version !== 1) return [];
  const generatedAt = timestamp(payload.generatedAt);
  if (!generatedAt || !Array.isArray(payload.windows) || payload.windows.length > 256) return [];
  const age = now - Date.parse(generatedAt);
  if (age < -60_000 || age >= LOCAL_QUOTA_MAX_AGE_MS) return [];
  const windows: RemoteQuotaWindow[] = [];
  const seen = new Set<string>();
  for (const raw of payload.windows) {
    const row = record(raw);
    if (!row) continue;
    const provider = text(row.providerKey) ?? text(row.provider);
    // Grok Bot is a different product from Grok CLI and cannot run in BotFleet.
    if (!provider || !PROVIDERS.has(provider)) continue;
    const id = text(row.id);
    const label = text(row.label);
    const occurredAt = timestamp(row.occurredAt);
    const percent = row.remainingPercent;
    if (!id || !label || !occurredAt || seen.has(`${provider}:${id}`)) continue;
    const observedAge = now - Date.parse(occurredAt);
    if (observedAge < -60_000 || observedAge >= LOCAL_QUOTA_MAX_AGE_MS) continue;
    if (percent !== undefined && percent !== null && (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100)) continue;
    const resetAt = timestamp(row.resetAt);
    const resetPassed = resetAt !== null && Date.parse(resetAt) <= now;
    const remainingPercent = row.remainingUnknown === true || resetPassed ? null : typeof percent === "number" ? percent : null;
    seen.add(`${provider}:${id}`);
    windows.push({
      id, provider, providerKey: provider, providerLabel: text(row.providerLabel) ?? undefined,
      sourceApp: `usage-monitor-mac:${provider === "openai" ? "codex" : provider}`, via: text(row.via) ?? undefined,
      label, modelId: text(row.modelId), modelType: text(row.modelType) ?? "", window: text(row.window) ?? "",
      remainingPercent, resetAt, occurredAt, source: "Usage Monitor on this Mac",
      status: remainingPercent === null ? "unknown" : remainingPercent === 0 ? "exhausted" : remainingPercent <= 20 ? "near_cap" : "available",
      skip: false, skipReason: null,
    });
  }
  return windows;
}

export async function readLocalQuotaSnapshot(
  path = join(homedir(), "Library", "Application Support", "Usage Monitor", "quota-windows.json"),
  now = Date.now(),
): Promise<RemoteQuotaWindow[]> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile()) return [];
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await file.stat();
    // Windows lacks O_NOFOLLOW; reject links first and verify the opened identity.
    if (before.dev !== stat.dev || before.ino !== stat.ino) return [];
    if (!stat.isFile() || stat.size > MAX_BYTES || (process.getuid && stat.uid !== process.getuid())) return [];
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size <= MAX_BYTES) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) return [];
    return parseLocalQuotaSnapshot(JSON.parse(buffer.toString("utf8", 0, size)), now);
  } catch {
    // An unopened or uninstalled native app is an ordinary absence of data.
    return [];
  } finally {
    await file?.close().catch(() => {});
  }
}

/** A local account is one identity boundary; never borrow another account's
 *  weekly cap from the remote server to fill its missing local period. */
export function mergeLocalQuotaWindows(remote: RemoteQuotaWindow[], local: RemoteQuotaWindow[]): RemoteQuotaWindow[] {
  const localProviders = new Set(local.map((row) => row.providerKey ?? row.provider));
  const key = (row: RemoteQuotaWindow): string => row.via === "antigravity" ? "google-antigravity" : row.providerKey ?? ({ "claude-code": "anthropic", claude: "anthropic", codex: "openai", "openai-codex": "openai", "grok-build": "xai", grok: "xai", antigravity: "google-antigravity" } as Record<string, string>)[row.provider] ?? row.provider;
  const remoteProviders = new Set(remote.filter((row) => !localProviders.has(key(row))).map(key));
  return [...local.filter((row) => !remoteProviders.has(key(row))), ...remote.filter((row) => !localProviders.has(key(row)))];
}
