// Contract test for the Agent RAG proxy's configuration boundary.
//
// BotFleet ships no recall endpoint and no collection name. With nothing
// configured and no local `recall` CLI on the host, every tool must say so
// and touch the network zero times — the failure this guards against is a
// built-in default quietly sending a user's prompts to somebody else's
// server.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { SPAWNED_PROXIES } from "../proxy-paths.ts";

/** Every env var the proxy reads for its endpoint, key, collection, and CLI
 * path — cleared so a developer's own shell cannot configure the child. */
const PROXY_ENV_KEYS = [
  "OMB_RECALL_URL",
  "RECALL_URL",
  "OMB_QDRANT_URL",
  "QDRANT_URL",
  "OMB_RECALL_API_KEY",
  "RECALL_API_KEY",
  "OMB_QDRANT_API_KEY",
  "QDRANT_API_KEY",
  "OMB_RECALL_COLLECTION",
  "RECALL_COLLECTION",
  "OMB_QDRANT_COLLECTION",
  "QDRANT_COLLECTION",
  "RECALL_CLI_PATH",
  "OMB_RECALL_ACCESS_CLIENT_ID",
  "OMB_QDRANT_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_ID",
  "OMB_RECALL_ACCESS_CLIENT_SECRET",
  "OMB_QDRANT_ACCESS_CLIENT_SECRET",
  "CF_ACCESS_CLIENT_SECRET",
] as const;

const NOT_CONFIGURED = "Agent RAG is not configured — set a Service URL in Settings";

/** The tool arguments these tests send — a named contract, not a bag. */
interface ToolArgs {
  query?: string;
  topic?: string;
  text?: string;
  category?: string;
}
type RpcParams = { name: string; arguments: ToolArgs } | Record<string, never>;

let child: ChildProcess | null = null;
let stub: Server | null = null;

function cleanEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  // setup.ts already points HOME at a throwaway directory, so homedir()
  // in the child holds no ~/.local/bin/recall.
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  for (const key of PROXY_ENV_KEYS) delete env[key];
  return { ...env, ...overrides };
}

/** Launch the proxy and return a JSON-RPC caller over its stdio. */
function launch(overrides: Record<string, string> = {}) {
  const proc = spawn(process.execPath, [SPAWNED_PROXIES.qdrant], {
    stdio: ["pipe", "pipe", "pipe"],
    env: cleanEnv(overrides),
  });
  child = proc;

  const pending = new Map<number, (message: { result?: { content?: Array<{ text?: string }> } }) => void>();
  let nextId = 1;
  let buffer = "";
  proc.stdout!.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  const rpc = (method: string, params: RpcParams) =>
    new Promise<{ result?: { content?: Array<{ text?: string }>; tools?: unknown[] } }>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 10_000).unref?.();
    });

  const callTool = async (name: string, args: ToolArgs = {}) => {
    const response = await rpc("tools/call", { name, arguments: args });
    return response.result?.content?.[0]?.text ?? "";
  };

  return { callTool, rpc };
}

afterEach(async () => {
  child?.kill("SIGKILL");
  child = null;
  if (stub) {
    const server = stub;
    stub = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("Agent RAG proxy with nothing configured", () => {
  it("reports the not-configured message from recall_search and never calls out", async () => {
    const { callTool } = launch();
    const text = await callTool("recall_search", { query: "how do we deploy" });

    expect(text).toBe(NOT_CONFIGURED);
    // A missing guard would surface as a request failure against an empty or
    // built-in URL, not as this message.
    expect(text).not.toMatch(/failed|http|fetch|recall\/search/i);
  });

  it("reports the not-configured message from recall_contribute", async () => {
    const { callTool } = launch();
    const text = await callTool("recall_contribute", {
      text: "A lesson long enough to be a real contribution to the shared corpus.",
      category: "lesson",
    });

    expect(text).toBe(NOT_CONFIGURED);
  });

  it("reports the not-configured message from recall_stats and the qdrant aliases", async () => {
    const { callTool } = launch();

    expect(await callTool("recall_stats")).toBe(NOT_CONFIGURED);
    expect(await callTool("qdrant_list_collections")).toBe(NOT_CONFIGURED);
    expect(await callTool("qdrant_search", { query: "anything" })).toBe(NOT_CONFIGURED);
    expect(await callTool("qdrant_get_context", { topic: "anything" })).toBe(NOT_CONFIGURED);
  });

  it("advertises no owner-specific host, collection, or path in its tool schema", async () => {
    const { rpc } = launch();
    const response = await rpc("tools/list", {});
    const schema = JSON.stringify(response.result?.tools ?? []);

    expect(schema).not.toMatch(/jays\.services|fleet-agents|mac-collab|fleet-rag/);
    // the tools themselves must still be advertised
    expect(schema).toContain("recall_search");
  });
});

describe("Agent RAG proxy with a configured service", () => {
  it("calls the configured endpoint and only that endpoint", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ hits: [{ text: "a stored lesson", score: 0.9 }], mode: "hybrid" }));
      });
    });
    stub = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: listen() has resolved on a TCP socket, so address() is an
    // AddressInfo with a bound port, never null or a pipe name.
    const port = (server.address() as { port: number }).port;

    const { callTool } = launch({
      OMB_QDRANT_URL: `http://127.0.0.1:${port}`,
      OMB_QDRANT_COLLECTION: "agent-memory",
    });
    const text = await callTool("recall_search", { query: "how do we deploy" });

    expect(seen).toEqual(["POST /recall/search"]);
    expect(text).toContain("a stored lesson");
    expect(text).toContain("agent-memory");
  });
});

