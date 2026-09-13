import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import {
  apnsJwt,
  apnsPayload,
  deliveryForKind,
  providerToken,
  resetProviderTokens,
  retryAfterMs,
  sendApnsAlert,
  tokenIsDead,
  watchHarnessNotifications,
  type ApnsConfig,
  type ApnsPayload,
} from "./apns.ts";

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

/** Never sleep for real in a test; record what the sender asked for. */
function recordingSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

const rejection = (status: number, reason: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ reason }), { status, headers });

/** A promise someone else finishes.  The resolver lives on the object
 * because a `let` only ever assigned inside a callback is narrowed to
 * `never` by the time the test tries to call it. */
function deferred() {
  const gate = {
    started: false,
    resolve: () => {},
    promise: Promise.resolve(),
  };
  gate.promise = new Promise<void>((resolve) => {
    gate.resolve = resolve;
  });
  return gate;
}

beforeEach(() => {
  resetProviderTokens();
});

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

describe("deliveryForKind", () => {
  it("breaks a Focus only for the kinds that are blocked on you", () => {
    expect(deliveryForKind("approval").interruptionLevel).toBe("time-sensitive");
    expect(deliveryForKind("question").interruptionLevel).toBe("time-sensitive");
    for (const kind of ["done", "routine-failed", "takeover", undefined, "something-new"]) {
      expect(deliveryForKind(kind).interruptionLevel).toBe("active");
    }
  });

  it("ranks approvals above every other kind", () => {
    const scores = (["approval", "question", "takeover", "routine-failed", "done"] as const).map(
      (kind) => deliveryForKind(kind).relevanceScore,
    );
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(deliveryForKind("approval").relevanceScore).toBe(1);
    expect(deliveryForKind(undefined).relevanceScore).toBeLessThan(deliveryForKind("done").relevanceScore);
  });

  it("routes blocking kinds to the approval category and the rest to updates", () => {
    expect(deliveryForKind("approval").category).toBe("BOTFLEET_APPROVAL");
    expect(deliveryForKind("question").category).toBe("BOTFLEET_APPROVAL");
    expect(deliveryForKind("done").category).toBe("BOTFLEET_UPDATE");
    expect(deliveryForKind("routine-failed").category).toBe("BOTFLEET_UPDATE");
    expect(deliveryForKind("takeover").category).toBe("BOTFLEET_UPDATE");
  });
});

describe("apnsPayload", () => {
  it("carries the same userInfo keys the in-app path uses", () => {
    const payload = apnsPayload({
      title: "Scout",
      body: "needs you",
      kind: "approval",
      threadId: "t1",
      botId: "b1",
      requestId: "req-7",
      tool: "Bash",
    });
    expect(payload.threadId).toBe("t1");
    expect(payload.botId).toBe("b1");
    expect(payload.kind).toBe("approval");
    expect(payload.requestId).toBe("req-7");
    expect(payload.tool).toBe("Bash");
  });

  it("leaves the request id absent when the harness did not send one", () => {
    // An older harness sends no identity, and the phone falls back to the
    // thread's pending card — so absent has to stay a real shape.
    const payload = apnsPayload({ title: "Scout", body: "done", kind: "done", threadId: "t1" });
    expect(payload.requestId).toBeUndefined();
    expect(payload.tool).toBeUndefined();
  });

  it("stamps an approval as time-sensitive, top-ranked, and actionable", () => {
    const { aps } = apnsPayload({ title: "Scout", body: "needs you", kind: "approval", threadId: "t1" });
    expect(aps.category).toBe("BOTFLEET_APPROVAL");
    expect(aps["interruption-level"]).toBe("time-sensitive");
    expect(aps["relevance-score"]).toBe(1);
    expect(aps["thread-id"]).toBe("t1");
    expect(aps["content-available"]).toBe(1);
    expect(aps.alert).toEqual({ title: "Scout", body: "needs you" });
  });

  it("keeps a report quiet and in the update category", () => {
    const { aps } = apnsPayload({ title: "Scout", body: "done", kind: "done" });
    expect(aps.category).toBe("BOTFLEET_UPDATE");
    expect(aps["interruption-level"]).toBe("active");
    expect(aps["relevance-score"]).toBe(0.4);
  });
});

