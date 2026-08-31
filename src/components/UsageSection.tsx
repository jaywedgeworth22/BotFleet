// App settings → Usage: what every bot has spent, so "which of my bots is
// costing me money" is answerable without a provider dashboard. Figures are
// banked per settled turn on each task (server/store.ts addTaskUsage) and
// summed here; nothing is fetched.
import * as React from "react";
import { useStore } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { Card } from "./SettingsPrimitives";
import { botUsage, cachedInput, costCaption, formatTokens, formatUsd, hasFiniteCost, sumUsage, usageDetail } from "@/lib/usage";

export function UsageSection() {
  const { state } = useStore();
  const [telemetryError, setTelemetryError] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch("/api/telemetry/status")
      .then((res) => res.json())
      .then((data) => {
        if (data && data.lastError) {
          setTelemetryError(data.lastError);
        }
      })
      .catch(() => {
        setTelemetryError("Failed to fetch telemetry status");
      });
  }, []);

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
      <Card title="Usage" subtitle="Tokens and cost per bot, added up from every settled turn. Only engines that report a price show one.">
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
                  <span className="truncate">{bot.name}</span>
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
            { model: "DeepSeek V4 Flash", provider: "DeepSeek", input: "$0.07", cache: "$0.007", output: "$0.14", badge: "Ultra Cheap" },
            { model: "DeepSeek V4 Pro", provider: "DeepSeek", input: "$0.14", cache: "$0.014", output: "$0.28", badge: "Default MoE" },
            { model: "DeepSeek R1", provider: "DeepSeek", input: "$0.55", cache: "$0.14", output: "$2.19", badge: "Reasoner" },
            { model: "Grok 3 (CLI)", provider: "xAI", input: "Subscription", cache: "Included", output: "Included", badge: "CLI" },
            { model: "Claude 3.7 Sonnet (CLI)", provider: "Anthropic", input: "Subscription", cache: "Included", output: "Included", badge: "CLI" },
            { model: "Codex / GPT-5.4 (CLI)", provider: "OpenAI", input: "Subscription", cache: "Included", output: "Included", badge: "CLI" },
            { model: "Antigravity / Gemini", provider: "Google", input: "Free / Pro", cache: "Included", output: "Included", badge: "CLI" },
          ].map((row) => (
            <div key={row.model} className="grid grid-cols-[1.5fr_1fr_1fr_1fr] items-center gap-x-3 border-b border-hairline/20 py-2.5 text-[13px]">
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-ink">{row.model}</span>
                <span className="text-[11px] text-ink-secondary">{row.provider} · {row.badge}</span>
              </div>
              <span className="text-right tabular-nums text-ink">{row.input}</span>
              <span className="text-right tabular-nums text-ink-secondary">{row.cache}</span>
              <span className="text-right tabular-nums text-ink font-medium">{row.output}</span>
            </div>
          ))}
          <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
            Prices for API-billed engines (such as DeepSeek) are calculated directly from input and output token counts each turn. CLI-authenticated engines run against your active subscription.
          </div>
        </div>
      </Card>

      <Card
        title="Usage Monitor & Central Accounting"
        subtitle="Automatic, lightweight telemetry stream reporting token consumption classified by model, project, and repository to usage.jays.services."
      >
        <div className="flex flex-col gap-3 text-[13px]">
          <div className="flex items-center justify-between rounded-xl border border-hairline/30 bg-inset/40 px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <span className={`flex size-2 rounded-full ${telemetryError ? 'bg-danger shadow-[0_0_8px_rgba(239,68,68,0.6)]' : 'bg-success shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse'}`} />
              <span className="font-medium text-ink">Usage Monitor</span>
              <span className="text-[11.5px] text-ink-secondary font-mono">usage.jays.services</span>
            </div>
            {telemetryError ? (
              <span className="rounded bg-danger/15 px-2 py-0.5 text-[11px] font-medium text-danger" title={telemetryError}>
                Error
              </span>
            ) : (
              <span className="rounded bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
                Active Telemetry
              </span>
            )}
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

          <div className="text-[12px] leading-relaxed text-ink-secondary">
            Every settled turn records token metrics (input, output, cache hits), model selection, and working directory project classification into the Usage Monitor for real-time fleet accounting.
          </div>
        </div>
      </Card>
    </div>
  );
}
