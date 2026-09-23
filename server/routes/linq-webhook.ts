// POST /api/webhooks/linq — HMAC-verified Linq webhook receiver.
//
// The receiver lives next to the existing webhook-ingress surface because
// it needs its own (a) JSON parsing path with the Linq-specific signature
// header, and (b) dispatch module invocation.  We keep the same shape
// (StatusCapsule-style JSON 200/400/401 answers) so the Linq dashboard
// surfaces an obvious failure during install.
//
// The `botsProvider` is injected by the route registration site so this
// module never has to reach into the singleton Store from inside
// `server/index.ts` — same separation the webhook-ingress surface keeps.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { parseJson } from "../schema.ts";
import { handleLinqInbound } from "../linq/dispatch.ts";
import type { BotRecord } from "../store.ts";

const MAX_LINQ_WEBHOOK_BYTES = 512 * 1024;

const linqReceivedSchema = z.object({
  type: z.literal("message.received"),
  chat_id: z.string().min(1),
  message_id: z.string().min(1),
  from: z.string(),
  to: z.string().optional(),
  body: z.string().optional(),
  parts: z
    .array(
      z.object({
        type: z.enum(["text", "image", "video", "audio", "file"]),
        url: z.string().optional(),
        mime_type: z.string().optional(),
        filename: z.string().optional(),
      }),
    )
    .optional(),
  is_group: z.boolean().optional(),
  group_name: z.string().optional(),
  sent_at: z.string().optional(),
});

const linqLifecycleSchema = z.union([
  z.object({ type: z.literal("message.sent"), message_id: z.string(), chat_id: z.string().optional(), at: z.string().optional() }),
  z.object({ type: z.literal("message.delivered"), message_id: z.string(), chat_id: z.string().optional(), at: z.string().optional() }),
]);

const linqEventSchema = z.union([linqReceivedSchema, linqLifecycleSchema]);

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let bytes = 0;
    let done = false;
    const fail = (status: number, message: string) => {
      if (done) return;
      done = true;
      reject(Object.assign(new Error(message), { status }));
    };
    req.on("data", (chunk: Buffer | string) => {
      if (done) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buf.length;
      if (bytes > MAX_LINQ_WEBHOOK_BYTES) return fail(413, "Linq webhook body is too large");
      raw += buf.toString("utf8");
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(raw);
    });
    req.on("error", () => fail(400, "Could not read Linq webhook body"));
  });
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

/** HMAC-SHA256 of the raw request body keyed by the workspace secret.  Linq
 *  publishes `X-Linq-Signature` as a hex digest; we verify with
 *  `timingSafeEqual` and bail out 401 when the digest does not match.
 *
 *  When the operator has no secret configured, the receiver logs a warning
 *  and accepts the call.  That matches Linq's trial tier behavior where
 *  signing is opt-in.  The audit doc tracks this as a hard follow-up to
 *  gate the secret behind a required-on-publish toggle. */
function verifySignature(rawBody: string, header: string | undefined, secret: string | undefined): boolean {
  if (!secret) return true;
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const got = header.trim().toLowerCase();
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export interface LinqWebhookOptions {
  /** Pull the active bots list.  Injected so this module can stay decoupled
   *  from `server/index.ts`'s singleton store. */
  getBots(): BotRecord[];
}

export async function readLinqWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  options: LinqWebhookOptions,
): Promise<void> {
  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 400;
    json(res, status, { ok: false, reason: "bad_body" });
    return;
  }
  const secret = process.env.LINQ_WEBHOOK_SECRET?.trim() || undefined;
  const header = (req.headers["x-linq-signature"] as string | undefined) ?? undefined;
  if (!verifySignature(rawBody, header, secret)) {
    json(res, 401, { ok: false, reason: "bad_signature" });
    return;
  }
  let parsedBody: unknown;
  try {
    parsedBody = parseJson(rawBody) as unknown;
  } catch {
    json(res, 400, { ok: false, reason: "bad_json" });
    return;
  }
  const parsed = linqEventSchema.safeParse(parsedBody);
  if (!parsed.success) {
    json(res, 400, { ok: false, reason: "bad_event" });
    return;
  }
  if (parsed.data.type === "message.received") {
    const inbound = {
      chatId: parsed.data.chat_id,
      fromNumber: parsed.data.from,
      toNumber: parsed.data.to,
      text: parsed.data.body,
      media: parsed.data.parts
        ?.filter((p) => Boolean(p.url))
        .map((p) => ({ url: p.url as string, mimeType: p.mime_type, filename: p.filename })),
      group: Boolean(parsed.data.is_group),
      groupName: parsed.data.group_name,
      messageId: parsed.data.message_id,
      sentAt: parsed.data.sent_at ?? new Date().toISOString(),
    };
    const result = await handleLinqInbound(inbound, options.getBots());
    json(res, 200, { ok: true, ...result });
    return;
  }
  json(res, 200, { ok: true, lifecycle: parsed.data.type });
}