describe("providerToken", () => {
  it("reuses one token for twenty minutes and signs a new one after", () => {
    const config = testConfig();
    const first = providerToken(config, 1_000_000);
    expect(providerToken(config, 1_000_000 + 19 * 60_000)).toBe(first);
    expect(providerToken(config, 1_000_000 + 21 * 60_000)).not.toBe(first);
  });

  it("keeps a rotated key apart from the one it replaced", () => {
    const first = providerToken(testConfig(), 1_000_000);
    const second = providerToken(testConfig(), 1_000_000);
    expect(second).not.toBe(first);
  });
});

describe("sendApnsAlert", () => {
  it("posts an alert with content-available so a suspended app can reconnect", async () => {
    const config = testConfig();
    const token = "ab".repeat(32);
    let url = "";
    let headers: Headers | undefined;
    let body: Partial<ApnsPayload> = {};
    const result = await sendApnsAlert(
      config,
      token,
      { title: "Scout finished", body: "done", kind: "done", threadId: "t1", botId: "b1" },
      {
        fetchImpl: async (input, init) => {
          url = String(input);
          headers = new Headers(init?.headers);
          // SAFETY: the body is the JSON this very call just serialised, so
          // the assertion restates what was written rather than trusting
          // anything that came off a network.
          body = JSON.parse(String(init?.body ?? "{}")) as ApnsPayload;
          return new Response("{}", { status: 200 });
        },
      },
    );
    expect(result).toEqual({ ok: true, status: 200, attempts: 1 });
    expect(url).toBe(`https://api.push.apple.com/3/device/${token}`);
    expect(headers?.get("apns-push-type")).toBe("alert");
    expect(headers?.get("apns-topic")).toBe("app.botfleet");
    expect(body.aps?.alert).toEqual({ title: "Scout finished", body: "done" });
    expect(body.aps?.["content-available"]).toBe(1);
    expect(body.aps?.category).toBe("BOTFLEET_UPDATE");
    expect(body.threadId).toBe("t1");
    expect(body.botId).toBe("b1");
    expect(body.kind).toBe("done");
  });

  it("uses the sandbox host when production is off", async () => {
    let url = "";
    await sendApnsAlert(
      testConfig({ production: false }),
      "cd".repeat(32),
      { title: "Hi", body: "there" },
      {
        fetchImpl: async (input) => {
          url = String(input);
          return new Response("{}", { status: 200 });
        },
      },
    );
    expect(url.startsWith("https://api.sandbox.push.apple.com/3/device/")).toBe(true);
  });

  it("reuses the cached provider token across sends inside the window", async () => {
    const config = testConfig();
    const authorizations: string[] = [];
    const fetchImpl = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("{}", { status: 200 });
    };
    let clock = 5_000_000;
    await sendApnsAlert(config, "ab".repeat(32), { title: "a", body: "b" }, { fetchImpl, now: () => clock });
    clock += 10 * 60_000;
    await sendApnsAlert(config, "ab".repeat(32), { title: "a", body: "b" }, { fetchImpl, now: () => clock });
    expect(authorizations).toHaveLength(2);
    expect(authorizations[0]).toBe(authorizations[1]);
  });

  it("re-signs immediately when Apple says the provider token expired", async () => {
    const config = testConfig();
    const authorizations: string[] = [];
    const { waits, sleep } = recordingSleep();
    let call = 0;
    const result = await sendApnsAlert(
      config,
      "ab".repeat(32),
      { title: "a", body: "b" },
      {
        sleep,
        now: () => 6_000_000,
        fetchImpl: async (_input, init) => {
          authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
          call += 1;
          return call === 1 ? rejection(403, "ExpiredProviderToken") : new Response("{}", { status: 200 });
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(authorizations[0]).not.toBe(authorizations[1]);
    // A stale token is not congestion — the retry goes straight back out.
    expect(waits).toEqual([]);
  });

  it("does not re-sign for InvalidProviderToken — the key itself is refused", async () => {
    // Expiry is worth a fresh signature.  An invalid token means Apple
    // refuses the KEY — wrong team, revoked, a .p8 that does not match its
    // key id — and every new signature earns the identical rejection.
    const config = testConfig();
    const { waits, sleep } = recordingSleep();
    let calls = 0;
    const result = await sendApnsAlert(
      config,
      "ab".repeat(32),
      { title: "a", body: "b" },
      {
        sleep,
        fetchImpl: async () => {
          calls += 1;
          return rejection(403, "InvalidProviderToken");
        },
      },
    );
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
    expect(result).toEqual({ ok: false, status: 403, reason: "InvalidProviderToken", attempts: 1 });
  });

  it("retries a 429 after the Retry-After Apple asked for", async () => {
    const { waits, sleep } = recordingSleep();
    let call = 0;
    const result = await sendApnsAlert(
      testConfig(),
      "ab".repeat(32),
      { title: "a", body: "b" },
      {
        sleep,
        fetchImpl: async () => {
          call += 1;
          return call === 1
            ? rejection(429, "TooManyRequests", { "retry-after": "7" })
            : new Response("{}", { status: 200 });
        },
      },
    );
    expect(result).toEqual({ ok: true, status: 200, attempts: 2 });
    expect(waits).toEqual([7000]);
  });

  it("backs off exponentially on a 503 and gives up after the attempt budget", async () => {
    const { waits, sleep } = recordingSleep();
    let calls = 0;
    const result = await sendApnsAlert(
      testConfig(),
      "ab".repeat(32),
      { title: "a", body: "b" },
      {
        sleep,
        fetchImpl: async () => {
          calls += 1;
          return rejection(503, "ServiceUnavailable");
        },
      },
    );
    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 2000]);
    expect(result).toEqual({ ok: false, status: 503, reason: "ServiceUnavailable", attempts: 3 });
  });

  it("does not retry a 400 — the same request fails the same way", async () => {
    const { waits, sleep } = recordingSleep();
    let calls = 0;
    const result = await sendApnsAlert(
      testConfig(),
      "ab".repeat(32),
      { title: "a", body: "b" },
      {
        sleep,
        fetchImpl: async () => {
          calls += 1;
          return rejection(400, "BadDeviceToken");
        },
      },
    );
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
    expect(result).toEqual({ ok: false, status: 400, reason: "BadDeviceToken", attempts: 1 });
  });

  it("returns a 410 with its reason so the caller can drop the token", async () => {
    let calls = 0;
    const result = await sendApnsAlert(
      testConfig(),
      "ab".repeat(32),
      { title: "a", body: "b" },
      {
        fetchImpl: async () => {
          calls += 1;
          return rejection(410, "Unregistered");
        },
      },
    );
    expect(calls).toBe(1);
    expect(result).toEqual({ ok: false, status: 410, reason: "Unregistered", attempts: 1 });
  });
});

