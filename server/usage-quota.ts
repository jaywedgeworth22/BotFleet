import { mergeLocalQuotaWindows, readLocalQuotaSnapshot, type LocalQuotaFreshness } from "./local-usage-monitor.ts";
import { quotaCooldowns } from "./model-fallback.ts";
import {
  driverKindsForWindow,
  isPlanLevelSkip,
  modelsToSkip,
} from "./quota-window-map.ts";

export {
  driverKindsForWindow,
  familiesForWindow,
  isPlanLevelSkip,
  modelsToSkip,
  modelTypeFromId,
  windowsForDriver,
} from "./quota-window-map.ts";

export type RemoteQuotaWindow = {
  id: string;
  provider: string;
  providerKey?: string;
  providerLabel?: string;
  via?: string;
  occurredAt?: string;
  source?: string;
  sourceApp: string;
  label: string;
  modelId: string | null;
  modelType: string;
  window: string;
  remainingPercent: number | null;
  resetAt: string | null;
  status: string;
  skip: boolean;
  skipReason: string | null;
  /** The plan the allowance belongs to, as the producer names it ("ultra"). */
  planName?: string | null;
  /** What is left and what the plan holds, in `quotaUnit` — dollars for a
   *  Cursor plan, requests for a MiniMax pool, credits for Grok.  A window
   *  can report these with no percentage at all. */
  absoluteRemaining?: number | null;
  absoluteLimit?: number | null;
  quotaUnit?: string | null;
  /** The producer's own exhaustion verdict.  Distinct from a derived 0%:
   *  only this and `fileSkip` are treated as a cap by the local routing
   *  path, because only they mean the collector saw the provider refuse. */
  isExhausted?: boolean;
  /** The file's own status / skip / skipReason, kept under their own names
   *  so the derived `status` and `skip` above keep the meaning every display
   *  path already reads them with. */
  fileStatus?: string | null;
  fileSkip?: boolean;
  fileSkipReason?: string | null;
};

/** The local handoff's health as `/api/quotas` reports it: one flat object
 *  so the renderer reads a state, not a nested shape. */
export type LocalQuotaView = LocalQuotaFreshness & {
  producer: string | null;
  issues: Record<string, string>;
};

export type QuotaWindowsPayload = {
  ok: true;
  generatedAt: string;
  windows: RemoteQuotaWindow[];
  skipModelTypes: string[];
  skipModelIds: string[];
};

export type QuotaPollerSettings = {
  ingestUrl?: string | null;
  ingestToken?: string | null;
  readToken?: string | null;
};

export type QuotaPollerInstance = {
  instanceId: string;
  driverKind: string;
  models?: { options?: Array<{ id: string }> };
};

const POLL_MS = 30_000;
const INGEST_PATH = "/api/ingest/usage";

