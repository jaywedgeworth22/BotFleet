// MiniMax text-to-speech, the default MiniMax voice.
//
// Like the ElevenLabs driver, this file owns everything about talking to the
// service: verifying a key, listing voices, and turning one utterance into
// mp3 bytes.  It runs on the HARNESS, never the renderer, because the key
// must not leave the server.  GET /api/config reports configured-or-not
// booleans and nothing else, and that invariant is worth more than a saved
// round trip.
//
// MiniMax exposes an OpenAI-compatible audio/speech endpoint
// (POST /v1/audio/speech).  That keeps the integration narrow: same
// request shape, same Bearer auth, same mp3 response.  When MiniMax adds a
// native endpoint with extra knobs (timbre, emotion), this file is the
// only place that has to learn it.

const API = process.env.OMB_MINIMAX_TTS_API || "https://api.minimax.io/v1";
// MiniMax's current TTS line is speech-2.8 — turbo is the cheap default,
// hd is the premium option.  A config-driven override lets the operator
// pick per-bot without a redeploy.
const MODEL = process.env.OMB_MINIMAX_TTS_MODEL || "speech-2.8-turbo";
const FORMAT = "mp3";
const DEFAULT_VOICE = "alloy";

export interface Voice {
  id: string;
  label: string;
  description?: string;
}

export interface Audio {
  bytes: Uint8Array;
  mime: string;
}

export type VerifyResult = { ok: true } | { ok: false; message: string };

/** Curated set of voices MiniMax advertises on its text-to-speech surface.
 *  Kept in code rather than discovered at runtime: the endpoint has no
 *  public list-voices route, and the names below are stable.  A user can
 *  type a custom voice id in the picker; verifyKey + synthesize do not
 *  constrain it to this list. */
const CURATED_VOICES: Voice[] = [
  { id: "alloy", label: "Alloy", description: "Warm, conversational default" },
  { id: "echo", label: "Echo", description: "Bright, energetic" },
  { id: "fable", label: "Fable", description: "Storyteller, mid-range" },
  { id: "onyx", label: "Onyx", description: "Deep, measured" },
  { id: "nova", label: "Nova", description: "Upbeat, clear" },
  { id: "shimmer", label: "Shimmer", description: "Soft, bright" },
];

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Prefer the upstream's own words for any failure message.  Auth failures
 *  on MiniMax come back with a body shaped like { error: { message,
 *  type, param?, code? } }; everything else falls back to a generic
 *  "MiniMax <thing> failed" so the settings panel still names what broke. */
function message(status: number, what: string, body: any): string {
  const theirs =
    (body?.error?.message && String(body.error.message).trim()) ||
    (typeof body?.message === "string" && body.message.trim()) ||
    "";
  if (status === 401 || status === 403) {
    return theirs
      ? `MiniMax rejected that key: ${theirs}`
      : "MiniMax rejected that key. Check that it has the text-to-speech permission.";
  }
  if (status === 429) {
    return theirs || "MiniMax is rate-limiting this account — wait a moment and try again.";
  }
  if (status === 402) {
    return theirs || "MiniMax says this account is out of credit.";
  }
  if (status === 404) {
    return theirs || `MiniMax ${what} endpoint was not found — confirm the model "${MODEL}" is available on your account.`;
  }
  return theirs ? `MiniMax ${what} failed: ${theirs}` : `MiniMax ${what} failed (${status})`;
}

/** Check a key before we store it: a rejected credential must fail at the
 *  paste, not hours later in another panel with nothing to act on.
 *
 *  Verified against /models.  /models is the cheapest endpoint that needs
 *  a real auth header and reports a precise 401/403 on a bad key.  The
 *  audio/speech endpoint also accepts the key but takes longer to time
 *  out and produces a bigger bill per probe. */
export async function verifyKey(key: string): Promise<VerifyResult> {
  try {
    const res = await fetch(`${API}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, message: message(res.status, "checking that key", await safeJson(res)) };
  } catch {
    return { ok: false, message: "Couldn't reach MiniMax to check that key — check your connection." };
  }
}

/** Return the curated voice catalog.  A user with a custom voice id
 *  configured in cfg.tts.voice still gets playback; the picker does not
 *  filter that out. */
export async function listVoices(_key: string): Promise<Voice[]> {
  return CURATED_VOICES.slice();
}

/** Synthesize one utterance.  Throws a flat Error on upstream failure so
 *  the route layer can surface a clean 502 with the upstream's words.
 *  The default model is fixed; a future "premium voice" picker can extend
 *  this without breaking the existing call sites. */
export async function synthesize(text: string, voiceId: string, key: string): Promise<Audio> {
  const trimmed = voiceId?.trim();
  const voice = trimmed || DEFAULT_VOICE;
  const body = JSON.stringify({
    model: MODEL,
    input: text,
    voice,
    response_format: FORMAT,
  });
  let res: Response;
  try {
    res = await fetch(`${API}/audio/speech`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw Object.assign(new Error(`Couldn't reach MiniMax to speak "${voice}"`), { status: 502 });
  }
  if (!res.ok) throw new Error(message(res.status, "speaking", await safeJson(res)));
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime: "audio/mpeg" };
}

export const _internals = {
  API,
  MODEL,
  FORMAT,
  DEFAULT_VOICE,
  CURATED_VOICES,
};
