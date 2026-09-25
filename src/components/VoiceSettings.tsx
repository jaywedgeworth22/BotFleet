// Per-bot voice profile. The key is shared; the voice and autoplay choice
// belong to the selected bot.
//
// The voice list comes from the harness, which holds the key — the
// renderer never talks to MiniMax itself.
import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Mic, Plus, Volume2, X } from "lucide-react";

import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { speaker } from "@/lib/tts";
import { cn } from "@/lib/cn";

const SAMPLE = "Morning. Overnight the tests went green, and I left two notes for you in the thread.";

export function VoiceSettings({
  bot,
  onPatch,
}: {
  bot: Bot;
  onPatch: (patch: Partial<Pick<Bot, "voice" | "speakReplies">>) => void;
}) {
  const { state, dispatch } = useStore();
  const tts = state.config?.tts;

  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<Array<{ id: string; label: string; description?: string }>>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);

  // ── voice clone state ───────────────────────────────────────────────
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneLabel, setCloneLabel] = useState("");
  const [cloneCloning, setCloneCloning] = useState(false);
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [cloneSuccess, setCloneSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { capabilities } = useDesktopCapabilities();
  const systemVoicesAvailable = capabilities.host.platform === "darwin";
  const provider = tts?.provider ?? "minimax";
  const configured = Boolean(tts?.configured);

  useEffect(() => {
    if (!configured) {
      setVoices([]);
      return;
    }
    let alive = true;
    setLoadingVoices(true);
    api("/api/tts/voices")
      .then((r: { voices?: typeof voices; error?: string }) => {
        if (!alive) return;
        setVoices(r.voices ?? []);
        if (r.error) setError(r.error);
      })
      .catch(() => alive && setVoices([]))
      .finally(() => alive && setLoadingVoices(false));
    return () => {
      alive = false;
    };
  }, [configured, provider]);

  const setProvider = (next: "minimax" | "system") => {
    if (next === provider || switching || (next === "system" && !systemVoicesAvailable)) return;
    setSwitching(true);
    setError(null);
    api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { provider: next } }) })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e: Error) => setError(e.message))
      .finally(() => setSwitching(false));
  };

  const saveKey = () => {
    const nextKey = key.trim();
    if (!nextKey) return Promise.resolve();
    setSaving(true);
    setError(null);
    const request = window.ogb?.setCredential
      ? window.ogb.setCredential("ttsKey", nextKey)
      : api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { key: nextKey } }) });
    return request
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setKey("");
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const handleCloneFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setCloneFile(file);
    setCloneError(null);
    setCloneSuccess(null);
  };

  const handleClone = async () => {
    const label = cloneLabel.trim();
    if (!label || label.length < 2) {
      setCloneError("Name must be at least 2 characters.");
      return;
    }
    if (label.length > 64) {
      setCloneError("Name must be 64 characters or fewer.");
      return;
    }
    if (!cloneFile) {
      setCloneError("Select an audio file first.");
      return;
    }
    setCloneCloning(true);
    setCloneError(null);
    setCloneSuccess(null);
    try {
      const arrayBuffer = await cloneFile.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer)
          .reduce((data, byte) => data + String.fromCharCode(byte), ""),
      );
      const result = await api("/api/tts/voice-clone", {
        method: "POST",
        body: JSON.stringify({ voiceId: label, audioFile: base64 }),
      }) as { voiceId?: string; error?: string };
      if (result.error) {
        setCloneError(result.error);
      } else {
        setCloneSuccess(`Voice "${label}" cloned and ready. Pick it from the list below.`);
        setCloneLabel("");
        setCloneFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        // Refresh voice list.
        const voicesResult = await api("/api/tts/voices") as { voices?: typeof voices; error?: string };
        if (voicesResult.voices) setVoices(voicesResult.voices);
      }
    } catch (e) {
      setCloneError(e instanceof Error ? e.message : "Clone failed.");
    } finally {
      setCloneCloning(false);
    }
  };

  if (!tts) return null;

  const selectedVoice = bot.voice ?? "";
  const ready = configured && Boolean(selectedVoice || tts.voice);

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Voice</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        Give this bot a voice for calls and spoken replies. The voice choice belongs to this bot;
        {provider === "system"
          ? systemVoicesAvailable
            ? " the voices are the ones already installed on this Mac."
            : " built-in Mac voices are unavailable here. Switch to MiniMax to keep using voice."
          : " the MiniMax key is shared by the workspace."}
      </div>

      <div className="mt-4">
        <div className="mb-2 text-[13px] text-ink-secondary">Voice Engine</div>
        <div className="inline-flex rounded-xl bg-inset p-1" role="radiogroup" aria-label="Voice Engine">
          {([
            { value: "minimax" as const, label: "MiniMax", available: true },
            { value: "system" as const, label: "Built-in Mac voices", available: systemVoicesAvailable },
          ]).map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={provider === option.value}
              disabled={switching || !option.available}
              title={!option.available ? "Built-in voices are available only on macOS" : undefined}
              onClick={() => setProvider(option.value)}
              className={cn(
                "rounded-lg px-3.5 py-1.5 text-[12.5px] transition-colors disabled:opacity-50",
                provider === option.value ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {provider === "minimax" && (
        <>
          <div className="mt-4">
            <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
              <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
              <span>MiniMax Key</span>
              {configured && <span className="text-[11px] text-success">Connected</span>}
            </div>
            <div className="flex gap-2">
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && key.trim() && void saveKey()}
                placeholder={configured ? "••••••••  (paste to replace)" : "Paste your MiniMax API key"}
                aria-label="MiniMax Key"
                autoComplete="off"
                className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
              />
              <button
                onClick={() => void saveKey()}
                disabled={saving || !key.trim()}
                className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />Save</>}
              </button>
            </div>
          </div>

          {configured && (
            <>
              {/* ── Voice clone panel ── */}
              <div className="mt-4 border-t border-hairline/40 pt-4">
                <div className="mb-1.5 flex items-center justify-between text-[13px] text-ink-secondary">
                  <span>Clone a Voice</span>
                  <button
                    type="button"
                    onClick={() => setCloneOpen((o) => !o)}
                    className="flex items-center gap-1 text-accent hover:underline"
                  >
                    {cloneOpen ? <X size={12} /> : <Plus size={12} />}
                    {cloneOpen ? "Close" : "Add from audio"}
                  </button>
                </div>

                {cloneOpen && (
                  <div className="mt-2 rounded-lg border border-hairline/40 bg-inset p-3">
                    <p className="mb-2 text-[12px] text-ink-secondary">
                      Upload a short audio clip (≤30 seconds, MP3/WAV/FLAC) to create a voice
                      clone. The clone appears in the voice list below.
                    </p>
                    <div className="mb-2 flex gap-2">
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="audio/mpeg,audio/wav,audio/flac,.mp3,.wav,.flac"
                        onChange={handleCloneFile}
                        aria-label="Audio file for voice clone"
                        className="w-full rounded-lg border border-hairline/40 bg-card px-3 py-2 text-[13px] text-ink file:mr-2 file:rounded file:border-0 file:bg-control file:px-2 file:py-1 file:text-[12px] file:text-ink file:shadow-none"
                      />
                    </div>
                    <div className="mb-2">
                      <input
                        type="text"
                        value={cloneLabel}
                        onChange={(e) => setCloneLabel(e.target.value)}
                        maxLength={64}
                        placeholder='Name this voice (e.g. "My Voice")'
                        aria-label="Clone name"
                        className="w-full rounded-lg border border-hairline/40 bg-card px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
                      />
                    </div>
                    {cloneError && (
                      <div role="alert" className="mb-2 text-[12px] text-danger">{cloneError}</div>
                    )}
                    {cloneSuccess && (
                      <div role="status" className="mb-2 text-[12px] text-success">{cloneSuccess}</div>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleClone()}
                      disabled={cloneCloning || !cloneFile || !cloneLabel.trim()}
                      className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {cloneCloning ? <Loader2 size={13} className="animate-spin" /> : <Mic size={13} />}
                      {cloneCloning ? "Cloning…" : "Clone Voice"}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

      {configured && (
        <div className="mt-4">
          <div className="mb-1.5 text-[13px] text-ink-secondary">Voice</div>
          <div className="flex gap-2">
            <select
              value={selectedVoice}
              onChange={(e) => onPatch({ voice: e.target.value })}
              aria-label={`${bot.name}'s voice`}
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-hairline focus:outline-none"
            >
              <option value="">
                {loadingVoices
                  ? "Loading voices…"
                  : tts.voice
                    ? "Workspace default"
                    : "Pick a voice"}
              </option>
              {selectedVoice && !voices.some((voice) => voice.id === selectedVoice) && (
                <option value={selectedVoice}>Current bot voice</option>
              )}
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                  {v.description ? ` — ${v.description}` : ""}
                </option>
              ))}
            </select>
            <button
              onClick={() => void speaker.speak(SAMPLE, { voiceId: bot.voice, botId: bot.id })}
              disabled={!ready}
              title={ready ? "Hear this voice" : "Pick a voice first"}
              aria-label="Hear this voice"
              className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Volume2 size={14} /> Try
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/40 pt-4">
        <div>
          <div className="text-[13px] font-medium text-ink">Read replies aloud</div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
            Speak this bot's answers as they arrive, even from another chat.
          </div>
        </div>
        <button
          role="switch"
          aria-checked={Boolean(bot.speakReplies)}
          aria-label="Read this bot's replies aloud"
          onClick={() => onPatch({ speakReplies: !bot.speakReplies })}
          className={cn(
            "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
            bot.speakReplies ? "bg-accent" : "bg-control",
          )}
        >
          <span
            className={cn(
              "absolute top-[3px] size-5 rounded-full bg-white transition-all",
              bot.speakReplies ? "left-[21px]" : "left-[3px]",
            )}
          />
        </button>
      </div>

      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
