// App settings → Usage: what every bot has spent, so "which of my bots is
// costing me money" is answerable without a provider dashboard. Figures are
// banked per settled turn on each task (server/store.ts addTaskUsage) and
// summed here; nothing is fetched.
import * as React from "react";
import { Check, CheckCircle, ChevronDown, Loader2, RefreshCw, XCircle } from "lucide-react";
import { api, useSecretSources, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { MausAvatar } from "./Avatar";
import { Card } from "./SettingsPrimitives";
import { ProviderMark } from "./ProviderIcons";
import { SecretSourceBadge } from "./SecretSourceBadge";
import { deepSeekPriceRows } from "@/lib/deepseek-prices";
import { minimaxPriceRows } from "@/lib/minimax-prices";
import { telemetryBadge, telemetryHost, type TelemetryStatusView } from "@/lib/telemetry-status";
import { buildUsageConfigPatch } from "@/lib/usage-config";
import { antigravityGroupSummary, antigravityQuotaLines, formatResetCountdown, isEngineUnconfigured, minimaxQuotaLine, quotaLinesSummary, usageWindowLines, windowHeadlines, windowsLabelFromHeadlines } from "@/lib/quota-display";
import { engineMeterNote, isPlanLevelSkip, windowsForDriver } from "../../server/quota-window-map";
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
  promptCredits?: {
    available?: number;
    monthly?: number;
    usedPercentage?: number;
    remainingPercentage?: number;
  };
}

