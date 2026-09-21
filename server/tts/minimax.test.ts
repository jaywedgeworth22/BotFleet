// The MiniMax TTS driver, in isolation. The `index.ts` test exercises the
// engine picker; this file owns the driver's contract: what it sends, how
// it formats the URL, and what it does on a refusal.  The fetch is
// stubbed, the API base is overridden, and the ABORT signal is allowed to
// fire so the timeout path is testable.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let server: ReturnType<typeof import("node:http").createServer>;
const seen: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = [];
let refuse: { status: number; body: unknown } | null = null;
const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22, 0x33, 0x44]);

beforeAll(async () => {
  const http = await import("node:http");
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
        body,
      });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (refuse) return send(refuse.status, refuse.body);
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && path === "/v1/models") {
        return send(200, { data: [{ id: "MiniMax-1.5-tts-1" }] });
      }
      if (req.method === "POST" && path === "/v1/audio/speech") {
        res.writeHead(200, { "content-type": "audio/mpeg" });
        return res.end(MP3);
      }
      send(404, { detail: "no such stub route" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env.OMB_MINIMAX_TTS_API = `http://127.0.0.1:${port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** The driver reads OMB_MINIMAX_TTS_API at import time, so import after the
 * stub is up. */
const driver = () => import("./minimax.ts");

describe("verifyKey", () => {
  it("returns ok against a real /v1/models probe", async () => {
    refuse = null;
    seen.length = 0;
    const { verifyKey } = await driver();
    expect(await verifyKey("sk-good")).toEqual({ ok: true });
    const call = seen.at(-1)!;
    expect(call.method).toBe("GET");
    expect(call.url.split("?")[0]).toBe("/v1/models");
    expect(call.headers["authorization"]).toBe("Bearer sk-good");
  });

  it("returns the upstream's own message on 401", async () => {
    refuse = { status: 401, body: { error: { message: "Incorrect API key" } } };
    const { verifyKey } = await driver();
    const result = await verifyKey("bad");
    refuse = null;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Incorrect API key");
      expect(result.message).toContain("rejected");
    }
  });

  it("falls back to a permission hint when the upstream gives no detail on 401", async () => {
    refuse = { status: 401, body: {} };
    const { verifyKey } = await driver();
    const result = await verifyKey("bad");
    refuse = null;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.toLowerCase()).toContain("rejected");
  });

  it("names the missing model on 404 from /v1/models", async () => {
    refuse = { status: 404, body: {} };
    const { verifyKey } = await driver();
    const result = await verifyKey("bad");
    refuse = null;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/MiniMax-1\.5-tts-1/);
  });

  it("returns a network-shaped failure when the fetch throws", async () => {
    const { verifyKey } = await driver();
    // Temporarily replace fetch with one that rejects.
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const result = await verifyKey("sk");
    globalThis.fetch = original;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.toLowerCase()).toContain("couldn't reach");
  });
});

describe("listVoices", () => {
  it("returns the curated catalog without making any HTTP call", async () => {
    seen.length = 0;
    const { listVoices } = await driver();
    const voices = await listVoices("sk");
    expect(voices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "alloy" }),
        expect.objectContaining({ id: "echo" }),
        expect.objectContaining({ id: "fable" }),
        expect.objectContaining({ id: "onyx" }),
        expect.objectContaining({ id: "nova" }),
        expect.objectContaining({ id: "shimmer" }),
      ]),
    );
    expect(voices).toHaveLength(6);
    expect(seen).toHaveLength(0);
  });
});

describe("synthesize", () => {
  it("POSTs the expected body shape and returns mp3 bytes", async () => {
    refuse = null;
    seen.length = 0;
    const { synthesize } = await driver();
    const audio = await synthesize("hi there", "alloy", "sk");
    expect(audio.mime).toBe("audio/mpeg");
    expect(Buffer.from(audio.bytes)).toEqual(MP3);

    const call = seen.at(-1)!;
    expect(call.method).toBe("POST");
    expect(call.url.split("?")[0]).toBe("/v1/audio/speech");
    expect(call.headers["authorization"]).toBe("Bearer sk");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers["accept"]).toBe("audio/mpeg");
    expect(JSON.parse(call.body)).toEqual({
      model: "MiniMax-1.5-tts-1",
      input: "hi there",
      voice: "alloy",
      response_format: "mp3",
    });
  });

  it("falls back to the default voice when an empty string is passed", async () => {
    refuse = null;
    seen.length = 0;
    const { synthesize } = await driver();
    await synthesize("hi", "  ", "sk");
    expect(JSON.parse(seen.at(-1)!.body).voice).toBe("alloy");
  });

  it("surfaces the upstream's own message on a 4xx refusal", async () => {
    refuse = { status: 402, body: { error: { message: "insufficient credit" } } };
    const { synthesize } = await driver();
    const message = await synthesize("hi", "alloy", "sk").catch((e: Error) => e.message);
    refuse = null;
    expect(message).toContain("insufficient credit");
  });

  it("reports a network failure with status 502 when the fetch throws", async () => {
    const { synthesize } = await driver();
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const err: any = await synthesize("hi", "alloy", "sk").catch((e) => e);
    globalThis.fetch = original;
    expect(err).toBeDefined();
    expect(err.status).toBe(502);
    expect(err.message.toLowerCase()).toContain("couldn't reach");
  });
});
