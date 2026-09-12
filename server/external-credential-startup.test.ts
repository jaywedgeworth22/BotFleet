import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 22800 + Math.floor(Math.random() * 10_000);
const WEBHOOK_PORT = 42800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const home = mkdtempSync(join(tmpdir(), "botfleet-external-credential-"));
const dataDir = join(home, ".botfleet");
let provider: Server;
let providerPort = 0;
let providerMode: "hold" | "answer" = "hold";
let providerRequests = 0;
const children: ChildProcess[] = [];
let output = "";

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function launchHarness(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
      OMB_DISABLE_ANTIGRAVITY_QUOTA: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  await expect.poll(async () => {
    try { return (await fetch(`${BASE}/api/health`)).status; }
    catch { return 0; }
  }, { timeout: 20_000 }).toBe(200);
  return child;
}

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null) await waitForExit(child, { signal: "SIGTERM" });
  }
  await new Promise<void>((resolve) => provider?.close(() => resolve()));
  await removeTempDir(home);
});

describe("external custom credential startup", () => {
  it("defers crash recovery and queued routines until authenticated restoration", async () => {
    provider = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"data":[{"id":"fixture-model"}]}');
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      providerRequests += 1;
      if (providerMode === "hold") return;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"restored"}}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    providerPort = (provider.address() as { port: number }).port;
    mkdirSync(dataDir, { recursive: true });
    const configPath = join(dataDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ instances: {
      custom: {
        driver: "openai-compat",
        displayName: "Encrypted Fixture",
        config: { url: `http://127.0.0.1:${providerPort}/v1`, models: ["fixture-model"] },
      },
    } }));

    const first = await launchHarness();
    const bot = (await api("POST", "/api/bots", {
      modelSelection: { instanceId: "custom", model: "fixture-model" },
    })).body.bot;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "resume this exact turn" })).status).toBe(202);
    await expect.poll(() => providerRequests).toBe(1);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots
      .find((candidate: { id: string }) => candidate.id === bot.id)?.inflightThreadId).toBe(bot.threadId);
    first.kill("SIGKILL");
    await waitForExit(first);

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.custom.config.credentialStorage = "external";
    writeFileSync(configPath, JSON.stringify(config));
    await launchHarness();

    // The old arbitrary delay has elapsed, but neither the saved turn nor an
    // interactive send may reach the provider without its encrypted key.
    await new Promise((resolve) => setTimeout(resolve, 2_800));
    const deferred = (await api("GET", "/api/bots?messages=0")).body.bots
      .find((candidate: { id: string }) => candidate.id === bot.id);
    expect(deferred).toMatchObject({ busy: false, inflightThreadId: bot.threadId });
    expect(providerRequests).toBe(1);
    const interactive = await api("POST", `/api/bots/${bot.id}/messages`, { text: "do not dispatch keyless" });
    expect(interactive).toMatchObject({ status: 409, body: { error: expect.stringMatching(/encrypted credential/) } });

    const routine = (await api("POST", "/api/routines", {
      name: "Wait for key",
      prompt: "run only after credential restore",
      botId: bot.id,
      enabled: false,
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
    })).body.routine;
    expect((await api("POST", `/api/routines/${routine.id}/run`)).status).toBe(201);
    await expect.poll(async () => (await api("GET", "/api/routines")).body.runs
      .find((run: { routineId: string }) => run.routineId === routine.id)?.status).toBe("queued");

    providerMode = "answer";
    const owner = JSON.parse(readFileSync(join(dataDir, "harness-owner.json"), "utf8"));
    const restored = await fetch(`${BASE}/api/instances/custom?secretStorage=external&restore=1`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.nonce}` },
      body: JSON.stringify({ key: "startup-secret-sentinel" }),
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ restored: true });

    await expect.poll(() => providerRequests, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    await expect.poll(async () => (await api("GET", "/api/routines")).body.runs
      .find((run: { routineId: string }) => run.routineId === routine.id)?.status, { timeout: 10_000 }).toBe("completed");
    const finished = (await api("GET", "/api/bots?messages=0")).body.bots
      .find((candidate: { id: string }) => candidate.id === bot.id);
    expect(finished.inflightThreadId).toBeUndefined();
    expect(output).not.toContain("startup-secret-sentinel");
  }, 30_000);
});
