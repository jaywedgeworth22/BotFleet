export type QdrantStatus = {
  configured?: boolean;
  state?: "unconfigured" | "degraded" | "ready";
  source?: "recall-cli" | "recall-service" | "unconfigured";
  checkedAt?: number;
  lastSuccessAt?: number | null;
  ready: boolean;
  error?: string;
  pointsCount?: number;
  collection?: string;
  collections?: string[];
};

export function qdrantRouteLabel(status: QdrantStatus | null, configuredUrl: string): string {
  const source = status?.source ?? (configuredUrl.trim() ? "recall-service" : "recall-cli");
  if (source === "recall-service") return "Recall service";
  if (source === "recall-cli") return "This Mac's recall CLI";
  return "Not configured";
}

export function qdrantStateLabel(status: QdrantStatus | null): string {
  if (!status) return "Not checked";
  if (status.state === "unconfigured" || status.source === "unconfigured") return "Not configured";
  if (status.state === "ready" || status.ready) return "Ready";
  return "Needs attention";
}

export function qdrantLastSuccessLabel(status: QdrantStatus | null): string {
  if (status?.lastSuccessAt == null) return "None recorded";
  return new Date(status.lastSuccessAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export async function settleQdrantSave<T>(operation: () => Promise<T>): Promise<
  { ok: true; value: T } | { ok: false; error: string }
> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not save shared memory settings.",
    };
  }
}