describe("Agent RAG proxy behind Cloudflare Access", () => {
  /** Start a stub that records the credential headers of every request. */
  /** Node models a header as string | string[]; every one read here is
   * single-valued, so the first value is the value. */
  const headerValue = (raw: string | string[] | undefined): string | undefined =>
    Array.isArray(raw) ? raw[0] : raw;

  async function startRecordingService(handler: (req: { url: string }, res: import("node:http").ServerResponse) => void) {
    const seen: Array<{ path: string; accessId?: string; accessSecret?: string; authorization?: string }> = [];
    const server = createServer((req, res) => {
      seen.push({
        path: req.url ?? "",
        accessId: headerValue(req.headers["cf-access-client-id"]),
        accessSecret: headerValue(req.headers["cf-access-client-secret"]),
        authorization: headerValue(req.headers.authorization),
      });
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => handler({ url: req.url ?? "" }, res));
    });
    stub = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: listen() has resolved on a TCP socket, so address() is an
    // AddressInfo with a bound port, never null or a pipe name.
    const port = (server.address() as { port: number }).port;
    return { seen, url: `http://127.0.0.1:${port}` };
  }

  const okJson = (res: import("node:http").ServerResponse) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ hits: [{ text: "a stored lesson", score: 0.9 }], doc_id: "doc-1", collection: "agent-memory" }));
  };

  it("sends the Access service token alongside the bearer on search and contribute", async () => {
    const service = await startRecordingService((_req, res) => okJson(res));

    const { callTool } = launch({
      OMB_QDRANT_URL: service.url,
      OMB_QDRANT_API_KEY: "bearer-fixture",
      OMB_QDRANT_ACCESS_CLIENT_ID: "fixture-client.access",
      OMB_QDRANT_ACCESS_CLIENT_SECRET: "fixture-access-secret",
      OMB_QDRANT_COLLECTION: "agent-memory",
    });

    await callTool("recall_search", { query: "how do we deploy" });
    await callTool("recall_contribute", {
      text: "A lesson long enough to be a real contribution to the shared corpus.",
      category: "lesson",
    });

    expect(service.seen.map((hit) => hit.path)).toEqual(["/recall/search", "/recall/contribute"]);
    for (const hit of service.seen) {
      expect(hit.accessId).toBe("fixture-client.access");
      expect(hit.accessSecret).toBe("fixture-access-secret");
      // Alongside, not instead of — some deployments gate at the edge, some
      // at the origin, some at both.
      expect(hit.authorization).toBe("Bearer bearer-fixture");
    }
  });

  it("sends no Access headers when no service token is configured", async () => {
    const service = await startRecordingService((_req, res) => okJson(res));

    const { callTool } = launch({ OMB_QDRANT_URL: service.url, OMB_QDRANT_API_KEY: "bearer-fixture" });
    await callTool("recall_search", { query: "how do we deploy" });

    expect(service.seen).toHaveLength(1);
    expect(service.seen[0].accessId).toBeUndefined();
    expect(service.seen[0].accessSecret).toBeUndefined();
    expect(service.seen[0].authorization).toBe("Bearer bearer-fixture");
  });

  it("sends only the bearer when just one half of a service token is set", async () => {
    const service = await startRecordingService((_req, res) => okJson(res));

    const { callTool } = launch({
      OMB_QDRANT_URL: service.url,
      OMB_QDRANT_API_KEY: "bearer-fixture",
      OMB_QDRANT_ACCESS_CLIENT_ID: "fixture-client.access",
    });
    await callTool("recall_search", { query: "how do we deploy" });

    expect(service.seen[0].accessId).toBeUndefined();
    expect(service.seen[0].accessSecret).toBeUndefined();
  });

  it("says a login redirect means Access instead of reporting a parse failure", async () => {
    // The redirect target carries Access's own path marker
    // (/cdn-cgi/access/login/...), which is what a real Access gateway always
    // sends regardless of which host answers it — so this stays hermetic
    // (same origin as the stub, no live DNS/network dependency) while still
    // exercising the real "follow, then recognise" path a genuine Access
    // redirect takes.
    const service = await startRecordingService((req, res) => {
      if ((req.url ?? "").startsWith("/cdn-cgi/access/login/")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>Sign in with your identity provider to continue.</body></html>");
        return;
      }
      res.writeHead(302, { location: "/cdn-cgi/access/login/recall.example.com?kid=fixture" });
      res.end();
    });

    const { callTool } = launch({ OMB_QDRANT_URL: service.url, OMB_QDRANT_API_KEY: "bearer-fixture" });
    const text = await callTool("recall_search", { query: "how do we deploy" });

    expect(text).toContain("login page");
    expect(text).toContain("Cloudflare Access");
    expect(text).toContain("service token");
    // The old failure mode: the redirect got followed and the HTML came back
    // as an unreadable search error.
    expect(text).not.toMatch(/JSON|unexpected token/i);
  });
});

