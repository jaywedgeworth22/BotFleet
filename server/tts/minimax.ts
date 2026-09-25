// MiniMax TTS — the only network voice engine.
//
// One request per utterance, the renderer already prefetches the next clip
// while the current one plays, which gets the same perceived latency as a
// streaming socket without the moving parts. The renderer only ever sees
// opaque mp3 bytes — the API key never leaves this process.
//
// TTS endpoint:       POST https://api.minimax.io/v1/t2a_v2   (sync, ≤10K chars)
// Voice list:         GET  https://api.minimax.io/v1/voice/list
// Cloned voice list:  GET  /api/tts/cloned-voices  (local file, no API call)
// Voice clone:        POST https://api.minimax.io/v1/voice_clone
// File upload:        POST https://api.minimax.io/v1/files/upload
//
// Native contract (not OpenAI-compatible shape):
//   body: { model, text, stream:false, output_format:"hex",
//           voice_setting:{voice_id, speed, vol, pitch},
//           audio_setting:{sample_rate, bitrate, format, channel},
//           language_boost }
//   response: { data:{audio:"<hex>"}, base_resp:{status_code, status_msg} }
// An error response surfaces base_resp.status_msg verbatim.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Audio, VerifyResult, Voice } from "./types.ts";

// ── Re-export shared types ────────────────────────────────────────────────────
export type { Audio, VerifyResult, Voice };

const API = process.env.MINIMAX_API_URL || "https://api.minimax.io";
const MODEL = process.env.MINIMAX_SPEECH_MODEL || "speech-2.8-turbo";
const MAX_CHARS = 10_000;

const DATA_DIR = process.env.OMB_DATA_DIR ?? join(homedir(), ".botfleet");
const CLONED_VOICES_FILE = join(DATA_DIR, "tts-cloned-voices.json");

// ── Canned catalog ─────────────────────────────────────────────────────────────
// Curated MiniMax voices available without any account or API call.  Each
// entry is a real voice_id from the MiniMax platform that has been verified
// to produce acceptable output.  The list is static so the picker is instant;
// the full upstream catalog is still fetched from /v1/voice/list when a key
// is configured.
export const CANNED_VOICES: Voice[] = [
  { id: "English_Graceful_Lady",   label: "Graceful Lady",   description: "English · female · warm, measured" },
  { id: "English_Persuasive_Man",  label: "Persuasive Man",  description: "English · male · clear, confident" },
  { id: "English_Cheerful_Girl",   label: "Cheerful Girl",   description: "English · female · upbeat, friendly" },
  { id: "English_Casual_Male",     label: "Casual Male",     description: "English · male · relaxed, conversational" },
  { id: "Chinese_Yunyang_News",    label: "Yunyang News",    description: "Chinese · news anchor style" },
  { id: "Chinese_Sichuan_Peng",
    label: "Sichuan Peng",
    description: "Chinese · female · lively regional tone",
  },
  { id: "Japanese_Anytime_Casual", label: "Anytime Casual",  description: "Japanese · female · casual, friendly" },
  { id: "Korean_Yeonwoo_Classic",  label: "Yeonwoo Classic", description: "Korean · male · classic tone" },
  { id: "Spanish_Daniel_Emotional",label: "Daniel Emotional", description: "Spanish · male · expressive" },
  { id: "French_Female_Yunxi",    label: "Yunxi (FR)",      description: "French · female · clear accent" },
];

// ── Cloned voice persistence ──────────────────────────────────────────────────

interface ClonedVoiceRecord {
  voiceId: string;
  label: string;
  createdAt: number; // Unix ms
}

function readClonedVoices(): ClonedVoiceRecord[] {
  try {
    if (!existsSync(CLONED_VOICES_FILE)) return [];
    const raw = readFileSync(CLONED_VOICES_FILE, "utf8");
    return JSON.parse(raw) as ClonedVoiceRecord[];
  } catch {
    return [];
  }
}

/** Persist cloned voice records atomically (write → rename) so a concurrent
 * read never sees a partial file.  The file is chmod 600. */
