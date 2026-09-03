// Fleet Recall & Agent RAG MCP proxy — spawned as an MCP server inside bot processes
// (via the "qdrant" integration). Connects BotFleet bots to the shared fleet-agents
// knowledge corpus (lessons, owner preferences, infrastructure runbooks, and decisions),
// exposing both canonical fleet recall tools and backward-compatible Qdrant aliases:
//
//   recall_search(query, limit?, category?, app?, source?, seat?, since_days?, per_doc?)
//   recall_contribute(text, category, app?, seat?, title?, url?, force?)
//   recall_stats()
//   qdrant_search(query, limit?, collection?, filter?)
//   qdrant_store(text, title?, metadata?, collection?)
//   qdrant_get_context(topic, limit?)
//   qdrant_list_collections()
//
// Speaks raw JSON-RPC 2.0 over stdio matching BotFleet proxy conventions.
import readline from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

const RECALL_URL = (
  process.env.OMB_RECALL_URL ||
  process.env.RECALL_URL ||
  process.env.OMB_QDRANT_URL ||
  process.env.QDRANT_URL ||
  "https://recall.jays.services"
).replace(/\/+$/, "");

const RECALL_API_KEY =
  process.env.OMB_RECALL_API_KEY ||
  process.env.RECALL_API_KEY ||
  process.env.OMB_QDRANT_API_KEY ||
  process.env.QDRANT_API_KEY ||
  "";

const DEFAULT_COLLECTION =
  process.env.OMB_RECALL_COLLECTION ||
  process.env.RECALL_COLLECTION ||
  process.env.OMB_QDRANT_COLLECTION ||
  process.env.QDRANT_COLLECTION ||
  "fleet-agents";

const BOT_NAME = process.env.OMB_BOT_NAME || "Bot";
const AGENT_SEAT = process.env.AGENT_SEAT || BOT_NAME.toUpperCase();

