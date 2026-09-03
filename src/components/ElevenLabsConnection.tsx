import { Check, ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";

export function ElevenLabsConnection() {
  const { state, dispatch } = useStore();
  const tts = state.config?.tts;
  const configured = Boolean(tts?.configured);

  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const nextKey = key.trim();
    if (!nextKey && !configured) return;
    setSaving(true);
    setError(null);
    try {
      const request = window.ogb?.setCredential
        ? window.ogb.setCredential("ttsKey", nextKey)
        : api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { key: nextKey } }) });
      const status: ConfigStatus = await request;
      dispatch({ type: "configStatus", config: status });
      setKey("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
        <span>ElevenLabs Voice Synthesis</span>
        {configured && <span className="text-[11px] text-success">Connected</span>}
      </div>
      <p className="mb-2 text-[12px] leading-relaxed text-ink-secondary">
        Shared workspace voice engine for real-time bot calls and spoken replies. The API key is stored securely in your operating system keychain.
      </p>
      <div className="flex gap-2">
        <input
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && key.trim() && void save()}
          placeholder={configured ? "••••••••  (paste to replace)" : "Paste your ElevenLabs API key"}
          aria-label="ElevenLabs API Key"
          autoComplete="off"
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          onClick={() => void save()}
          disabled={saving || !key.trim()}
          className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />Save</>}
        </button>
      </div>
      {error && <div role="alert" className="mt-1 text-[12px] text-danger">{error}</div>}
      {!configured && (
        <a
          href="https://elevenlabs.io/app/settings/api-keys"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline"
        >
          <span>Get an API Key from ElevenLabs</span>
          <ExternalLink size={11} />
        </a>
      )}
    </div>
  );
}
