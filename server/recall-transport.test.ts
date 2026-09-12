import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { executeRecallCli, fetchRecall, probeRecallService, recallStatus, validateRecallStats } from "./recall-transport.ts";

const servers: Server[] = [];
const valid = { collection: "selected-corpus", points: 0, status: "green", embedder_healthy: true };
async function service(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

describe("Recall readiness evidence", () => {
  it.each([401, 403, 404, 500])("rejects a public healthy route with protected stats HTTP %i", async (status) => {
    const url = await service((req, res) => json(res, req.url === "/health" ? { backend_ok: true } : {}, req.url === "/health" ? 200 : status));
    await expect(probeRecallService(url, {}, "selected-corpus", AbortSignal.timeout(1000))).rejects.toThrow(`HTTP ${status}`);
  });
  it.each([
    { ...valid, backend_ok: false }, { ...valid, embedder_healthy: false }, { ...valid, points: -1 },
    { ...valid, collection: "other-corpus" }, { ...valid, status: "red" }, { ok: true },
    { collections: [{ name: "selected-corpus" }] },
  ])("does not infer readiness from incomplete or unhealthy statistics: %j", (stats) => {
    expect(validateRecallStats(stats, "selected-corpus").stats).toBeUndefined();
  });
  it("accepts a healthy empty corpus after protected-route proof", async () => {
    const paths: string[] = [];
    const url = await service((req, res) => { paths.push(req.url!); json(res, req.url === "/health" ? { backend_ok: true } : valid); });
    expect(await probeRecallService(url, {}, "selected-corpus", AbortSignal.timeout(1000))).toEqual(valid);
    expect(paths).toEqual(["/health", "/recall/stats"]);
  });
  it("bounds a stalled protected response with the same whole-probe deadline", async () => {
    const url = await service((req, res) => { if (req.url === "/health") json(res, { backend_ok: true }); });
    const started = Date.now();
    await expect(probeRecallService(url, {}, "selected-corpus", AbortSignal.timeout(100))).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1500);
  });
  it("coalesces matching probes and preserves last success while reporting a later failure", async () => {
    let unhealthy = false;
    let statsCalls = 0;
    const url = await service((req, res) => {
      if (req.url === "/recall/stats") statsCalls++;
      json(res, req.url === "/health" ? { backend_ok: !unhealthy } : valid);
    });
    const settings = { url, collection: "selected-corpus", apiKey: "", accessClientId: "", accessClientSecret: "" };
    const first = recallStatus(settings);
    expect(recallStatus(settings)).toBe(first);
    const success = await first;
    expect(success).toMatchObject({ ready: true, state: "ready", pointsCount: 0, source: "recall-service" });
    expect(statsCalls).toBe(1);
    unhealthy = true;
    expect(await recallStatus(settings)).toMatchObject({ ready: false, state: "degraded", lastSuccessAt: success.lastSuccessAt });
  });
});

describe("Recall transport credential and process boundaries", () => {
  it("never forwards bearer or Access credentials to a different origin", async () => {
    let reached = false;
    const destination = await service((_req, res) => { reached = true; json(res, valid); });
    const url = await service((_req, res) => { res.writeHead(307, { location: destination }); res.end(); });
    const response = await fetchRecall(url, { headers: { Authorization: "Bearer fixture", "CF-Access-Client-Secret": "fixture" }, signal: AbortSignal.timeout(1000) });
    expect(response.status).toBe(307);
    expect(reached).toBe(false);
    await response.body?.cancel();
  });
  it("preserves a POST body across a same-origin 307", async () => {
    const seen: string[] = [];
    const url = await service((req, res) => {
      if (req.url === "/start") { res.writeHead(307, { location: "/finish" }); res.end(); return; }
      req.on("data", (chunk) => seen.push(chunk.toString()));
      req.on("end", () => json(res, valid));
    });
    const response = await fetchRecall(`${url}/start`, { method: "POST", body: "fixture", signal: AbortSignal.timeout(1000) });
    expect(await response.json()).toEqual(valid);
    expect(seen.join("")).toBe("fixture");
  });
  it("passes the selected collection to a local CLI", async () => {
    expect(await executeRecallCli(process.execPath, ["-e", "process.stdout.write(process.env.QDRANT_FLEET_COLLECTION)"], "selected-corpus", 2000)).toBe("selected-corpus");
  });
  it("bounds a hung local CLI and its output pipes", async () => {
    const started = Date.now();
    await expect(executeRecallCli(process.execPath, ["-e", "setInterval(() => {}, 1000)"], "", 100)).rejects.toMatchObject({ killed: true });
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
