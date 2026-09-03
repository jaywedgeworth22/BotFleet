import { useEffect, useState } from "react";
import { CheckCircle, Database, RefreshCw, XCircle } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";

export function QdrantRagConnection() {
  const { state, dispatch } = useStore();
  const qdrant = state.config?.qdrant;

  const [enabled, setEnabled] = useState(qdrant?.enabled ?? true);
  const [url, setUrl] = useState(qdrant?.url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [collection, setCollection] = useState(qdrant?.collection ?? "");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ready: boolean;
    pointsCount?: number;
    collection?: string;
    collections?: string[];
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (qdrant) {
      setEnabled(qdrant.enabled);
      if (qdrant.url !== undefined) setUrl(qdrant.url);
      if (qdrant.collection) setCollection(qdrant.collection);
    }
  }, [qdrant]);

  const save = async (overrides: { enabled?: boolean; url?: string; apiKey?: string; collection?: string } = {}) => {
    const patchBody: {
      qdrant: {
        enabled?: boolean;
        url?: string;
        apiKey?: string;
        collection?: string;
      };
    } = {
      qdrant: {
        enabled: overrides.enabled !== undefined ? overrides.enabled : enabled,
        url: (overrides.url !== undefined ? overrides.url : url).trim() || undefined,
        collection: (overrides.collection !== undefined ? overrides.collection : collection).trim() || undefined,
      },
    };
    if (overrides.apiKey !== undefined || apiKey.trim()) {
      patchBody.qdrant.apiKey = (overrides.apiKey !== undefined ? overrides.apiKey : apiKey).trim() || undefined;
    }

    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify(patchBody),
      });
      dispatch({ type: "configStatus", config });
    } catch {
      // ignore
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/qdrant/status");
      const data = await res.json() as {
        ready: boolean;
        pointsCount?: number;
        collection?: string;
        collections?: string[];
        error?: string;
      };
      setTestResult(data);
    } catch (err) {
      setTestResult({ ready: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

  return (
    <div className="rounded-xl border border-hairline/40 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Database size={17} className="text-accent" />
          <div>
            <div className="text-[14.5px] font-medium text-ink">Agent RAG & Shared Memory</div>
            <div className="text-[12.5px] text-ink-secondary">
              Connect your bots to a shared vector memory service for semantic retrieval, runbooks, and lessons.  Leave the URL blank to use a local <code>recall</code> CLI, or to keep this off.
            </div>
          </div>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          onClick={() => {
            const next = !enabled;
            setEnabled(next);
            void save({ enabled: next });
          }}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none",
            enabled ? "bg-accent" : "bg-hairline/60"
          )}
        >
          <span
            className={cn(
              "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out",
              enabled ? "translate-x-4" : "translate-x-0"
            )}
          />
        </button>
      </div>

      {enabled && (
        <div className="mt-4 flex flex-col gap-3 border-t border-hairline/30 pt-3">
          <div className="flex flex-col gap-1">
            <label className="text-[12px] font-medium text-ink-secondary">Service URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => void save({ url })}
              placeholder="https://recall.example.com"
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[12px] font-medium text-ink-secondary">API Key / Bearer Token (Optional)</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onBlur={() => void save({ apiKey })}
                placeholder={qdrant?.hasApiKey ? "••••••••" : "Leave blank for mesh / local auth"}
                className={inputClass}
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[12px] font-medium text-ink-secondary">Collection Name</label>
              <input
                type="text"
                value={collection}
                onChange={(e) => setCollection(e.target.value)}
                onBlur={() => void save({ collection })}
                placeholder="agent-memory"
                className={inputClass}
              />
            </div>
          </div>

          <div className="mt-1 flex items-center justify-between">
            <button
              onClick={() => void runTest()}
              disabled={testing}
              className="flex items-center gap-1.5 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[12.5px] font-medium text-ink hover:bg-control disabled:opacity-50"
            >
              <RefreshCw size={13} className={cn(testing && "animate-spin")} />
              {testing ? "Testing..." : "Test Connection"}
            </button>

            {testResult && (
              <div
                className={cn(
                  "flex items-center gap-1.5 text-[12.5px]",
                  testResult.ready ? "text-success" : "text-danger"
                )}
              >
                {testResult.ready ? (
                  <>
                    <CheckCircle size={14} />
                    <span>
                      Connected · {(testResult.pointsCount ?? 0).toLocaleString()} points in {testResult.collection || collection}
                    </span>
                  </>
                ) : (
                  <>
                    <XCircle size={14} />
                    <span className="truncate max-w-[280px]">
                      {testResult.error || "Not reachable"}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
