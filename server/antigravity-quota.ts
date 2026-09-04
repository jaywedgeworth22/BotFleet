// Live Antigravity remaining-percent from the `antigravity-usage` CLI
// (`antigravity-usage quota --json`).  BotFleet used to learn a cap only
// after a turn burned a quota chip.  Usage Monitor's `agy -p /usage`
// collector is group-level and hours stale.  This CLI talks to Google Cloud
// Code (or the local language server) and returns per-model remaining,
// isExhausted, and resetTime — the signal we actually route on.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { augmentedPath } from "./env-path.ts";
import {
  quotaCooldowns,
  type QuotaCooldownRegistry,
} from "./model-fallback.ts";

const execFileAsync = promisify(execFile);

export const ANTIGRAVITY_INSTANCE_ID = "antigravity";
export const ANTIGRAVITY_USAGE_SOURCE = "antigravity-usage";

export interface AntigravityUsageModel {
  label: string;
  modelId: string;
  /** 0–1 fraction when Google reports it.  Gemini rows are often omitted. */
  remainingPercentage?: number;
  isExhausted: boolean;
  resetTime?: string;
  timeUntilResetMs?: number;
  isAutocompleteOnly?: boolean;
}

export interface AntigravityUsageSnapshot {
  timestamp: string;
  method?: string;
  models: AntigravityUsageModel[];
}

export type AntigravityQuotaExec = (args: string[], refresh: boolean) => Promise<string>;

const CLI_TIMEOUT_MS = 20_000;

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function findAntigravityUsageBin(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const home = env.HOME || env.USERPROFILE || homedir();
  const explicit = env.ANTIGRAVITY_USAGE_BIN?.trim();
  const candidates = [
    ...(explicit ? [explicit] : []),
    join(home, ".local", "bin", "antigravity-usage"),
    join(home, ".npm-global", "bin", "antigravity-usage"),
    "/opt/homebrew/bin/antigravity-usage",
    "/usr/local/bin/antigravity-usage",
  ];
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return candidate;
  }
  return "antigravity-usage";
}

export function parseAntigravityUsageJson(raw: unknown): AntigravityUsageSnapshot {
  if (!raw || typeof raw !== "object") {
    throw new Error("antigravity-usage output was not a JSON object");
  }
  const root = raw as Record<string, unknown>;
  const rows = Array.isArray(root.models) ? root.models : null;
  if (!rows) {
    throw new Error("antigravity-usage JSON is missing models[]");
  }

  const models: AntigravityUsageModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    const modelId = firstString(entry.modelId, entry.id);
    if (!modelId) continue;
    const remaining = firstFiniteNumber(entry.remainingPercentage);
    models.push({
      label: firstString(entry.label, entry.name) ?? modelId,
      modelId,
      ...(remaining != null ? { remainingPercentage: remaining } : {}),
      isExhausted: entry.isExhausted === true,
      resetTime: firstString(entry.resetTime, entry.reset_time, entry.resetsAt),
      timeUntilResetMs: firstFiniteNumber(entry.timeUntilResetMs),
      isAutocompleteOnly: entry.isAutocompleteOnly === true,
    });
  }
  if (models.length === 0) {
    throw new Error("antigravity-usage JSON contained zero model rows");
  }
  return {
    timestamp: firstString(root.timestamp) ?? new Date().toISOString(),
    method: firstString(root.method),
    models,
  };
}

/** Skip autocomplete-only rows.  Treat remaining 0 or isExhausted as a hit.
 *  Missing remaining (Gemini N/A) is not a hit unless isExhausted. */
export function isAntigravityModelCapped(model: AntigravityUsageModel): boolean {
  if (model.isAutocompleteOnly) return false;
  if (model.isExhausted) return true;
  return typeof model.remainingPercentage === "number" && model.remainingPercentage <= 0;
}

export function remainingPercentDisplay(model: AntigravityUsageModel): number | null {
  if (typeof model.remainingPercentage !== "number") return null;
  return Math.round(model.remainingPercentage * 10_000) / 100;
}

export function resetAtMs(model: AntigravityUsageModel, now = Date.now()): number | null {
  if (model.resetTime) {
    const parsed = Date.parse(model.resetTime);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof model.timeUntilResetMs === "number" && model.timeUntilResetMs > 0) {
    return now + model.timeUntilResetMs;
  }
  return null;
}

