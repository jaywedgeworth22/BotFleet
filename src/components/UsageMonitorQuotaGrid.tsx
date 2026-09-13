import { antigravityQuotaWindows, type UsageMonitorQuotaWindow } from "@/lib/usage-monitor-quota";
import { formatResetCountdown } from "@/lib/quota-display";

function percentLabel(window: UsageMonitorQuotaWindow): string {
  const percent = window.remainingPercent;
  if (percent == null || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    return "Not reported";
  }
  return `${Math.round(percent)}% remaining`;
}

function resetLabel(resetAt: string | null | undefined): string {
  if (!resetAt) return "Reset unknown";
  const parsed = Date.parse(resetAt);
  if (!Number.isFinite(parsed)) return "Reset unknown";
  if (parsed <= Date.now()) return "Awaiting refresh";
  return `Resets in ${formatResetCountdown(parsed)}`;
}

export function UsageMonitorQuotaGrid({ windows }: { windows: UsageMonitorQuotaWindow[] }) {
  const rows = antigravityQuotaWindows(windows);
  if (rows.length === 0) return null;

  return (
    <div className="ml-9 mt-1.5 grid grid-cols-2 gap-2" aria-label="Antigravity quota windows">
      {rows.map((window) => {
        const exhausted = window.skip || window.remainingPercent === 0;
        const resetAt = window.resetAt ?? undefined;
        return (
          <div
            key={`${window.providerKey ?? window.provider}:${window.window}:${window.label}`}
            className="rounded-lg border border-hairline/25 bg-inset/30 px-2.5 py-2"
          >
            <div className="truncate text-[11px] font-medium text-ink" title={window.label}>
              {window.label}
            </div>
            <div className={`mt-0.5 text-[12px] tabular-nums ${exhausted ? "text-amber-700 dark:text-amber-300" : "text-ink-secondary"}`}>
              {percentLabel(window)}
            </div>
            <div
              className="truncate text-[10.5px] text-ink-secondary"
              title={resetAt && Number.isFinite(Date.parse(resetAt)) ? new Date(resetAt).toLocaleString("en-US", {
                timeZone: "America/Chicago", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
              }) : undefined}
            >
              {resetLabel(resetAt)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