describe("tokenIsDead", () => {
  it("treats the permanent 400 reasons exactly like a 410", () => {
    expect(tokenIsDead(410, "Unregistered")).toBe(true);
    expect(tokenIsDead(400, "BadDeviceToken")).toBe(true);
    expect(tokenIsDead(400, "DeviceTokenNotForTopic")).toBe(true);
    // A 400 about the payload says nothing about the token.
    expect(tokenIsDead(400, "PayloadTooLarge")).toBe(false);
    expect(tokenIsDead(400, undefined)).toBe(false);
    expect(tokenIsDead(429, "TooManyRequests")).toBe(false);
    expect(tokenIsDead(503, "ServiceUnavailable")).toBe(false);
  });
});

describe("retryAfterMs", () => {
  it("reads seconds, caps them, and ignores anything else", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs("99999")).toBe(30_000);
    expect(retryAfterMs("-1")).toBeNull();
    expect(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });
});

describe("watchHarnessNotifications", () => {
  const notifyFrameWithBody = (kind: string, body: string) =>
    `data: ${JSON.stringify({
      kind: "notify",
      notification: { kind, title: "Scout finished", body, threadId: "t1", botId: "b1" },
    })}\n\n`;

  const notifyFrame = (kind: string, identity: { requestId?: string; tool?: string } = {}) =>
    `data: ${JSON.stringify({
      kind: "notify",
      notification: { kind, title: "Scout finished", body: "done", threadId: "t1", botId: "b1", ...identity },
    })}\n\n`;

  it("APNs-wakes disconnected phones on notify frames and drops 410 tokens", async () => {
    const sent: { token: string; title: string; kind?: string }[] = [];
    const forgotten: string[] = [];
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => ["online"],
      tokensForDisconnected: () => [
        { deviceId: "online", token: "aa".repeat(32) },
        { deviceId: "offline", token: "bb".repeat(32) },
        { deviceId: "stale", token: "cc".repeat(32) },
      ],
      config: testConfig(),
      fetchImpl: async () =>
        new Response(notifyFrame("approval"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async (_config, token, alert) => {
        sent.push({ token, title: alert.title, kind: alert.kind });
        return token === "cc".repeat(32)
          ? { ok: false, status: 410, reason: "Unregistered", attempts: 1 }
          : { ok: true, status: 200, attempts: 1 };
      },
      forgetToken: (id) => forgotten.push(id),
    });
    const started = Date.now();
    while (sent.length < 2 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    expect(sent.map((row) => row.token).sort()).toEqual(["bb".repeat(32), "cc".repeat(32)].sort());
    expect(sent.every((row) => row.title === "Scout finished")).toBe(true);
    // The kind is what decides how the push lands; it has to survive the hop.
    expect(sent.every((row) => row.kind === "approval")).toBe(true);
    expect(forgotten).toEqual(["stale"]);
  });

  it("forwards the request identity from the harness frame to the alert", async () => {
    const sent: { requestId?: string; tool?: string; kind?: string }[] = [];
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "offline", token: "bb".repeat(32) }],
      config: testConfig(),
      fetchImpl: async () =>
        new Response(notifyFrame("approval", { requestId: "req-7", tool: "Bash" }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async (_config, _token, alert) => {
        sent.push({ requestId: alert.requestId, tool: alert.tool, kind: alert.kind });
        return { ok: true, status: 200, attempts: 1 };
      },
    });
    const started = Date.now();
    while (sent.length === 0 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    expect(sent[0]).toEqual({ requestId: "req-7", tool: "Bash", kind: "approval" });
  });

  it("reports health: configured, tokens, the last send and the last error", async () => {
    const tokens = [
      { deviceId: "offline", token: "bb".repeat(32) },
      { deviceId: "broken", token: "cc".repeat(32) },
    ];
    let sends = 0;
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => tokens,
      config: testConfig(),
      now: () => 1_700_000_000_000,
      fetchImpl: async () =>
        new Response(notifyFrame("done"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async (_config, token) => {
        sends += 1;
        return token === "cc".repeat(32)
          ? { ok: false, status: 403, reason: "BadCollapseId", attempts: 1 }
          : { ok: true, status: 200, attempts: 1 };
      },
    });
    expect(watch.health().configured).toBe(true);
    expect(watch.health().production).toBe(true);
    expect(watch.health().tokensRegistered).toBe(2);
    const started = Date.now();
    while (sends < 2 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    const health = watch.health();
    expect(health.sent).toBeGreaterThanOrEqual(1);
    expect(health.failed).toBeGreaterThanOrEqual(1);
    expect(health.lastSentAt).toBe(1_700_000_000_000);
    expect(health.lastError).toBe("403 BadCollapseId");
  });

  it("reports itself unconfigured when the key is missing, without sending", async () => {
    let streams = 0;
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "offline", token: "bb".repeat(32) }],
      loadConfig: () => null,
      keyRecheckMs: 50,
      fetchImpl: async () => {
        streams += 1;
        return new Response(notifyFrame("done"), { status: 200 });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    watch.stop();
    expect(watch.health().configured).toBe(false);
    expect(watch.health().tokensRegistered).toBe(1);
    expect(streams).toBe(0);
  });

  it("starts working once a key that was missing at startup appears", async () => {
    let available: ApnsConfig | null = null;
    const sent: string[] = [];
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "offline", token: "bb".repeat(32) }],
      loadConfig: () => available,
      keyRecheckMs: 10,
      fetchImpl: async () =>
        new Response(notifyFrame("approval"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async (_config, token) => {
        sent.push(token);
        return { ok: true, status: 200, attempts: 1 };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(watch.health().configured).toBe(false);
    available = testConfig();
    const started = Date.now();
    while (sent.length === 0 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    expect(sent).toEqual(["bb".repeat(32)]);
    expect(watch.health().configured).toBe(true);
  });

  it("keeps one rate-limited phone from delaying any other", async () => {
    // Serial delivery meant a phone Apple was throttling could hold every
    // other phone behind its Retry-After — up to a minute of silence for
    // people whose own token was fine.
    const slow = deferred();
    const finished: string[] = [];
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [
        { deviceId: "slow", token: "aa".repeat(32) },
        { deviceId: "quick", token: "bb".repeat(32) },
      ],
      config: testConfig(),
      fetchImpl: async () =>
        new Response(notifyFrame("approval"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async (_config, token) => {
        if (token === "aa".repeat(32)) {
          slow.started = true;
          await slow.promise;
        }
        finished.push(token);
        return { ok: true, status: 200, attempts: 1 };
      },
    });
    const started = Date.now();
    while (finished.length === 0 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The quick phone is done while the slow one is still in flight.
    expect(finished).toEqual(["bb".repeat(32)]);
    expect(slow.started).toBe(true);
    slow.resolve();
    while (finished.length < 2 && Date.now() - started < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    expect(finished.sort()).toEqual(["aa".repeat(32), "bb".repeat(32)].sort());
  });

  it("bounds a stuck phone's backlog and drops its oldest notifications", async () => {
    const gate = deferred();
    const delivered: string[] = [];
    const frames = ["one", "two", "three", "four", "five"]
      .map((body) => notifyFrameWithBody("approval", body))
      .join("");
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "stuck", token: "aa".repeat(32) }],
      config: testConfig(),
      maxQueuedPerDevice: 2,
      fetchImpl: async () =>
        new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } }),
      send: async (_config, _token, alert) => {
        if (delivered.length === 0) {
          gate.started = true;
          await gate.promise;
        }
        delivered.push(alert.body);
        return { ok: true, status: 200, attempts: 1 };
      },
    });
    const started = Date.now();
    while (!gate.started && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Give the reader time to hand every frame to the queue behind the
    // first, still-unfinished send.
    await new Promise((resolve) => setTimeout(resolve, 30));
    gate.resolve();
    while (delivered.length < 3 && Date.now() - started < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    // The first went out; of the four that queued behind it only the two
    // newest survive, because the newest alerts are the ones worth keeping.
    expect(delivered).toEqual(["one", "four", "five"]);
    expect(watch.health().dropped).toBe(2);
  });

  it("drops a token Apple rejects with a permanent 400, not just a 410", async () => {
    const forgotten: string[] = [];
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "dead", token: "aa".repeat(32) }],
      config: testConfig(),
      fetchImpl: async () =>
        new Response(notifyFrame("approval"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async () => ({ ok: false, status: 400, reason: "BadDeviceToken", attempts: 1 }),
      forgetToken: (id) => forgotten.push(id),
    });
    const started = Date.now();
    while (forgotten.length === 0 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    expect(forgotten).toEqual(["dead"]);
  });

  it("stops sending when Apple refuses the key, and says so on the health", async () => {
    let sends = 0;
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [{ deviceId: "offline", token: "aa".repeat(32) }],
      loadConfig: () => testConfig(),
      keyStamp: () => "same-key",
      keyRecheckMs: 10,
      fetchImpl: async () =>
        new Response(notifyFrame("approval"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      send: async () => {
        sends += 1;
        return { ok: false, status: 403, reason: "InvalidProviderToken", attempts: 1 };
      },
    });
    const started = Date.now();
    while (sends === 0 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Long enough for several re-check intervals: a key Apple refuses must
    // not be retried just because the timer came round again.
    await new Promise((resolve) => setTimeout(resolve, 120));
    watch.stop();
    expect(sends).toBe(1);
    const health = watch.health();
    expect(health.keyRejected).toBe("InvalidProviderToken");
    expect(health.configured).toBe(false);
  });

  it("picks up a rotated key file and forgets the one it replaced", async () => {
    let stamp = "key-v1";
    let loads = 0;
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [],
      loadConfig: () => {
        loads += 1;
        return testConfig();
      },
      keyStamp: () => stamp,
      keyRecheckMs: 10,
      fetchImpl: async () => new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    const started = Date.now();
    while (loads === 0 && Date.now() - started < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Several re-checks against an unchanged file must not re-read it.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(loads).toBe(1);

    stamp = "key-v2";
    while (loads < 2 && Date.now() - started < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watch.stop();
    expect(loads).toBe(2);
  });

  it("resumes the harness stream where it left off", async () => {
    // Without a cursor every notification raised during a harness restart,
    // or during our own retry, is simply never pushed.
    const cursors: (string | null)[] = [];
    let connections = 0;
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [],
      config: testConfig(),
      fetchImpl: async (_input, init) => {
        connections += 1;
        cursors.push(new Headers(init?.headers).get("last-event-id"));
        return new Response(`id: stream-1:${connections}\ndata: ${JSON.stringify({ kind: "hello" })}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const started = Date.now();
    while (connections < 2 && Date.now() - started < 12_000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    watch.stop();
    expect(cursors[0]).toBeNull();
    expect(cursors[1]).toBe("stream-1:1");
  }, 15_000);

  it("stays off, and stays quiet, when the sender is pinned off", () => {
    const watch = watchHarnessNotifications({
      harnessPort: 1,
      connectedIds: () => [],
      tokensForDisconnected: () => [],
      config: null,
      fetchImpl: async () => {
        throw new Error("must not stream");
      },
    });
    expect(watch.health().configured).toBe(false);
    expect(watch.health().production).toBeNull();
    watch.stop();
  });
});