function writeClonedVoices(records: ClonedVoiceRecord[]): void {
  const tmp = `${CLONED_VOICES_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
  renameSync(tmp, CLONED_VOICES_FILE);
}

/** List cloned voices as Voice objects, newest first. */
export function listClonedVoices(): Voice[] {
  return readClonedVoices()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => ({ id: r.voiceId, label: r.label }));
}

// ── Voice cloning ─────────────────────────────────────────────────────────────

interface CloneApiResponse {
  voice_id?: string;
  voice_name?: string;
  base_resp?: { status_code: number; status_msg?: string };
}

interface UploadApiResponse {
  file_id?: string;
  base_resp?: { status_code: number; status_msg?: string };
}

/** Clone a voice from a ShortAudio clip (≤30s, MP3/WAV/FLAC, ≤5 MB).
 * The `name` parameter labels the voice in the picker.  Returns the
 * voice_id MiniMax assigns.  Throws on any API or I/O error.
 *
 * MiniMax clone flow:
 *   1. POST /v1/files/upload  → file_id
 *   2. POST /v1/voice_clone  → voice_id
 *   3. Persist { voiceId, label, createdAt } to tts-cloned-voices.json */
export async function cloneVoice(
  audioBuffer: Buffer,
  filename: string,
  name: string,
  key: string,
): Promise<Voice> {
  // Validate the voice id before we persist anything.
  const trimmed = name.trim();
  if (!trimmed || trimmed.length < 2) throw new Error("Voice name must be at least 2 characters.");
  if (trimmed.length > 64) throw new Error("Voice name must be 64 characters or fewer.");

  // Step 1 — upload the audio clip.
  const form = new FormData();
  const file = new File([new Uint8Array(audioBuffer)], filename, {
    type: filename.endsWith(".wav") ? "audio/wav" : filename.endsWith(".flac") ? "audio/flac" : "audio/mpeg",
  });
  form.append("file", file);
  form.append("purpose", "voice_clone");

  let uploadRes: UploadApiResponse | null = null;
  try {
    const res = await fetch(`${API}/v1/files/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    uploadRes = (await safeJson(res)) as UploadApiResponse | null;
    if (!res.ok || uploadRes?.base_resp?.status_code !== 0) {
      throw new Error(upstreamMessage(res.status, "uploading audio clip", uploadRes));
    }
  } catch (e) {
    if (e instanceof Error && !e.message.includes("reached")) {
      throw e;
    }
    throw new Error("Couldn't reach MiniMax to upload the audio clip — check your connection.");
  }

  const fileId = uploadRes?.file_id;
  if (!fileId) throw new Error("MiniMax returned no file_id after upload.");

  // Step 2 — trigger the clone.
  let cloneRes: CloneApiResponse | null = null;
  try {
    const res = await fetch(`${API}/v1/voice_clone`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        file_id: fileId,
        voice_id: "",
        model: MODEL,
        text: "This is a voice cloning demonstration.",
        need_noise_reduction: false,
        need_volumn_normalization: true,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    cloneRes = (await safeJson(res)) as CloneApiResponse | null;
    if (!res.ok || cloneRes?.base_resp?.status_code !== 0) {
      throw new Error(upstreamMessage(res.status, "cloning voice", cloneRes));
    }
  } catch (e) {
    if (e instanceof Error && !e.message.includes("reached")) {
      throw e;
    }
    throw new Error("Couldn't reach MiniMax to clone the voice — check your connection.");
  }

  const voiceId = cloneRes?.voice_id;
  if (!voiceId) throw new Error("MiniMax returned no voice_id after clone.");

  // Step 3 — persist locally.
  const records = readClonedVoices();
  records.push({ voiceId, label: trimmed, createdAt: Date.now() });
  writeClonedVoices(records);

  return { id: voiceId, label: trimmed };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface BaseResponse {
  status_code: number;
  status_msg?: string;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Pull the human-readable error out of a MiniMax response. */
function upstreamMessage(status: number, what: string, body: unknown): string {
  const theirs =
    (typeof (body as any)?.base_resp?.status_msg === "string"
      ? (body as any).base_resp.status_msg.trim()
      : "") ||
    (typeof (body as any)?.message === "string" ? (body as any).message.trim() : "") ||
    "";
  if (status === 401 || status === 403) {
    return theirs
      ? `MiniMax rejected that key: ${theirs}`
      : "MiniMax rejected that key. Get a fresh one from platform.minimax.io/user/basic-information/interface-key.";
  }
  if (status === 429) return theirs || "MiniMax is rate-limiting this account — wait a moment and try again.";
  if (status === 402) return theirs || "MiniMax says this account is out of credit.";
  return theirs ? `${what} failed: ${theirs}` : `${what} failed (${status})`;
}

// ── verifyKey ────────────────────────────────────────────────────────────────

/** Check a key before we store it: a rejected credential must fail at the
 * paste, not hours later in another panel with nothing to act on.
 *
 * We probe /v1/voice/list — it returns the system catalog so a successful
 * response doubles as the voice list. */
export async function verifyKey(key: string): Promise<VerifyResult> {
  try {
    const res = await fetch(`${API}/v1/voice/list`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await safeJson(res)) as VoiceListResponse | null;
    if (res.ok && body?.base_resp?.status_code === 0) return { ok: true };
    return { ok: false, message: upstreamMessage(res.status, "checking that key", body) };
  } catch {
    return { ok: false, message: "Couldn't reach MiniMax to check that key — check your connection." };
  }
}

interface VoiceListItem {
  voice_id?: string;
  voice_name?: string;
  description?: string;
  language?: string | string[];
  gender?: string;
}

interface VoiceListResponse {
  voice_list?: VoiceListItem[];
  base_resp?: BaseResponse;
}

/** List MiniMax system voices. The picker shows the curated canned catalog
 * plus any cloned voices persisted locally; this function fetches the live
 * upstream catalog when a key is configured. */
export async function listVoices(key: string): Promise<Voice[]> {
  const res = await fetch(`${API}/v1/voice/list`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await safeJson(res)) as VoiceListResponse | null;
  if (!res.ok || body?.base_resp?.status_code !== 0) {
    throw new Error(upstreamMessage(res.status, "listing voices", body));
  }
  return (body?.voice_list ?? [])
    .map((v): Voice => {
      const id = String(v.voice_id ?? "");
      const lang = Array.isArray(v.language) ? v.language.join("/") : v.language;
      return {
        id,
        label: String(v.voice_name ?? v.voice_id ?? "Voice"),
        description: [lang, v.gender].filter(Boolean).join(" · ") || undefined,
      };
    })
    .filter((v) => v.id);
}

export interface SynthesizeOptions {
  voiceId: string;
  /** Voice id can be a system voice_id OR a cloned voice_id. */
  speed?: number;
  vol?: number;
  pitch?: number;
  format?: "mp3" | "pcm" | "flac";
  sampleRate?: number;
  bitrate?: number;
  languageBoost?: string;
}

interface T2AResponse {
  data?: { audio?: string; status?: number };
  extra_info?: { audio_format?: string; audio_length?: number };
  base_resp?: BaseResponse;
}

/** Synthesize one utterance to mp3 bytes. Throws if MiniMax returns a
 * non-zero status_code or the audio payload is empty. */
export async function synthesize(
  text: string,
  voiceId: string,
  key: string,
  options: SynthesizeOptions = { voiceId: "" },
): Promise<Audio> {
  const trimmed = text.trim();
  if (!trimmed) return { bytes: new Uint8Array(), mime: "audio/mpeg" };
  if (trimmed.length > MAX_CHARS) {
    throw new Error(`utterance is ${trimmed.length} chars; MiniMax accepts at most ${MAX_CHARS} per request`);
  }
  const body = {
    model: MODEL,
    text: trimmed,
    stream: false,
    output_format: "hex",
    voice_setting: {
      voice_id: voiceId,
      speed: options.speed ?? 1.0,
      vol: options.vol ?? 1.0,
      pitch: options.pitch ?? 0,
    },
    audio_setting: {
      sample_rate: options.sampleRate ?? 24_000,
      bitrate: options.bitrate ?? 128_000,
      format: options.format ?? "mp3",
      channel: 1,
    },
    language_boost: options.languageBoost ?? "auto",
  };
  const res = await fetch(`${API}/v1/t2a_v2`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  }).catch(() => {
    throw new Error("Couldn't reach MiniMax to speak — check your connection.");
  });
  const parsed = (await safeJson(res)) as T2AResponse | null;
  if (!res.ok || parsed?.base_resp?.status_code !== 0 || !parsed.data?.audio) {
    throw new Error(upstreamMessage(res.status, "speaking", parsed));
  }
  // output_format "hex" — decode each pair of hex chars into a byte.
  const hex = parsed.data.audio;
  if (hex.length % 2 !== 0) {
    throw new Error("MiniMax returned odd-length hex audio");
  }
  const bytes = Buffer.from(hex, "hex");
  const format = parsed.extra_info?.audio_format ?? body.audio_setting.format;
  const mime = format === "wav" ? "audio/wav" : format === "pcm" ? "audio/pcm" : "audio/mpeg";
  return { bytes, mime };
}