export function quotaWindowsUrl(ingestUrl?: string | null): string | null {
  const raw = (ingestUrl || process.env.USAGE_MONITOR_INGEST_URL || "").trim();
  if (!raw) return null;
  try {
    let href = raw;
    if (!/^https?:\/\//i.test(href)) href = `https://${href}`;
    const url = new URL(href);
    if (url.pathname.endsWith(INGEST_PATH)) url.pathname = url.pathname.slice(0, -INGEST_PATH.length) || "/";
    url.pathname = "/api/quota-windows";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function resetsAtMs(resetAt: string | null): number | null {
  if (!resetAt) return null;
  const ms = Date.parse(resetAt);
  return Number.isFinite(ms) ? ms : null;
}

export class UsageQuotaPoller {
  private settingsProvider: (() => QuotaPollerSettings) | null = null;
  private instancesProvider: (() => QuotaPollerInstance[]) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private windows: RemoteQuotaWindow[] = [];
  private localWindows: RemoteQuotaWindow[] = [];
  private localFreshness: LocalQuotaFreshness = { state: "missing" };
  private localProducer: string | null = null;
  private localIssues: Record<string, string> = {};
  private lastError: string | null = null;
  private lastOkAt: string | null = null;
  private inFlight = false;

  private readonly readNativeQuota: typeof readLocalQuotaSnapshot;

  constructor(readNativeQuota = readLocalQuotaSnapshot) {
    this.readNativeQuota = readNativeQuota;
  }

  configure(opts: {
    settings: () => QuotaPollerSettings;
    instances: () => QuotaPollerInstance[];
  }): void {
    this.settingsProvider = opts.settings;
    this.instancesProvider = opts.instances;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getWindows(): RemoteQuotaWindow[] {
    return mergeLocalQuotaWindows(this.windows, this.localWindows);
  }

  /** Whether the native app is still writing the handoff, which app that is,
   *  and any provider it could not read — so Settings can say why a grid is
   *  empty instead of rendering nothing. */
  getLocalQuota(): LocalQuotaView {
    return { ...this.localFreshness, producer: this.localProducer, issues: this.localIssues };
  }

  getStatus(): { lastError: string | null; lastOkAt: string | null; windowCount: number } {
    return {
      lastError: this.lastError,
      lastOkAt: this.lastOkAt,
      windowCount: this.getWindows().length,
    };
  }

  applyPayload(payload: QuotaWindowsPayload, instances: QuotaPollerInstance[]): void {
    this.windows = Array.isArray(payload.windows) ? payload.windows : [];
    const nextOwned = new Set<string>();
    for (const window of this.windows) {
      const kinds = new Set(driverKindsForWindow(window));
      for (const instance of instances) {
        // Local antigravity-usage poller is fresher than UM's 4h collector.
        if (instance.driverKind === "antigravityAgent") continue;
        if (!kinds.has(instance.driverKind)) continue;
        const models = modelsToSkip(window, instance);
        const planSkip = isPlanLevelSkip(window) || models.includes("*");
        const targets = planSkip ? ["*", ...models.filter((model) => model !== "*")] : models;
        for (const model of targets) {
          const key = `${instance.instanceId}:${model}`;
          quotaCooldowns.recordInstanceCap(instance.instanceId, model, {
            resetsAt: resetsAtMs(window.resetAt),
            error: window.skipReason || `${window.label} remaining ${window.remainingPercent ?? 0}%`,
            source: "usage-monitor",
          });
          nextOwned.add(key);
        }
      }
    }
    quotaCooldowns.clearWhere((cd) => {
      if (cd.source !== "usage-monitor") return false;
      return !nextOwned.has(`${cd.instanceId}:${cd.model}`);
    });
  }

  async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const local = await this.readNativeQuota();
    this.localWindows = local.windows;
    this.localFreshness = local.freshness;
    this.localProducer = local.producer;
    this.localIssues = local.issues;
    const settings = this.settingsProvider?.() ?? {};
    const url = quotaWindowsUrl(settings.ingestUrl);
    const token =
      settings.readToken?.trim() ||
      process.env.USAGE_READ_TOKEN?.trim() ||
      "";
    if (!url || !token) {
      this.applyPayload({ ok: true, generatedAt: new Date().toISOString(), windows: [], skipModelTypes: [], skipModelIds: [] }, this.instancesProvider?.() ?? []);
      this.lastError = null;
      this.inFlight = false;
      return;
    }
    this.inFlight = true;
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "BotFleet/1.0" },
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json().catch(() => null)) as QuotaWindowsPayload | { error?: string } | null;
      if (!response.ok || !body || typeof body !== "object" || !("ok" in body) || body.ok !== true) {
        this.lastError = `HTTP ${response.status}`;
        return;
      }
      this.applyPayload(body, this.instancesProvider?.() ?? []);
      this.lastError = null;
      this.lastOkAt = new Date().toISOString();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.inFlight = false;
    }
  }
}

export const usageQuotaPoller = new UsageQuotaPoller();
