import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { TurnBillingMode } from "./contracts.ts";

export interface TurnSpendEntry {
  at: number;
  provider: string;
  instanceId?: string;
  costUsd: number;
  billingMode?: TurnBillingMode;
}

export interface EngineSpendSummary {
  spend5hUsd: number;
  spend7dUsd: number;
}

export type EngineSpendMap = Record<string, EngineSpendSummary>;

export const FIVE_HOURS_MS = 5 * 3600 * 1000;
export const SEVEN_DAYS_MS = 7 * 86400 * 1000;

const turnCompletedSchema = z.object({
  type: z.literal("turn.completed"),
  provider: z.string().default("unknown"),
  providerInstanceId: z.string().optional(),
  createdAt: z.string().optional(),
  cost: z.number().positive(),
  billingMode: z.enum(["actual", "estimated"]).optional(),
});

export function parseTurnSpendFromEventLog(content: string, cutoffMs: number): TurnSpendEntry[] {
  const entries: TurnSpendEntry[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.includes('"turn.completed"') || !line.includes('"cost"')) continue;
    try {
      const raw = JSON.parse(line);
      const parsed = turnCompletedSchema.safeParse(raw);
      if (!parsed.success) continue;
      const ev = parsed.data;
      if (ev.billingMode === "estimated") continue;
      const at = ev.createdAt ? Date.parse(ev.createdAt) : NaN;
      if (!Number.isFinite(at) || at < cutoffMs) continue;
      entries.push({
        at,
        provider: ev.provider,
        instanceId: ev.providerInstanceId,
        costUsd: ev.cost,
        billingMode: ev.billingMode,
      });
    } catch {
      // ignore torn or unparseable lines
    }
  }
  return entries;
}

export function scanRecentSpend(eventsDir: string, now = Date.now()): TurnSpendEntry[] {
  const cutoff = now - SEVEN_DAYS_MS;
  const entries: TurnSpendEntry[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(eventsDir);
  } catch {
    return entries;
  }
  for (const file of files) {
    if (!file.endsWith(".ndjson") && !file.endsWith(".ndjson.1")) continue;
    const fullPath = join(eventsDir, file);
    try {
      const st = statSync(fullPath);
      if (st.mtimeMs < cutoff) continue;
      const content = readFileSync(fullPath, "utf8");
      entries.push(...parseTurnSpendFromEventLog(content, cutoff));
    } catch {
      // skip unreadable files
    }
  }
  return entries;
}

export class RollingSpendTracker {
  private records: TurnSpendEntry[] = [];
  private initialized = false;

  init(eventsDir: string, now = Date.now()): void {
    if (this.initialized) return;
    this.records = scanRecentSpend(eventsDir, now);
    this.initialized = true;
  }

  recordTurn(entry: {
    at?: number;
    provider: string;
    instanceId?: string;
    costUsd?: number | null;
    billingMode?: TurnBillingMode;
  }): void {
    if (!entry.costUsd || !Number.isFinite(entry.costUsd) || entry.costUsd <= 0) {
      return;
    }
    if (entry.billingMode === "estimated") {
      return;
    }
    this.records.push({
      at: entry.at ?? Date.now(),
      provider: entry.provider,
      instanceId: entry.instanceId,
      costUsd: entry.costUsd,
      billingMode: entry.billingMode,
    });
  }

  getSpend(now = Date.now()): EngineSpendMap {
    const t5h = now - FIVE_HOURS_MS;
    const t7d = now - SEVEN_DAYS_MS;
    // Prune entries older than 7 days
    this.records = this.records.filter((r) => r.at >= t7d);

    const spend: EngineSpendMap = {};

    const addCost = (key: string, cost: number, at: number) => {
      if (!spend[key]) {
        spend[key] = { spend5hUsd: 0, spend7dUsd: 0 };
      }
      spend[key].spend7dUsd += cost;
      if (at >= t5h) {
        spend[key].spend5hUsd += cost;
      }
    };

    // Ensure DeepSeek alias keys are aggregated together across all aliases
    const dsKeys = ["deepseekAgent", "deepseek", "dshAgent"];
    let dsSpend5h = 0;
    let dsSpend7d = 0;
    let hasDsEntry = false;
    for (const r of this.records) {
      const isDs = dsKeys.includes(r.provider) || (r.instanceId && dsKeys.includes(r.instanceId));
      if (isDs) {
        hasDsEntry = true;
        dsSpend7d += r.costUsd;
        if (r.at >= t5h) {
          dsSpend5h += r.costUsd;
        }
      }
    }
    if (hasDsEntry) {
      const dsSummary = {
        spend5hUsd: Math.round(dsSpend5h * 10_000) / 10_000,
        spend7dUsd: Math.round(dsSpend7d * 10_000) / 10_000,
      };
      for (const k of dsKeys) {
        spend[k] = { ...dsSummary };
      }
    }

    for (const r of this.records) {
      const isDs = dsKeys.includes(r.provider) || (r.instanceId && dsKeys.includes(r.instanceId));
      if (!isDs) {
        addCost(r.provider, r.costUsd, r.at);
        if (r.instanceId && r.instanceId !== r.provider) {
          addCost(r.instanceId, r.costUsd, r.at);
        }
      }
    }

    // Round accumulated values in final output
    for (const key of Object.keys(spend)) {
      spend[key].spend5hUsd = Math.round(spend[key].spend5hUsd * 10_000) / 10_000;
      spend[key].spend7dUsd = Math.round(spend[key].spend7dUsd * 10_000) / 10_000;
    }

    return spend;
  }

  reset(): void {
    this.records = [];
    this.initialized = false;
  }
}

export const rollingSpendTracker = new RollingSpendTracker();
