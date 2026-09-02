// Closed-app wake: when a paired phone has no live SSE stream, the sidecar
// sends an APNs alert so iOS can relaunch the companion.  The .p8 never
// leaves this process; tests inject sendImpl.
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  p8: string;
  production: boolean;
}

export function loadApnsConfig(): ApnsConfig | null {
  const keyId = process.env.APNS_KEY_ID?.trim() || "N3949G7CN6";
  const teamId = process.env.APNS_TEAM_ID?.trim() || "CC8UTF7ATG";
  const bundleId = process.env.APNS_BUNDLE_ID?.trim() || "app.botfleet";
  const p8Path =
    process.env.APNS_P8_PATH?.trim() ||
    join(homedir(), ".secrets", `AuthKey_${keyId}.p8`);
  if (!existsSync(p8Path)) return null;
  let p8: string;
  try {
    p8 = readFileSync(p8Path, "utf8");
  } catch {
    return null;
  }
  if (!p8.includes("BEGIN PRIVATE KEY")) return null;
  return {
    keyId,
    teamId,
    bundleId,
    p8,
    production: process.env.APNS_PRODUCTION !== "0",
  };
}

export function apnsJwt(config: Pick<ApnsConfig, "keyId" | "teamId" | "p8">, now = Math.floor(Date.now() / 1000)): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: config.keyId })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: config.teamId, iat: now })).toString("base64url");
  const data = `${header}.${payload}`;
  const key = createPrivateKey(config.p8);
  const sig = cryptoSign("SHA256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });
  return `${data}.${Buffer.from(sig).toString("base64url")}`;
}

export async function sendApnsAlert(
  config: ApnsConfig,
  deviceToken: string,
  alert: { title: string; body: string; threadId?: string; botId?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const host = config.production ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  const token = deviceToken.replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]{64,}$/.test(token)) return { ok: false, status: 400 };
  const res = await fetchImpl(`https://${host}/3/device/${token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${apnsJwt(config)}`,
      "apns-topic": config.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      aps: {
        alert: { title: alert.title, body: alert.body },
        sound: "default",
        "thread-id": alert.threadId,
        "mutable-content": 1,
      },
      threadId: alert.threadId,
      botId: alert.botId,
    }),
  });
  return { ok: res.ok, status: res.status };
}

/** Watch harness SSE on loopback and APNs-wake phones that are not streaming. */
export function watchHarnessNotifications(options: {
  harnessPort: number;
  connectedIds: () => string[];
  tokensForDisconnected: () => { deviceId: string; token: string }[];
  send?: typeof sendApnsAlert;
  config?: ApnsConfig | null;
}): () => void {
  const config = options.config === undefined ? loadApnsConfig() : options.config;
  if (!config) return () => {};
  const send = options.send ?? sendApnsAlert;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pump = async () => {
    while (!stopped) {
      try {
        const res = await fetch(`http://127.0.0.1:${options.harnessPort}/api/events`, {
          headers: { accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.split("\n").find((row) => row.startsWith("data:"));
            if (!line) continue;
            let frame: { kind?: string; notification?: { title?: string; body?: string; threadId?: string; botId?: string } };
            try {
              frame = JSON.parse(line.slice(5).trim()) as typeof frame;
            } catch {
              continue;
            }
            if (frame.kind !== "notify" || !frame.notification) continue;
            const connected = new Set(options.connectedIds());
            for (const row of options.tokensForDisconnected()) {
              if (connected.has(row.deviceId)) continue;
              void send(config, row.token, {
                title: frame.notification.title ?? "BotFleet",
                body: frame.notification.body ?? "",
                threadId: frame.notification.threadId,
                botId: frame.notification.botId,
              }).catch(() => {});
            }
          }
        }
      } catch {
        /* harness down — retry */
      }
      if (stopped) return;
      await new Promise((resolve) => {
        timer = setTimeout(resolve, 4000);
      });
    }
  };
  void pump();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
