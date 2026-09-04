// App settings → Usage: what every bot has spent, so "which of my bots is
// costing me money" is answerable without a provider dashboard. Figures are
// banked per settled turn on each task (server/store.ts addTaskUsage) and
// summed here; nothing is fetched.
import * as React from "react";
import { Check, CheckCircle, ChevronDown, Loader2, RefreshCw, XCircle } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { MausAvatar } from "./Avatar";
import { Card } from "./SettingsPrimitives";
import { ProviderMark } from "./ProviderIcons";
import { deepSeekPriceRows } from "@/lib/deepseek-prices";
import { telemetryBadge, telemetryHost, type TelemetryStatusView } from "@/lib/telemetry-status";
import { buildUsageConfigPatch } from "@/lib/usage-config";
import { antigravityQuotaLines, quotaLinesSummary, usageWindowLines } from "@/lib/quota-display";
import { isPlanLevelSkip, windowsForDriver } from "../../server/quota-window-map";
import { botUsage, cachedInput, costCaption, formatTokens, formatUsd, hasFiniteCost, sumUsage, usageDetail } from "@/lib/usage";

interface QuotaCooldownInfo {
  botId: string;
  instanceId: string;
  model: string;
  resetsAt?: number | null;
  error: string;
  recordedAt: number;
}

interface AntigravityUsageModel {
  label: string;
  modelId: string;
  remainingPercentage?: number;
  isExhausted: boolean;
  resetTime?: string;
  isAutocompleteOnly?: boolean;
}

interface AntigravityUsageSnapshot {
  timestamp: string;
  method?: string;
  models: AntigravityUsageModel[];
}

function formatCountdown(resetsAt?: number | null): string {
  if (!resetsAt) return "Rolling refresh window";
  const diffMs = resetsAt - Date.now();
  if (diffMs <= 0) return "Refreshing now";
  const diffSec = Math.floor(diffMs / 1000);
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  if (hours > 0) return `Resets in ${hours}h ${minutes}m`;
  return `Resets in ${minutes}m`;
}