export function applyAntigravityUsageToRegistry(
  snapshot: AntigravityUsageSnapshot,
  registry: QuotaCooldownRegistry = quotaCooldowns,
  now = Date.now(),
): { capped: string[]; cleared: string[] } {
  const turnModels = snapshot.models.filter((model) => !model.isAutocompleteOnly);
  const cappedIds = new Set(
    turnModels.filter(isAntigravityModelCapped).map((model) => model.modelId),
  );
  const knownIds = new Set(turnModels.map((model) => model.modelId));

  const cleared: string[] = [];
  registry.clearWhere((cd) => {
    if (cd.source !== ANTIGRAVITY_USAGE_SOURCE) return false;
    if (cd.instanceId !== ANTIGRAVITY_INSTANCE_ID) return false;
    if (cappedIds.has(cd.model)) return false;
    if (knownIds.has(cd.model) || cd.model === "*") {
      cleared.push(cd.model);
      return true;
    }
    return false;
  });

  const capped: string[] = [];
  for (const model of turnModels) {
    if (!isAntigravityModelCapped(model)) continue;
    const remaining = remainingPercentDisplay(model);
    const remainingText = remaining == null ? "exhausted" : `${remaining}% remaining`;
    registry.recordInstanceCap(ANTIGRAVITY_INSTANCE_ID, model.modelId, {
      resetsAt: resetAtMs(model, now),
      error: `${model.label} quota ${remainingText} (antigravity-usage)`,
      source: ANTIGRAVITY_USAGE_SOURCE,
    });
    capped.push(model.modelId);
  }
  return { capped, cleared };
}

export interface AntigravityModelQuota {
  capped: boolean;
  remainingPercent?: number | null;
  resetsAt?: number | null;
  error?: string;
}

export function quotaModelsFromSnapshot(
  snapshot: AntigravityUsageSnapshot | null,
  now = Date.now(),
): Record<string, AntigravityModelQuota> {
  const models: Record<string, AntigravityModelQuota> = {};
  if (!snapshot) return models;
  for (const model of snapshot.models) {
    if (model.isAutocompleteOnly) continue;
    models[model.modelId] = {
      capped: isAntigravityModelCapped(model),
      remainingPercent: remainingPercentDisplay(model),
      resetsAt: resetAtMs(model, now),
      ...(isAntigravityModelCapped(model)
        ? { error: `${model.label} quota exhausted (antigravity-usage)` }
        : {}),
    };
  }
  return models;
}

let lastSnapshot: AntigravityUsageSnapshot | null = null;

export function lastAntigravityQuotaSnapshot(): AntigravityUsageSnapshot | null {
  return lastSnapshot;
}

export function setLastAntigravityQuotaSnapshot(snapshot: AntigravityUsageSnapshot | null): void {
  lastSnapshot = snapshot;
}

export async function defaultAntigravityUsageExec(args: string[], refresh: boolean): Promise<string> {
  const bin = findAntigravityUsageBin();
  const cliArgs = ["quota", "--json", ...args, ...(refresh ? ["--refresh"] : [])];
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath(), NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  const { stdout } = await execFileAsync(bin ?? "antigravity-usage", cliArgs, {
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
    env,
  });
  return stdout;
}

export interface AntigravityQuotaPoller {
  start: () => void;
  stop: () => void;
  tick: (refresh?: boolean) => Promise<AntigravityUsageSnapshot | null>;
  lastSnapshot: () => AntigravityUsageSnapshot | null;
}

export function createAntigravityQuotaPoller(opts: {
  registry?: QuotaCooldownRegistry;
  exec?: AntigravityQuotaExec;
  intervalMs?: number;
  refreshEveryMs?: number;
  now?: () => number;
  log?: (message: string) => void;
} = {}): AntigravityQuotaPoller {
  const registry = opts.registry ?? quotaCooldowns;
  const exec = opts.exec ?? defaultAntigravityUsageExec;
  const intervalMs = opts.intervalMs ?? 60_000;
  const refreshEveryMs = opts.refreshEveryMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((message: string) => console.log(`[antigravity-quota] ${message}`));
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastRefreshAt = 0;
  let snapshot: AntigravityUsageSnapshot | null = null;
  let ticking = false;
  let missingLogged = false;

  const tick = async (forceRefresh = false): Promise<AntigravityUsageSnapshot | null> => {
    if (ticking) return snapshot;
    ticking = true;
    try {
      const elapsed = now() - lastRefreshAt;
      const refresh = forceRefresh || lastRefreshAt === 0 || elapsed >= refreshEveryMs;
      const stdout = await exec([], refresh);
      const parsed = parseAntigravityUsageJson(JSON.parse(stdout));
      snapshot = parsed;
      lastSnapshot = parsed;
      lastRefreshAt = now();
      missingLogged = false;
      const applied = applyAntigravityUsageToRegistry(parsed, registry, now());
      if (applied.capped.length || applied.cleared.length) {
        log(
          `applied ${parsed.models.length} model(s); capped=${applied.capped.length} cleared=${applied.cleared.length}`,
        );
      }
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing = /ENOENT|not found|not installed/i.test(message);
      if (missing) {
        if (!missingLogged) {
          log("antigravity-usage CLI not on PATH; leaving existing cooldowns alone");
          missingLogged = true;
        }
      } else {
        log(`poll failed: ${message}`);
      }
      return snapshot;
    } finally {
      ticking = false;
    }
  };

  return {
    start() {
      if (timer) return;
      void tick(true);
      timer = setInterval(() => void tick(false), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    lastSnapshot: () => snapshot,
  };
}

const defaultPoller = createAntigravityQuotaPoller();

export function startAntigravityQuotaPoller(): void {
  defaultPoller.start();
}

export function stopAntigravityQuotaPoller(): void {
  defaultPoller.stop();
}
