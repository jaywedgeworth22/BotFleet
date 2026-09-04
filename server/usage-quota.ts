import { quotaCooldowns } from "./model-fallback.ts";

export type RemoteQuotaWindow = {
  id: string;
  provider: string;
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

export function driverKindsForWindow(window: RemoteQuotaWindow): string[] {
  const hay = `${window.provider} ${window.sourceApp} ${window.label}`.toLowerCase();
  if (hay.includes("antigravity") || hay.includes("gemini")) return ["antigravityAgent"];
  if (hay.includes("codex") || hay.includes("openai")) return ["codexAgent"];
  if (hay.includes("anthropic") || hay.includes("claude")) return ["claudeAgent"];
  if (hay.includes("grok") || hay.includes("xai")) return ["grokAgent", "grok"];
  if (hay.includes("minimax")) return ["minimaxAgent"];
  return [];
}

export function familiesForWindow(window: RemoteQuotaWindow): string[] {
  const label = window.label.toLowerCase();
  if (label.includes("claude and gpt")) return ["claude-opus", "claude-sonnet", "claude-haiku", "claude", "gpt"];
  if (label.includes("gemini")) return ["gemini-pro", "gemini-flash", "gemini"];
  return window.modelType ? [window.modelType] : [];
}

export function modelTypeFromId(modelId: string): string {
  const raw = modelId.toLowerCase();
  if (/opus/.test(raw)) return "claude-opus";
  if (/sonnet/.test(raw)) return "claude-sonnet";
  if (/haiku/.test(raw)) return "claude-haiku";
  if (/claude/.test(raw)) return "claude";
  if (/gemini/.test(raw) && /pro/.test(raw)) return "gemini-pro";
  if (/gemini/.test(raw) && /flash/.test(raw)) return "gemini-flash";
  if (/gemini/.test(raw)) return "gemini";
  if (/gpt|codex/.test(raw)) return "gpt";
  if (/grok/.test(raw)) return "grok";
  return raw;
}

export function modelsToSkip(window: RemoteQuotaWindow, instance: QuotaPollerInstance): string[] {
  if (!window.skip) return [];
  if (window.modelId) return [window.modelId];
  const families = new Set(familiesForWindow(window));
  const options = instance.models?.options ?? [];
  return options.map((row) => row.id).filter((id) => families.has(modelTypeFromId(id)));
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
  private lastError: string | null = null;
  private lastOkAt: string | null = null;
  private inFlight = false;

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
    return this.windows;
  }

  getStatus(): { lastError: string | null; lastOkAt: string | null; windowCount: number } {
    return {
      lastError: this.lastError,
      lastOkAt: this.lastOkAt,
      windowCount: this.windows.length,
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
        for (const model of models) {
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
    const settings = this.settingsProvider?.() ?? {};
    const url = quotaWindowsUrl(settings.ingestUrl);
    const token =
      settings.readToken?.trim() ||
      process.env.USAGE_READ_TOKEN?.trim() ||
      "";
    if (!url || !token) {
      this.windows = [];
      return;
    }
    this.inFlight = true;
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
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