export function UsageSection() {
  const { state, dispatch } = useStore();
  const [telemetryStatus, setTelemetryStatus] = React.useState<TelemetryStatusView | null>(null);
  const [telemetryFetchError, setTelemetryFetchError] = React.useState<string | null>(null);
  const [quotas, setQuotas] = React.useState<QuotaCooldownInfo[]>([]);
  const [antigravityQuota, setAntigravityQuota] = React.useState<AntigravityUsageSnapshot | null>(null);
  const [quotaWindows, setQuotaWindows] = React.useState<Array<{
    id: string;
    provider: string;
    sourceApp?: string | null;
    label: string;
    remainingPercent: number | null;
    resetAt: string | null;
    skip: boolean;
    status: string;
    window?: string | null;
    modelId?: string | null;
    skipReason?: string | null;
  }>>([]);
  const [expandedQuota, setExpandedQuota] = React.useState<string | null>(null);
  const usageConfig = state.config?.usage;
  const [ingestUrl, setIngestUrl] = React.useState(usageConfig?.ingestUrl ?? "");
  const [ingestToken, setIngestToken] = React.useState("");
  const [readToken, setReadToken] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveOk, setSaveOk] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; error: string | null } | null>(null);

  React.useEffect(() => {
    if (usageConfig?.ingestUrl !== undefined) setIngestUrl(usageConfig.ingestUrl);
  }, [usageConfig?.ingestUrl]);

  React.useEffect(() => {
    fetch("/api/telemetry/status")
      .then((res) => res.json())
      .then((data) => {
        setTelemetryStatus(data && typeof data === "object" ? data : null);
        setTelemetryFetchError(null);
      })
      .catch(() => {
        setTelemetryFetchError("Failed to fetch telemetry status");
      });

    fetch("/api/quotas")
      .then((res) => res.json())
      .then((data) => {
        if (data?.ok && Array.isArray(data.cooldowns)) {
          setQuotas(data.cooldowns);
        }
        if (data?.antigravity && Array.isArray(data.antigravity.models)) {
          setAntigravityQuota(data.antigravity);
        }
        if (Array.isArray(data?.windows)) {
          setQuotaWindows(data.windows);
        }
      })
      .catch(() => {});
  }, []);
  const badge = telemetryBadge(telemetryStatus, telemetryFetchError);
  // Whatever host the operator pointed this at — never a built-in name.
  const host = telemetryHost(telemetryStatus);

  const refreshTelemetry = async () => {
    try {
      const refreshed = await fetch("/api/telemetry/status").then((r) => r.json());
      setTelemetryStatus(refreshed && typeof refreshed === "object" ? refreshed : null);
      setTelemetryFetchError(null);
    } catch {
      setTelemetryFetchError("Failed to fetch telemetry status");
    }
  };

  const saveUsage = async (): Promise<boolean> => {
    const built = buildUsageConfigPatch({ ingestUrl, ingestToken, readToken });
    if (!built.ok) {
      setSaveError(built.error);
      setSaveOk(false);
      return false;
    }
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ usage: built.patch }),
      });
      dispatch({ type: "configStatus", config });
      if (built.patch.ingestToken) setIngestToken("");
      if (built.patch.readToken) setReadToken("");
      await refreshTelemetry();
      setSaveOk(true);
      return true;
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const saved = await saveUsage();
      if (!saved) {
        setTestResult({ ok: false, error: "Save the URL and ingest token before testing." });
        return;
      }
      const res = await fetch("/api/telemetry/test", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string | null };
      setTestResult({
        ok: Boolean(data.ok),
        error: data.ok ? null : (data.error || "Usage Monitor did not accept the probe."),
      });
      await refreshTelemetry();
    } catch (caught) {
      setTestResult({ ok: false, error: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setTesting(false);
    }
  };

  const canTest = Boolean(ingestUrl.trim() || usageConfig?.ingestUrl) && Boolean(ingestToken.trim() || usageConfig?.hasToken);

  const usageInputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

  const rows = state.bots
    .filter((b) => !b.hidden)
    .map((bot) => {
      const usage = botUsage(bot);
      const instance = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
      return { bot, usage, billing: instance?.snapshot.billing };
    })
    .filter((r) => r.usage.turns > 0)
    // money first, then volume. Non-finite/missing costs sort last.
    .sort((a, b) => {
      const costOf = (value: number | null | undefined) =>
        hasFiniteCost(value) ? value : Number.NEGATIVE_INFINITY;
      return costOf(b.usage.costUsd) - costOf(a.usage.costUsd) || b.usage.input + b.usage.output - (a.usage.input + a.usage.output);
    });
  const total = sumUsage(rows.map((r) => r.usage));
  const billings = new Set(rows.map((r) => r.billing));

  return (
    <div className="flex flex-col gap-4">
      <Card title="Usage" subtitle="Tokens and cost per bot, added up from every settled turn.  A turn that ran on a fallback is billed as that fallback reported it, not as the bot's current model.  Only engines that report a price show one.">
        {rows.length === 0 ? (
          <div className="text-[13px] text-ink-secondary">Nothing spent yet — figures appear after a bot's first turn.</div>
        ) : (
          <div className="flex flex-col">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-5 border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
              <span>Bot</span>
              <span className="text-right">Turns</span>
              <span className="text-right">Tokens</span>
              <span className="text-right">Cost</span>
            </div>
            {rows.map(({ bot, usage }) => (
              <div key={bot.id} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-5 border-b border-hairline/20 py-2 text-[13px]">
                <span className="flex min-w-0 items-center gap-2 text-ink">
                  <MausAvatar color={bot.color} state="idle" size={22} animated={false} />
                  <span className="truncate" title={bot.name}>{bot.name}</span>
                </span>
                <span className="text-right tabular-nums text-ink-secondary">{usage.turns}</span>
                <span className="text-right tabular-nums text-ink" title={usageDetail(usage)}>
                  {formatTokens(usage.input + usage.output)}
                </span>
                <span className="text-right tabular-nums text-ink">{hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : <span className="text-ink-secondary">—</span>}</span>
              </div>
            ))}
            <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-5 pt-2.5 text-[13px] font-medium text-ink">
              <span>All bots</span>
              <span className="text-right tabular-nums">{total.turns}</span>
              <span className="text-right tabular-nums" title={usageDetail(total)}>{formatTokens(total.input + total.output)}</span>
              <span className="text-right tabular-nums">{hasFiniteCost(total.costUsd) ? formatUsd(total.costUsd) : "—"}</span>
            </div>
            {cachedInput(total) > 0 && (
              <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
                Tokens count everything the model read and wrote. Each turn resends the whole conversation with the system prompt and tool
                schemas, so {formatTokens(cachedInput(total))} of the input was context re-read from the provider's cache rather than new text —
                hover a figure for the split.
              </div>
            )}
            {hasFiniteCost(total.costUsd) && (
              <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
                Cost is {billings.size === 1 ? costCaption([...billings][0]) : "as each engine reports it — on a subscription it's an equivalent, not a charge"}.
              </div>
            )}
          </div>
        )}
      </Card>

      <Card
        title="Fleet Quotas & Provider Caps"
        subtitle="Live quota tracking and session limits across fleet engines.  Hover or click a row for the full remaining breakdown."
      >
        <div className="flex flex-col divide-y divide-hairline/20">
          {state.instances.map((instance) => {
            const wildcardCap = Boolean(instance.snapshot.quota?.capped);
            const instanceCooldowns = quotas.filter((q) => q.instanceId === instance.instanceId);
            const quotaCooldown = instanceCooldowns.find((q) => q.model === "*") ?? instanceCooldowns[0];
            const agModels = instance.instanceId === "antigravity"
              ? (antigravityQuota?.models ?? []).filter((model) => !model.isAutocompleteOnly)
              : [];
            const agLines = antigravityQuotaLines(agModels);
            const instanceWindows = windowsForDriver(quotaWindows, instance.driverKind);
            const windowLines = usageWindowLines(instanceWindows);
            const planSkip = instanceWindows.some((window) => isPlanLevelSkip(window));
            const agExhausted = agLines.filter((line) => line.exhausted);
            const isCapped = wildcardCap || planSkip || (agLines.length > 0
              ? agExhausted.length === agLines.length
              : instanceCooldowns.some((q) => q.model === "*"));
            const isPartial = !isCapped && (agExhausted.length > 0 || instanceCooldowns.some((q) => q.model !== "*"));
            const isDisabled = instance.snapshot.reason === "Disabled in settings";
            const isAvailable = instance.snapshot.state === "available" && !isCapped && !isDisabled;
            const detailLines = agLines.length > 0 ? agLines : windowLines;
            const fullSummary = detailLines.length > 0
              ? quotaLinesSummary(detailLines)
              : null;
            const statusLine = fullSummary
              ? fullSummary
              : isCapped
              ? `${quotaCooldown?.error ?? "Session limit or usage quota reached"} · ${formatCountdown(quotaCooldown?.resetsAt)}`
              : isPartial
              ? `${quotaCooldown?.error ?? "Some models are at a usage cap"} · ${formatCountdown(quotaCooldown?.resetsAt)}`
              : isDisabled
              ? "Disabled in settings · subscription inactive"
              : isAvailable
              ? instance.snapshot.version ? `v${instance.snapshot.version} · Ready` : "Active and ready for turns"
              : instance.snapshot.reason ?? "Unavailable";
            const open = expandedQuota === instance.instanceId;

            return (
              <div key={instance.instanceId} className="py-1">
                <button
                  type="button"
                  onClick={() => setExpandedQuota(open ? null : instance.instanceId)}
                  aria-expanded={open}
                  title={statusLine}
                  className="flex w-full items-center justify-between py-1.5 text-left text-[13px] hover:bg-control/40 rounded-lg px-1 -mx-1"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-control/60">
                      <ProviderMark driverKind={instance.driverKind} size={16} />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-ink">{instance.displayName}</span>
                      <span className="truncate text-[11.5px] text-ink-secondary">
                        {statusLine}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 pl-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                        isCapped
                          ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                          : isPartial
                          ? "bg-amber-500/10 text-amber-800 dark:text-amber-200"
                          : isDisabled
                          ? "bg-inset text-ink-secondary"
                          : isAvailable
                          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                          : "bg-inset text-ink-secondary"
                      }`}
                    >
                      {isCapped ? "At Usage Cap" : isPartial ? "Partial cap" : isDisabled ? "Disabled" : isAvailable ? "Available" : "Unavailable"}
                    </span>
                    <ChevronDown
                      size={14}
                      className={cn("text-ink-secondary transition-transform", open && "rotate-180")}
                    />
                  </div>
                </button>
                {open && detailLines.length > 0 && (
                  <div className="mb-1.5 ml-9 flex flex-col gap-1 rounded-lg border border-hairline/20 bg-inset/30 p-2.5">
                    {detailLines.map((line) => (
                      <div key={`${line.group}:${line.label}`} className="flex items-center justify-between gap-3 text-[12px]">
                        <span className="min-w-0 truncate text-ink" title={line.label}>{line.label}</span>
                        <span className={cn("shrink-0 tabular-nums", line.exhausted ? "text-amber-700 dark:text-amber-300" : "text-ink-secondary")}>
                          {line.value}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {quotaWindows.length > 0 ? (
          <div className="mt-3 flex flex-col gap-1.5 rounded-lg border border-hairline/20 bg-inset/20 p-3">
            <div className="text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">Remaining from Usage Monitor</div>
            {quotaWindows.slice(0, 12).map((window) => (
              <div key={window.id} className="flex items-center justify-between gap-3 text-[12.5px]">
                <span className="min-w-0 truncate text-ink" title={window.label}>{window.label}</span>
                <span className={`shrink-0 tabular-nums ${window.skip ? "text-amber-700 dark:text-amber-300" : "text-ink-secondary"}`}>
                  {window.remainingPercent == null ? "not reported" : `${window.remainingPercent}%`}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
          Antigravity remaining percent is read locally from the antigravity-usage CLI every minute.  Other engines use Usage Monitor remaining windows when a read token is set.  Exhausted models fail over to the saved chain before the next turn.
        </div>
      </Card>

      <Card
        title="Model Rates & Pricing Breakdown"
        subtitle="Standard per-token pricing comparison across supported fleet engines and models."
      >
        <div className="flex flex-col">
          <div className="grid grid-cols-[1.5fr_1fr_1fr_1fr] gap-x-3 border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
            <span>Model</span>
            <span className="text-right">Input / 1M</span>
            <span className="text-right">Cache Hit</span>
            <span className="text-right">Output / 1M</span>
          </div>
          {[
            ...deepSeekPriceRows(),
            { model: "Grok 3 (CLI)", provider: "xAI", input: "Subscription", cache: "Included", output: "Included", badge: "CLI" },
            { model: "Claude 3.7 Sonnet (CLI)", provider: "Anthropic", input: "Subscription", cache: "Included", output: "Included", badge: "CLI" },
            { model: "Codex / GPT-5.4 (CLI)", provider: "OpenAI", input: "Subscription", cache: "Included", output: "Included", badge: "CLI" },
            { model: "Antigravity / Gemini", provider: "Google", input: "Free / Pro", cache: "Included", output: "Included", badge: "CLI" },
          ].map((row) => (
            <div key={row.model} className="grid grid-cols-[1.5fr_1fr_1fr_1fr] items-center gap-x-3 border-b border-hairline/20 py-2.5 text-[13px]">
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-ink" title={row.model}>{row.model}</span>
                <span className="text-[11px] text-ink-secondary">{row.provider} · {row.badge}</span>
              </div>
              <span className="text-right tabular-nums text-ink">{row.input}</span>
              <span className="text-right tabular-nums text-ink-secondary">{row.cache}</span>
              <span className="text-right tabular-nums text-ink font-medium">{row.output}</span>
            </div>
          ))}
          <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
            Prices for API-billed engines (such as OpenRouter) are calculated directly from input and output token counts each turn. CLI-authenticated engines run against your active subscription.
          </div>
        </div>
      </Card>

      <Card
        title="Usage Monitor & Central Accounting"
        subtitle="An optional, lightweight telemetry stream reporting token consumption classified by model, project, and repository to a usage monitor you run.  Nothing is sent until you set an endpoint and a token."
      >
        <div className="flex flex-col gap-3 text-[13px]">
          <div className="flex items-center justify-between rounded-xl border border-hairline/30 bg-inset/40 px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <span
                className={`flex size-2 rounded-full ${
                  badge.tone === "error"
                    ? "bg-danger shadow-[0_0_8px_rgba(239,68,68,0.6)]"
                    : badge.tone === "active"
                      ? "bg-success shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse"
                      : badge.tone === "waiting"
                        ? "bg-warning"
                        : "bg-ink-secondary/40"
                }`}
              />
              <span className="font-medium text-ink">Usage Monitor</span>
              <span className="text-[11.5px] text-ink-secondary font-mono">{host ?? "Not configured"}</span>
            </div>
            <span
              className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                badge.tone === "error"
                  ? "bg-danger/15 text-danger"
                  : badge.tone === "active"
                    ? "bg-success/15 text-success"
                    : "bg-inset text-ink-secondary"
              }`}
              title={telemetryFetchError || telemetryStatus?.lastError || undefined}
            >
              {badge.label}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-4">
            <div className="flex flex-col rounded-lg border border-hairline/20 bg-inset/20 p-2">
              <span className="text-ink-secondary">Classification</span>
              <span className="font-medium text-ink">Project & Repo</span>
            </div>
            <div className="flex flex-col rounded-lg border border-hairline/20 bg-inset/20 p-2">
              <span className="text-ink-secondary">Schema</span>
              <span className="font-medium text-ink">Telemetry v2</span>
            </div>
            <div className="flex flex-col rounded-lg border border-hairline/20 bg-inset/20 p-2">
              <span className="text-ink-secondary">Transport</span>
              <span className="font-medium text-ink">Non-blocking HTTP</span>
            </div>
            <div className="flex flex-col rounded-lg border border-hairline/20 bg-inset/20 p-2">
              <span className="text-ink-secondary">Privacy</span>
              <span className="font-medium text-ink">Secret-Safe Metrics</span>
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-xl border border-hairline/30 bg-inset/20 p-3">
            <div className="flex flex-col gap-1">
              <label className="text-[12px] font-medium text-ink-secondary" htmlFor="usage-ingest-url">
                Usage Monitor URL
              </label>
              <input
                id="usage-ingest-url"
                type="url"
                value={ingestUrl}
                onChange={(e) => {
                  setIngestUrl(e.target.value);
                  setSaveOk(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && void saveUsage()}
                placeholder="https://usage.example.com"
                autoComplete="off"
                className={usageInputClass}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[12px] font-medium text-ink-secondary" htmlFor="usage-ingest-token">
                Ingest Token
              </label>
              <input
                id="usage-ingest-token"
                type="password"
                value={ingestToken}
                onChange={(e) => {
                  setIngestToken(e.target.value);
                  setSaveOk(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && void saveUsage()}
                placeholder={usageConfig?.hasToken ? "••••••••  (paste to replace)" : "Leave blank to keep telemetry off"}
                autoComplete="off"
                className={usageInputClass}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[12px] font-medium text-ink-secondary" htmlFor="usage-read-token">
                Read Token
              </label>
              <input
                id="usage-read-token"
                type="password"
                value={readToken}
                onChange={(e) => {
                  setReadToken(e.target.value);
                  setSaveOk(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && void saveUsage()}
                placeholder={usageConfig?.hasReadToken ? "••••••••  (paste to replace)" : "USAGE_READ_TOKEN from Usage Monitor"}
                autoComplete="off"
                className={usageInputClass}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void saveUsage()}
                disabled={saving}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Save
              </button>
              <button
                type="button"
                onClick={() => void testConnection()}
                disabled={saving || testing || !canTest}
                className="flex items-center gap-1.5 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] font-medium text-ink hover:bg-control disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw size={13} className={cn(testing && "animate-spin")} />
                {testing ? "Testing..." : "Test Connection"}
              </button>
              {saveOk && !saveError && (
                <span className="flex items-center gap-1 text-[12.5px] text-success">
                  <CheckCircle size={14} />
                  Saved
                </span>
              )}
              {testResult && (
                <span className={cn("flex items-center gap-1.5 text-[12.5px]", testResult.ok ? "text-success" : "text-danger")}>
                  {testResult.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
                  <span
                    className="max-w-[320px] truncate"
                    title={testResult.ok ? "Usage Monitor accepted the probe" : testResult.error || "Not reachable"}
                  >
                    {testResult.ok ? "Usage Monitor accepted the probe" : testResult.error || "Not reachable"}
                  </span>
                </span>
              )}
            </div>
            {saveError && (
              <div role="alert" className="text-[12px] text-danger">
                {saveError}
              </div>
            )}
            <div className="text-[12px] leading-relaxed text-ink-secondary">
              Save stores the URL and tokens on this computer.{'\u00A0'} Test Connection posts a one-token probe to the ingest endpoint so you can see whether Usage Monitor accepted it.{'\u00A0'} Leave a token field blank to keep the stored value.{'\u00A0'} Ingest token sends settled-turn usage.{'\u00A0'} Read token pulls remaining-percent windows so this page can skip exhausted models.{'\u00A0'} Antigravity does not need the read token because it uses the local antigravity-usage CLI.
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