describe("Agent RAG proxy follows benign same-host redirects", () => {
  // The bug this guards against: a fetch made with `redirect: "manual"`
  // treats ANY 3xx as an identity gateway, so a plain http:// -> https://
  // upgrade (301) or a trailing-slash normalisation (308) on the operator's
  // own host got misdiagnosed as "behind Cloudflare Access — add a service
  // token" when the real fix was just the URL.  These follow the redirect
  // (matching the driver's `redirect: "follow"`) and land on the service's
  // real answer.

  it("follows a same-host 301 (e.g. an http:// -> https:// upgrade) instead of reporting an Access gate", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(301, { location: "/health-canonical" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ collection: "agent-memory", points: 12, backend_ok: true, version: "1.0.0" }));
    });
    stub = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: listen() has resolved on a TCP socket, so address() is an
    // AddressInfo with a bound port, never null or a pipe name.
    const port = (server.address() as { port: number }).port;

    const { callTool } = launch({ OMB_QDRANT_URL: `http://127.0.0.1:${port}`, OMB_QDRANT_COLLECTION: "agent-memory" });
    const text = await callTool("recall_stats");

    expect(text).not.toMatch(/identity gateway|Cloudflare Access|login page/i);
    expect(text).toContain("agent-memory");
  });

  it("follows a same-host 308 trailing-slash normalisation instead of reporting an Access gate", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(308, { location: "/health/" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ collection: "agent-memory", points: 34, backend_ok: true, version: "1.0.0" }));
    });
    stub = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: listen() has resolved on a TCP socket, so address() is an
    // AddressInfo with a bound port, never null or a pipe name.
    const port = (server.address() as { port: number }).port;

    const { callTool } = launch({ OMB_QDRANT_URL: `http://127.0.0.1:${port}`, OMB_QDRANT_COLLECTION: "agent-memory" });
    const text = await callTool("recall_stats");

    expect(text).not.toMatch(/identity gateway|Cloudflare Access|login page/i);
    expect(text).toContain("agent-memory");
  });

  it("recall_search and recall_contribute follow a benign same-host redirect instead of reporting an Access gate", async () => {
    // This is the bot path, not just the settings-panel probe above — the
    // same bug made every tool call through a redirected host look dead.
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const url = req.url ?? "";
        if (url === "/recall/search") {
          res.writeHead(307, { location: "/recall/search/canonical" });
          res.end();
          return;
        }
        if (url === "/recall/contribute") {
          res.writeHead(307, { location: "/recall/contribute/canonical" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        if (url === "/recall/search/canonical") {
          res.end(JSON.stringify({ hits: [{ text: "a stored lesson", score: 0.9 }], mode: "hybrid" }));
          return;
        }
        res.end(JSON.stringify({ doc_id: "doc-99", collection: "agent-memory" }));
      });
    });
    stub = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: listen() has resolved on a TCP socket, so address() is an
    // AddressInfo with a bound port, never null or a pipe name.
    const port = (server.address() as { port: number }).port;

    const { callTool } = launch({ OMB_QDRANT_URL: `http://127.0.0.1:${port}`, OMB_QDRANT_COLLECTION: "agent-memory" });
    const searchText = await callTool("recall_search", { query: "how do we deploy" });
    const contributeText = await callTool("recall_contribute", {
      text: "A lesson long enough to be a real contribution to the shared corpus.",
      category: "lesson",
    });

    expect(searchText).toContain("a stored lesson");
    expect(searchText).not.toMatch(/identity gateway|Cloudflare Access|login page/i);
    expect(contributeText).toContain("doc-99");
    expect(contributeText).not.toMatch(/identity gateway|Cloudflare Access|login page/i);
  });
});
