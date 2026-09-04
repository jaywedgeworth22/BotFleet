import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { apnsJwt, sendApnsAlert, watchHarnessNotifications, type ApnsConfig } from "./apns.ts";

function testP8(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function testConfig(overrides: Partial<ApnsConfig> = {}): ApnsConfig {
  return {
    keyId: "ABC123",
    teamId: "TEAMID1",
    bundleId: "app.botfleet",
    p8: testP8(),
    production: true,
    ...overrides,
  };
}

describe("apnsJwt", () => {
  it("builds a three-part ES256 token from a p8", () => {
    const jwt = apnsJwt({ keyId: "ABC123", teamId: "TEAMID1", p8: testP8() }, 1_700_000_000);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    expect(header).toEqual({ alg: "ES256", kid: "ABC123" });
    expect(payload.iss).toBe("TEAMID1");
    expect(payload.iat).toBe(1_700_000_000);
  });
});

describe("sendApnsAlert", () => {
  it("posts an alert with content-available so a suspended app can reconnect", async () => {
    const config = testConfig();
    const token = "ab".repeat(32);
    let url = "";
    let headers: Headers | undefined;
    let body: {
      aps?: { alert?: { title?: string; body?: string }; "content-available"?: number };
      threadId?: string;
      botId?: string;
    } = {};
    const result = await sendApnsAlert(
      config,
      token,
      { title: "Scout finished", body: "done", threadId: "t1", botId: "b1" },
      async (input, init) => {
        url = String(input);
        headers = new Headers(init?.headers);
        body = JSON.parse(String(init?.body ?? "{}")) as typeof body;
        return new Response("{}", { status: 200 });
      },
    );
    expect(result).toEqual({ ok: true, status: 200 });
    expect(url).toBe(`https://api.push.apple.com/3/device/${token}`);
    expect(headers?.get("apns-push-type")).toBe("alert");
    expect(headers?.get("apns-topic")).toBe("app.botfleet");
    expect(body.aps?.alert).toEqual({ title: "Scout finished", body: "done" });
    expect(body.aps?.["content-available"]).toBe(1);
    expect(body.threadId).toBe("t1");
    expect(body.botId).toBe("b1");
  });

  it("uses the sandbox host when production is off", async () => {
    let url = "";
    await sendApnsAlert(
      testConfig({ production: false }),
      "cd".repeat(32),
      { title: "Hi", body: "there" },
      async (input) => {
        url = String(input);
        return new Response("{}", { status: 200 });
      },
    );
    expect(url.startsWith("https://api.sandbox.push.apple.com/3/device/")).toBe(true);
  });
});

describe("watchHarnessNotifications", () => {
  it("APNs-wakes disconnected phones on notify frames and drops 410 tokens", async () => {
    const sent: { token: string; title: string }[] = [];
    const forgotten: string[] = [];
    const frame = `data: ${JSON.stringify({
      kind: "notify",
      notification: { title: "Scout finished", body: "done", threadId: "t1", botId: "b1" },
    })}\n\n`;
    const stop = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => ["online"],
      tokensForDisconnected: () => [
        { deviceId: "online", token: "aa".repeat(32) },
        { deviceId: "offline", token: "bb".repeat(32) },
        { deviceId: "stale", token: "cc".repeat(32) },
      ],
      config: testConfig(),
      fetchImpl: async () =>
        new Response(frame, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async (_config, token, alert) => {
        sent.push({ token, title: alert.title });
        return token === "cc".repeat(32) ? { ok: false, status: 410 } : { ok: true, status: 200 };
      },
      forgetToken: (id) => forgotten.push(id),
    });
    const started = Date.now();
    while (sent.length < 2 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stop();
    expect(sent.map((row) => row.token).sort()).toEqual(["bb".repeat(32), "cc".repeat(32)].sort());
    expect(sent.every((row) => row.title === "Scout finished")).toBe(true);
    expect(forgotten).toEqual(["stale"]);
  });
});