interface DeepSeekBalanceView {
  balanceUsd: number | null;
  grantedUsd: number | null;
  toppedUpUsd: number | null;
  availability: "available" | "exhausted" | "unknown";
  fetchedAt: number;
  error: string | null;
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

function formatUsdBalance(balance: number | null): string {
  if (balance == null) return "Balance unavailable";
  if (balance === 0) return "$0.00 remaining";
  return `$${balance.toFixed(2)} remaining`;
}

function formatSpendUsd(amount: number): string {
  if (!amount || amount === 0) return "$0.00";
  if (amount < 0.01) return `<$0.01 ($${amount.toFixed(4)})`;
  return `$${amount.toFixed(2)}`;
}

export function UsageSection() {
  const { state, dispatch } = useStore();
  const [telemetryStatus, setTelemetryStatus] = React.useState<TelemetryStatusView | null>(null);
  const [telemetryFetchError, setTelemetryFetchError] = React.useState<string | null>(null);
  const [quotas, setQuotas] = React.useState<QuotaCooldownInfo[]>([]);
  const [antigravityQuota, setAntigravityQuota] = React.useState<AntigravityUsageSnapshot | null>(null);
  const [deepseekBalance, setDeepSeekBalance] = React.useState<DeepSeekBalanceView | null>(null);
  const [engineSpend, setEngineSpend] = React.useState<Record<string, { spend5hUsd: number; spend7dUsd: number }>>({});
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
  const secretSources = useSecretSources();
  const infisicalConfigured = Boolean(state.config?.infisical?.configured);
  const writeThrough = Boolean(state.config?.infisical?.writeThrough);
  const ingestUrlSource = secretSources.get("usage.ingestUrl");
  const ingestTokenSource = secretSources.get("usage.ingestToken");
  const readTokenSource = secretSources.get("usage.readToken");
  // A 409 the operator cannot explain is the failure this prevents: with
  // Write Through off, Infisical is the only place a managed field can
  // change, so it disables outright instead of failing a save silently.
  const ingestUrlLocked = (ingestUrlSource?.managed ?? false) && !writeThrough;
  const ingestTokenLocked = (ingestTokenSource?.managed ?? false) && !writeThrough;
  const readTokenLocked = (readTokenSource?.managed ?? false) && !writeThrough;
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

    const fetchQuotas = () => {
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
          if (data?.deepseek && typeof data.deepseek === "object") {
            setDeepSeekBalance(data.deepseek);
          }
          // MiniMax's balance/quota is no longer on this payload — it is
          // per-instance (a second connection has its own account) and
          // reaches the client on that instance's own GET /api/instances
          // snapshot.quota.minimax instead. See server/index.ts's comment
          // on this route.
          if (data?.engineSpend && typeof data.engineSpend === "object") {
            setEngineSpend(data.engineSpend);
          }
        })
        .catch(() => {});
    };
    fetchQuotas();
    const quotaInterval = setInterval(fetchQuotas, 30_000);
    return () => clearInterval(quotaInterval);
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
      // ingestUrl is always present in the built patch (blank means "clear"),
      // but the field disables outright when Infisical manages it and Write
      // Through is off — it cannot have changed here, and resending its
      // current value on every unrelated save would hit the 409 refusal gate
      // just for saving the read token.  ingestToken/readToken need no such
      // handling: their inputs are disabled the same way, and both are
      // already omitted from the patch whenever the field reads blank.
      const { ingestUrl: lockedIngestUrl, ...patchWithoutIngestUrl } = built.patch;
      void lockedIngestUrl;
      const usagePatch = ingestUrlLocked ? patchWithoutIngestUrl : built.patch;
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ usage: usagePatch }),
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
          {state.instances.filter((instance) => {
            if (instance.enabled === false) return false;
            const isDeepSeek =
              instance.driverKind === "deepseekAgent" ||
              instance.driverKind === "deepseek";
            const spend =
              engineSpend[instance.driverKind] ??
              engineSpend[instance.instanceId] ??
              (isDeepSeek ? (engineSpend["deepseek"] ?? engineSpend["deepseekAgent"]) : undefined);
            const instanceCooldowns = quotas.filter((q) => q.instanceId === instance.instanceId);
            const instanceWindows = windowsForDriver(quotaWindows, instance.driverKind);
            const isMiniMax = instance.driverKind === "minimax";
            const hasQuotaData =
              Boolean(instance.snapshot.quota?.capped) ||
              Boolean(instance.snapshot.quota?.models && Object.keys(instance.snapshot.quota.models).length > 0) ||
              instanceCooldowns.length > 0 ||
              instanceWindows.length > 0 ||
              (instance.instanceId === "antigravity" && (antigravityQuota?.models?.length ?? 0) > 0) ||
              (isDeepSeek && deepseekBalance?.balanceUsd != null) ||
              // MiniMax's row must render whenever the engine is configured,
              // not only once it's capped or has spent something — a fresh
              // Token Plan/pay-as-you-go account with a real capExists
              // reading counts as "has quota data" on its own. Read off this
              // INSTANCE's own snapshot (server/harness/registry.ts computes
              // it per instance) — never a value shared across every
              // MiniMax row, which is what let a second connection show the
              // reserved instance's numbers.
              (isMiniMax && Boolean(instance.snapshot.quota?.minimax?.capExists)) ||
              Boolean(spend && (spend.spend5hUsd > 0 || spend.spend7dUsd > 0));
            // A configured engine that has gone unavailable — a Box token set
            // but the API unreachable, a login that expired, a CLI that stops
            // launching — must still show its row with the real failure
            // reason below. Only engines never set up (no CLI, no key/token)
            // or explicitly disabled are worth hiding when they have no
            // quota data of their own.
            if (instance.snapshot.state !== "available" && !hasQuotaData) {
              return !isEngineUnconfigured(instance.snapshot.reason);
            }
            return true;
          }).map((instance) => {
            const wildcardCap = Boolean(instance.snapshot.quota?.capped);
            const instanceCooldowns = quotas.filter((q) => q.instanceId === instance.instanceId);
            const quotaCooldown = instanceCooldowns.find((q) => q.model === "*") ?? instanceCooldowns[0];
            const agModels = instance.instanceId === "antigravity"
              ? (antigravityQuota?.models ?? []).filter((model) => !model.isAutocompleteOnly)
              : [];
            const agGroups = antigravityGroupSummary(agModels, antigravityQuota?.promptCredits);
            const agLines = antigravityQuotaLines(agModels, antigravityQuota?.promptCredits);
            const instanceWindows = windowsForDriver(quotaWindows, instance.driverKind);
            const headlines = windowHeadlines(instanceWindows);
            const windowLines = usageWindowLines(instanceWindows);
            const planSkip = instanceWindows.some((window) => isPlanLevelSkip(window));
            const agExhausted = agGroups.filter((line) => line.exhausted);
            const isMiniMax = instance.driverKind === "minimax";
            const minimaxRow = isMiniMax ? instance.snapshot.quota?.minimax ?? null : null;
            const minimaxLine = minimaxRow ? minimaxQuotaLine(minimaxRow) : null;
            // The cap verdict accounts for Antigravity group exhaustion too:
            // the user's complaint was a four-name slice hiding an all-spent
            // group behind a "70% remaining" average. With the two-line
            // summary, an all-spent group reads as exhausted directly.
            const isCapped = wildcardCap || planSkip || minimaxRow?.status === "capped" || (agGroups.length > 0
              ? agExhausted.length === agGroups.length
              : instanceCooldowns.some((q) => q.model === "*"));
            // DeepSeek balance only applies to the DeepSeek engine. Surfaced
            // as a third status line so the user can see "$12.34 remaining"
            // (or "Balance unavailable") without expanding the row.
            const isDeepSeek =
              instance.driverKind === "deepseekAgent" ||
              instance.driverKind === "deepseek";
            const deepseekRow = isDeepSeek
              ? deepseekBalance
              : null;
            // deepseek-balance.ts's own contract: "Set when the key is
            // missing, the request failed, or the response was not
            // parseable. The UI hides the chip when this is set." — so the
            // line is shown only when there is an actual balance to report,
            // never as a substitute for the engine's real state (capped,
            // disabled, unavailable) below.
            const deepseekLine = deepseekRow && !deepseekRow.error && deepseekRow.balanceUsd != null
              ? formatUsdBalance(deepseekRow.balanceUsd)
              : null;
            const spend =
              engineSpend[instance.driverKind] ??
              engineSpend[instance.instanceId] ??
              (isDeepSeek ? (engineSpend["deepseek"] ?? engineSpend["deepseekAgent"]) : undefined);
            let deepseekStatus = deepseekLine;
            if (deepseekLine && spend) {
              deepseekStatus = `${deepseekLine}  ·  Spent: ${formatSpendUsd(spend.spend5hUsd)} (5h) · ${formatSpendUsd(spend.spend7dUsd)} (week)`;
            } else if (spend && (spend.spend5hUsd > 0 || spend.spend7dUsd > 0)) {
              deepseekStatus = `Spent: ${formatSpendUsd(spend.spend5hUsd)} (5h) · ${formatSpendUsd(spend.spend7dUsd)} (week)`;
            }
            // Same "quota headline + spend" composition as DeepSeek above,
            // for MiniMax's own quota/balance line — the only other engine
            // with both a real quota reading and a real per-turn cost today.
            let minimaxStatus = minimaxLine;
            if (isMiniMax && minimaxLine && spend) {
              minimaxStatus = `${minimaxLine}  ·  Spent: ${formatSpendUsd(spend.spend5hUsd)} (5h) · ${formatSpendUsd(spend.spend7dUsd)} (week)`;
            } else if (isMiniMax && spend && (spend.spend5hUsd > 0 || spend.spend7dUsd > 0)) {
              minimaxStatus = `Spent: ${formatSpendUsd(spend.spend5hUsd)} (5h) · ${formatSpendUsd(spend.spend7dUsd)} (week)`;
            }
            const isPartial = !isCapped && (agExhausted.length > 0 || instanceCooldowns.some((q) => q.model !== "*") || minimaxRow?.status === "near_cap");
            const isDisabled = instance.snapshot.reason === "Disabled in settings";
            const isAvailable = instance.snapshot.state === "available" && !isCapped && !isDisabled;
            const baseDetailLines = agLines.length > 0 ? agLines : windowLines;
            const detailLines = [...baseDetailLines];
            if (minimaxRow && minimaxLine) {
              detailLines.unshift({
                label: minimaxRow.source === "account-balance" ? "Remaining Balance" : "Token Plan Quota",
                value: minimaxLine,
                exhausted: minimaxRow.status === "capped",
                group: "external" as const,
              });
            }
            if (isDeepSeek && deepseekRow && !deepseekRow.error && deepseekRow.balanceUsd != null) {
              detailLines.unshift({
                label: "Remaining Balance",
                value: formatUsdBalance(deepseekRow.balanceUsd),
                exhausted: deepseekRow.availability === "exhausted" || deepseekRow.balanceUsd <= 0,
                group: "external" as const,
              });
              if (deepseekRow.grantedUsd != null && deepseekRow.toppedUpUsd != null) {
                detailLines.push({
                  label: "Granted / Topped Up",
                  value: `$${deepseekRow.grantedUsd.toFixed(2)} granted · $${deepseekRow.toppedUpUsd.toFixed(2)} topped up`,
                  exhausted: false,
                  group: "external" as const,
                });
              }
            }
            if (spend && (spend.spend5hUsd > 0 || spend.spend7dUsd > 0 || isDeepSeek)) {
              detailLines.push({
                label: "Spend (Past 5 Hours)",
                value: formatSpendUsd(spend.spend5hUsd),
                exhausted: false,
                group: "window" as const,
              });
              detailLines.push({
                label: "Spend (Past Week)",
                value: formatSpendUsd(spend.spend7dUsd),
                exhausted: false,
                group: "window" as const,
              });
            }
            const fullSummary = detailLines.length > 0
              ? quotaLinesSummary(detailLines)
              : null;
            // The "headline" lines sit directly under the engine name: for
            // Antigravity, "Gemini %" and "Third-Party %" (with 5h and monthly countdowns); for
            // every other engine, the most-restrictive window per bucket
            // with the time-until-reset next to it. The chip on the right
            // (Available / At Usage Cap / …) is the verdict; the headline
            // is the numbers behind it.
            const headlineLines = agGroups.length > 0
              ? agGroups.map((group) => {
                  if (group.headline) return group.headline;
                  const value = group.remainingPercent == null
                    ? "not reported"
                    : `${group.remainingPercent}% available`;
                  let line = `${group.label}: ${value} (5h window)`;
                  if (group.group === "gemini") {
                    line += "; monthly pool (resets on ~17th)";
                  }
                  return line;
                })
              : [
                  // The wildcard cooldown (Cursor's monthly cap, an exhausted
                  // anonymous bucket from a custom driver, etc.) is a real
                  // signal the user needs to read in the headline strip —
                  // without it the chip says "At Usage Cap" with no source.
                  // Skip when Usage Monitor already produced a Monthly row.
                  ...(wildcardCap && !headlines.some((headline) => headline.display === "Monthly")
                    ? [{
                        display: "Monthly",
                        remainingPercent: 0,
                        resetAtMs: typeof quotaCooldown?.resetsAt === "number"
                          ? quotaCooldown.resetsAt
                          : typeof quotaCooldown?.resetsAt === "string"
                            ? Date.parse(quotaCooldown.resetsAt) || null
                            : null,
                      }]
                    : []),
                  ...headlines,
                ].map((headline) => {
                  const value = headline.remainingPercent == null
                    ? "not reported"
                    : `${headline.remainingPercent}% available`;
                  const reset = formatResetCountdown(headline.resetAtMs);
                  return reset ? `${headline.display} ${value} · resets in ${reset}` : `${headline.display} ${value}`;
                });
            const allHeadlineLines = [
              ...headlineLines,
              ...(deepseekStatus ? [deepseekStatus] : []),
              ...(minimaxStatus ? [minimaxStatus] : []),
            ];
            // Antigravity's own "Gemini"/"Third-Party" summary already names
            // its windows explicitly, so the combined badge below is only
            // for the other engines whose windows come through Usage
            // Monitor (Claude, Codex, Cursor, Kimi, Grok, DSH, DeepSeek) —
            // generalizing the "5hr" / "5hr/Week" vocabulary antigravity-quota.ts
            // and minimax-balance.ts already use, instead of leaving it
            // Antigravity-only.
            const combinedWindowsLabel = agGroups.length === 0 ? windowsLabelFromHeadlines(headlines) : undefined;
            // pi, qwen, hermes, opencodeGo and boxAgent have no Usage Monitor
            // window family at all (quota-window-map.ts's engineMeterNote) —
            // say so explicitly instead of falling through to generic
            // "Active and ready for turns" filler.
            const meterNote = engineMeterNote(instance.driverKind);
            // The engine's real state — capped, partially capped, disabled,
            // or otherwise unavailable — must win over a headline percentage
            // line, not the other way around: a stale "70% available" (or a
            // DeepSeek balance chip) sitting where "At Usage Cap" or
            // "Disabled in settings" belongs is what let the DeepSeek row
            // read "balance unavailable" forever instead of its real status.
            // The headline/fullSummary lines are shown only for the healthy,
            // uncapped path they were designed for.
            const statusLine = isCapped
              ? `${quotaCooldown?.error ?? "Session limit or usage quota reached"} · ${formatCountdown(quotaCooldown?.resetsAt)}`
              : isPartial
              ? `${quotaCooldown?.error ?? "Some models are at a usage cap"} · ${formatCountdown(quotaCooldown?.resetsAt)}`
              : isDisabled
              ? "Disabled in settings · subscription inactive"
              : !isAvailable
              ? instance.snapshot.reason ?? "Unavailable"
              : allHeadlineLines.length > 0
              ? allHeadlineLines.join("  ·  ")
              : fullSummary
              ? fullSummary
              : meterNote
              ? meterNote.copy
              : instance.snapshot.version ? `v${instance.snapshot.version} · Ready` : "Active and ready for turns";
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
                      <ProviderMark driverKind={instance.driverKind} size={16} iconUrl={instance.iconUrl} />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-ink">
                        {instance.displayName}
                        {combinedWindowsLabel && (
                          <span className="ml-1 font-normal text-[11px] text-ink-secondary">({combinedWindowsLabel})</span>
                        )}
                      </span>
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
        <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
          Antigravity remaining percent is read locally from the antigravity-usage CLI every minute and shown as "Gemini" and "Third-Party" only — with rolling 5-hour session windows and monthly pool resets.{'\u00A0'} Other engines surface their weekly and 5-hour caps directly.{'\u00A0'} Exhausted models fail over to the saved chain before the next turn.
        </div>
      </Card>

      <Card
        title="Model Rates & Pricing Breakdown"
        subtitle="Standard per-token pricing comparison across API-billed fleet engines and models."
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
            ...minimaxPriceRows(),
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
            Prices for API-billed engines (such as DeepSeek and MiniMax) are calculated directly from input and output token counts each turn.{'\u00A0'} MiniMax M3 turns whose prompt passes 512K input tokens bill at roughly double the listed rate, per MiniMax's own published tier.
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
              <div className="flex items-center gap-2">
                <label className="text-[12px] font-medium text-ink-secondary" htmlFor="usage-ingest-url">
                  Usage Monitor URL
                </label>
                <SecretSourceBadge source={ingestUrlSource?.source} infisicalConfigured={infisicalConfigured} />
              </div>
              <input
                id="usage-ingest-url"
                type="url"
                value={ingestUrl}
                onChange={(e) => {
                  setIngestUrl(e.target.value);
                  setSaveOk(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && void saveUsage()}
                placeholder={ingestUrlLocked ? "Managed by Infisical." : "https://usage.example.com"}
                autoComplete="off"
                disabled={ingestUrlLocked}
                className={cn(usageInputClass, ingestUrlLocked && "cursor-not-allowed opacity-60")}
              />
              {ingestUrlLocked && <div className="text-[11.5px] text-ink-secondary">Managed by Infisical.</div>}
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <label className="text-[12px] font-medium text-ink-secondary" htmlFor="usage-ingest-token">
                  Ingest Token
                </label>
                <SecretSourceBadge source={ingestTokenSource?.source} infisicalConfigured={infisicalConfigured} />
              </div>
              <input
                id="usage-ingest-token"
                type="password"
                value={ingestToken}
                onChange={(e) => {
                  setIngestToken(e.target.value);
                  setSaveOk(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && void saveUsage()}
                placeholder={
                  ingestTokenLocked
                    ? "Managed by Infisical."
                    : usageConfig?.hasToken
                      ? "••••••••  (paste to replace)"
                      : "Leave blank to keep telemetry off"
                }
                autoComplete="off"
                disabled={ingestTokenLocked}
                className={cn(usageInputClass, ingestTokenLocked && "cursor-not-allowed opacity-60")}
              />
              {ingestTokenLocked && <div className="text-[11.5px] text-ink-secondary">Managed by Infisical.</div>}
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <label className="text-[12px] font-medium text-ink-secondary" htmlFor="usage-read-token">
                  Read Token
                </label>
                <SecretSourceBadge source={readTokenSource?.source} infisicalConfigured={infisicalConfigured} />
              </div>
              <input
                id="usage-read-token"
                type="password"
                value={readToken}
                onChange={(e) => {
                  setReadToken(e.target.value);
                  setSaveOk(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && void saveUsage()}
                placeholder={
                  readTokenLocked
                    ? "Managed by Infisical."
                    : usageConfig?.hasReadToken
                      ? "••••••••  (paste to replace)"
                      : "USAGE_READ_TOKEN from Usage Monitor"
                }
                autoComplete="off"
                disabled={readTokenLocked}
                className={cn(usageInputClass, readTokenLocked && "cursor-not-allowed opacity-60")}
              />
              {readTokenLocked && <div className="text-[11.5px] text-ink-secondary">Managed by Infisical.</div>}
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