function findRecallCli(): string | null {
  if (process.env.RECALL_CLI_PATH && existsSync(process.env.RECALL_CLI_PATH)) {
    return process.env.RECALL_CLI_PATH;
  }
  const home = homedir();
  const candidates = [
    join(home, ".local", "bin", "recall"),
    join(home, "apps", "mac-collab", "recall"),
    join(home, "apps", "fleet-rag", "recall"),
    "/opt/homebrew/bin/recall",
    "/usr/local/bin/recall",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

interface HitRecord {
  score?: number;
  text?: string;
  source?: string;
  app?: string;
  category?: string;
  seat?: string;
  doc_id?: string;
  title?: string;
  heading?: string;
  url?: string;
  created_at?: number;
}

function formatHits(hits: HitRecord[], mode?: string): string {
  if (!hits || hits.length === 0) {
    return "No matching records found in fleet memory.";
  }
  const modeLabel = mode ? ` (${mode})` : "";
  const formatted = hits.map((hit, idx) => {
    const title = hit.title || hit.heading ? `### ${hit.title || hit.heading}\n` : "";
    const tags = [hit.source, hit.app, hit.category, hit.seat ? `seat:${hit.seat}` : null].filter(Boolean).join(" · ");
    const meta = tags ? `_${tags}_\n` : "";
    const text = hit.text ? hit.text.trim() : "";
    const score = hit.score !== undefined ? `\n_Score: ${(hit.score * 100).toFixed(1)}%_` : "";
    const link = hit.url ? ` | [Link](${hit.url})` : "";
    return `${idx + 1}. ${title}${meta}${text}${score}${link}`;
  }).join("\n\n---\n\n");
  return `Found ${hits.length} hit(s) in fleet memory [${DEFAULT_COLLECTION}]${modeLabel}:\n\n${formatted}`;
}

async function executeRecallCli(subcommand: string, args: string[]): Promise<string> {
  const cli = findRecallCli();
  if (!cli) throw new Error("recall CLI not found on host");

  const fullArgs = [subcommand, ...args];
  const { stdout, stderr } = await execFileAsync(cli, fullArgs, {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${join(homedir(), ".local", "bin")}:${join(homedir(), "apps", "mac-collab")}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`,
    },
  });

  if (stderr && !stdout) {
    throw new Error(stderr.trim());
  }
  return stdout.trim();
}

const TOOLS = [
  {
    name: "recall_search",
    description:
      "Search the fleet's shared knowledge corpus (lessons, owner preferences, infrastructure facts, decisions, runbooks, and notes) in the fleet-agents collection. Hybrid dense + keyword search with cross-encoder reranking.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language question, topic, or search keywords" },
        limit: { type: "number", description: "Maximum number of relevant results to return (default: 5, max: 20)" },
        category: {
          type: "string",
          enum: ["lesson", "preference", "infrastructure", "decision", "runbook", "note", "finding", "doc"],
          description: "Restrict results to one category",
        },
        app: { type: "string", description: "Filter by lowercase app slug (e.g. fleet, botfleet, socratic-trade)" },
        source: {
          type: "string",
          enum: ["board", "effort-log", "apple-note", "doc", "skill", "memory", "agent-contribution"],
          description: "Filter by document source",
        },
        seat: { type: "string", description: "Filter by author seat tag (e.g. CLAUDE, GROK, AG)" },
        since_days: { type: "number", description: "Only return content created in the last N days" },
        per_doc: { type: "number", description: "Best N chunks to return per document (default: 1)" },
      },
      required: ["query"],
    },
  },
  {
    name: "recall_contribute",
    description:
      "Store a reusable piece of knowledge, lesson learned, owner preference, infrastructure fact, or runbook into the shared fleet-agents memory corpus so other bots and fleet seats can retrieve it.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The content or lesson to contribute (40 to 4000 characters)" },
        category: {
          type: "string",
          enum: ["lesson", "preference", "infrastructure", "decision", "runbook"],
          description: "The knowledge category",
        },
        app: { type: "string", description: "Target app slug (default: botfleet)" },
        seat: { type: "string", description: "Author seat or bot identifier (defaults to this bot's name)" },
        title: { type: "string", description: "Optional title or concise summary" },
        url: { type: "string", description: "Optional source link (PR, board item, commit, or doc URL)" },
        force: { type: "boolean", description: "Store even if a near-duplicate contribution already exists" },
      },
      required: ["text", "category"],
    },
  },
  {
    name: "recall_stats",
    description: "Check the health, status, and point counts of the shared fleet-agents memory corpus.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  // Backward-compatible aliases for existing prompts and tests:
  {
    name: "qdrant_search",
    description: "Search the shared vector database and fleet knowledge base for relevant documents or memories.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        limit: { type: "number", description: "Maximum results (default: 5)" },
        collection: { type: "string", description: "Target collection (default: fleet-agents)" },
        filter: { type: "object", description: "Optional metadata filters" },
      },
      required: ["query"],
    },
  },
  {
    name: "qdrant_store",
    description: "Store a new document, note, or lesson in the shared fleet vector database.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text content to store" },
        title: { type: "string", description: "Optional title" },
        metadata: { type: "object", description: "Optional metadata" },
        collection: { type: "string", description: "Target collection (default: fleet-agents)" },
      },
      required: ["text"],
    },
  },
  {
    name: "qdrant_get_context",
    description: "Retrieve synthesized context and prior fleet learnings on a specific topic from fleet memory.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The topic or question to gather context about" },
        limit: { type: "number", description: "Max memories to include (default: 5)" },
      },
      required: ["topic"],
    },
  },
  {
    name: "qdrant_list_collections",
    description: "List the status of the shared fleet vector database and collections.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

async function recallSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query || args.topic || "").trim();
  if (!query) return "Error: query parameter is required";

  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
  const category = args.category ? String(args.category).trim() : undefined;
  const app = args.app ? String(args.app).trim() : undefined;
  const source = args.source ? String(args.source).trim() : undefined;
  const seat = args.seat ? String(args.seat).trim() : undefined;
  const sinceDays = args.since_days ? Number(args.since_days) : undefined;
  const perDoc = args.per_doc ? Number(args.per_doc) : undefined;

  // 1. Try local CLI first (handles near-duplicate, reciprocal rank fusion, cross-encoder rerank)
  if (findRecallCli()) {
    try {
      const cliArgs = ["search", query, "--limit", String(limit), "--json"];
      if (category) cliArgs.push("--category", category);
      if (app) cliArgs.push("--app", app);
      if (source) cliArgs.push("--source", source);
      if (seat) cliArgs.push("--seat", seat);
      if (sinceDays) cliArgs.push("--since-days", String(sinceDays));
      if (perDoc) cliArgs.push("--per-doc", String(perDoc));

      const raw = await executeRecallCli("search", cliArgs.slice(1));
      const data = JSON.parse(raw);
      return formatHits(data.hits || [], data.mode);
    } catch {
      // Fall through to HTTP endpoint if CLI fails
    }
  }

  // 2. HTTP Fallback to recall-api (https://recall.jays.services)
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (RECALL_API_KEY) {
      headers["Authorization"] = `Bearer ${RECALL_API_KEY}`;
    }

    const payload: Record<string, unknown> = { query, limit };
    if (category) payload.category = category;
    if (app) payload.app = app;
    if (source) payload.source = source;
    if (seat) payload.seat = seat;
    if (sinceDays) payload.since_days = sinceDays;

    const res = await fetch(`${RECALL_URL}/recall/search`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) {
      const data = (await res.json()) as { hits?: HitRecord[]; mode?: string };
      return formatHits(data.hits || [], data.mode);
    }
    const errText = await res.text().catch(() => "");
    return `Fleet recall search error (${res.status}): ${errText || res.statusText}`;
  } catch (err) {
    return `Failed to query fleet recall at ${RECALL_URL}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function recallContribute(args: Record<string, unknown>): Promise<string> {
  const text = String(args.text || "").trim();
  if (!text) return "Error: text parameter is required";

  const category = String(args.category || "lesson").trim();
  const app = String(args.app || "botfleet").trim();
  const seat = String(args.seat || BOT_NAME || AGENT_SEAT).trim();
  const title = args.title ? String(args.title).trim() : undefined;
  const url = args.url ? String(args.url).trim() : undefined;
  const force = Boolean(args.force);

  // 1. Try local CLI first
  if (findRecallCli()) {
    try {
      const cliArgs = [text, "--category", category, "--app", app, "--seat", seat, "--json"];
      if (title) cliArgs.push("--title", title);
      if (url) cliArgs.push("--url", url);
      if (force) cliArgs.push("--force");

      const raw = await executeRecallCli("contribute", cliArgs);
      const data = JSON.parse(raw);
      if (data.status === "duplicate") {
        return `Contribution duplicate: ${data.message || "A similar lesson already exists"}`;
      }
      return `Stored in fleet-agents [doc_id: ${data.doc_id || data.id}]: ${title ? `"${title}"` : text.slice(0, 80)}`;
    } catch {
      // Fall through to HTTP endpoint if CLI fails
    }
  }

  // 2. HTTP Fallback to recall-api
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (RECALL_API_KEY) {
      headers["Authorization"] = `Bearer ${RECALL_API_KEY}`;
    }

    const res = await fetch(`${RECALL_URL}/recall/contribute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, category, app, seat, title, url, force }),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) {
      const data = (await res.json()) as { doc_id?: string; id?: string };
      return `Successfully contributed to fleet-agents [id: ${data.doc_id || data.id}]`;
    }
    const errText = await res.text().catch(() => "");
    return `Fleet recall contribute error (${res.status}): ${errText || res.statusText}`;
  } catch (err) {
    return `Failed to contribute to fleet recall at ${RECALL_URL}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function recallStats(): Promise<string> {
  // 1. Try local CLI first
  if (findRecallCli()) {
    try {
      const raw = await executeRecallCli("stats", ["--json"]);
      const data = JSON.parse(raw);
      const points = data.points ? Number(data.points).toLocaleString() : "unknown";
      const status = data.status || "ready";
      const embedder = data.embedder_healthy ? "healthy" : "unreachable";
      return `Fleet Recall Status [${data.collection || DEFAULT_COLLECTION}]:\n- Status: ${status}\n- Points: ${points}\n- Embedder: ${embedder}`;
    } catch {
      // Fall through to HTTP
    }
  }

  // 2. HTTP Fallback
  try {
    const healthRes = await fetch(`${RECALL_URL}/health`, { signal: AbortSignal.timeout(6_000) });
    if (healthRes.ok) {
      const data = (await healthRes.json()) as {
        collection?: string;
        points?: number;
        backend_ok?: boolean;
        version?: string;
      };
      const points = data.points ? data.points.toLocaleString() : "connected";
      return `Fleet Recall Status [${data.collection || DEFAULT_COLLECTION}]:\n- Backend: ${data.backend_ok ? "healthy" : "unknown"}\n- Points: ${points}\n- Service Version: ${data.version || "1.0.0"}`;
    }
    return `Fleet recall endpoint returned HTTP ${healthRes.status}: ${healthRes.statusText}`;
  } catch (err) {
    return `Fleet recall unreachable at ${RECALL_URL}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "recall_search":
    case "qdrant_search":
      return recallSearch(args);

    case "recall_contribute":
      return recallContribute(args);

    case "qdrant_store": {
      const metadata = args.metadata && typeof args.metadata === "object" ? (args.metadata as Record<string, unknown>) : {};
      const category = (metadata.category as string) || "lesson";
      const app = (metadata.app as string) || "fleet";
      return recallContribute({
        text: args.text,
        title: args.title,
        category,
        app,
      });
    }

    case "qdrant_get_context": {
      const topic = String(args.topic || "").trim();
      return recallSearch({ query: topic, limit: args.limit || 5 });
    }

    case "recall_stats":
    case "qdrant_list_collections":
      return recallStats();

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── JSON-RPC Stdio Loop ────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(msg: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function ok(id: unknown, result: unknown) {
  send({ jsonrpc: "2.0", id, result });
}

function error(id: unknown, code: number, message: string) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = parsed;

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: String(params?.protocolVersion ?? "2024-11-05"),
      capabilities: { tools: {} },
      serverInfo: { name: "botfleet-qdrant-rag", version: "1.0.0" },
    });
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    return ok(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const args = (params?.arguments && typeof params.arguments === "object") ? params.arguments : {};
    try {
      const output = await handleToolCall(name, args);
      return ok(id, {
        content: [{ type: "text", text: output }],
      });
    } catch (err) {
      return ok(id, {
        content: [{ type: "text", text: `Tool error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      });
    }
  }

  if (method === "ping") {
    return ok(id, {});
  }

  if (id !== undefined) {
    return error(id, -32601, `Method not found: ${method}`);
  }
});
