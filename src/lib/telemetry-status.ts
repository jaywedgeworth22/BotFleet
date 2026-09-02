/** Shape of GET /api/telemetry/status (server/telemetry.ts TelemetryStatus). */
export type TelemetryStatusView = {
  enabled?: boolean;
  lastError?: string | null;
  lastAckAt?: string | null;
  totalSent?: number;
};

export type TelemetryBadge = {
  label: string;
  tone: "error" | "active" | "off" | "waiting";
};

/** Honest Usage Monitor badge.  Missing DSN / never posted is not "Active". */
export function telemetryBadge(
  status: TelemetryStatusView | null,
  fetchError?: string | null,
): TelemetryBadge {
  const lastError = fetchError || status?.lastError || null;
  if (lastError) return { label: "Error", tone: "error" };
  if (!status) return { label: "Waiting", tone: "waiting" };
  if (status.enabled && (status.lastAckAt || (status.totalSent ?? 0) > 0)) {
    return { label: "Active Telemetry", tone: "active" };
  }
  if (!status.enabled) return { label: "Not configured", tone: "off" };
  return { label: "Waiting", tone: "waiting" };
}
