// Shared TTS types used across minimax.ts and system-voices.ts.
// Do NOT add ElevenLabs types here — that driver is deleted.
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
