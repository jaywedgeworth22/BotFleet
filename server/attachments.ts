// Chat attachments: pasted/dropped files become paths under
// ~/.botfleet/attachments so every CLI engine can open them —
// the app never ships file bytes through the prompt itself.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { DATA_DIR } from "./config.ts";

export const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");

/** Screenshots and photos stay at 10 MB.  Other chat files may be larger. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FILE_MAX_BYTES = 25 * 1024 * 1024;

/** Mimes the endpoint accepts, mapped to the extension stored on disk.
 * Sniffing is not attempted — a lie here only changes the filename.
 * HTML/SVG/JS are refused so the serve route cannot become an XSS host. */
const ATTACHMENT_MIMES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/avif": ".avif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "video/mp4": ".mp4",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/octet-stream": ".bin",
};

export function extensionForMime(mime: string | undefined): string | null {
  if (!mime) return null;
  return ATTACHMENT_MIMES[mime.split(";")[0]!.trim().toLowerCase()] ?? null;
}

export function isImageMime(mime: string | undefined): boolean {
  const ext = extensionForMime(mime);
  return ext === ".png" || ext === ".jpg" || ext === ".gif" || ext === ".webp" || ext === ".heic" || ext === ".heif" || ext === ".avif";
}

export function ensureAttachmentsDir(): void {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 });
}

export interface SavedAttachment {
  path: string;
  mime: string;
  bytes: number;
}

/** Persist one image and return its path. The UUID filename means the name
 * is never attacker-controlled and never collides; the extension preserves
 * the format the sender claimed. */
export function saveImage(bytes: Buffer, mime: string): SavedAttachment {
  return saveAttachment(bytes, mime);
}

/** Persist a chat file (image or otherwise) under a generated name. */
export function saveAttachment(bytes: Buffer, mime: string): SavedAttachment {
  const ext = extensionForMime(mime);
  if (!ext) throw Object.assign(new Error("unsupported file type"), { status: 400 });
  if (bytes.byteLength === 0) throw Object.assign(new Error("empty file"), { status: 400 });
  const ceiling = isImageMime(mime) ? IMAGE_MAX_BYTES : FILE_MAX_BYTES;
  if (bytes.byteLength > ceiling) {
    throw Object.assign(new Error(`file exceeds ${ceiling} bytes`), { status: 413 });
  }
  ensureAttachmentsDir();
  const name = `${randomUUID()}${ext}`;
  const path = join(ATTACHMENTS_DIR, name);
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  return { path, mime: mime.split(";")[0]!.trim().toLowerCase(), bytes: bytes.byteLength };
}

/** Existence check with the same name discipline as readAttachment, without
 * reading up to 10MB of pixels just to learn the file is there. */
const SAFE_NAME = /^[A-Za-z0-9-]+\.[A-Za-z0-9]{1,8}$/;

export function attachmentExists(name: string): boolean {
  if (!SAFE_NAME.test(name)) return false;
  try {
    return statSync(join(ATTACHMENTS_DIR, name)).isFile();
  } catch {
    return false;
  }
}

/** Read an attachment back for serving. Only names that are exactly a bare
 * filename (no separators, no dotfiles) inside ATTACHMENTS_DIR resolve —
 * the route must never become a general file server for the data dir. */
export function readAttachment(name: string): { bytes: Buffer; mime: string } | null {
  if (!SAFE_NAME.test(name)) return null;
  const path = join(ATTACHMENTS_DIR, name);
  if (extname(path) === ".jpeg") return null; // saved as .jpg; .jpeg is not a name we write
  try {
    return { bytes: readFileSync(path), mime: mimeForExt(extname(path)) };
  } catch {
    return null;
  }
}

function mimeForExt(ext: string): string {
  for (const [mime, mapped] of Object.entries(ATTACHMENT_MIMES)) {
    if (mapped === ext) return mime;
  }
  return "application/octet-stream";
}
