// Agent RAG & recall MCP proxy — spawned as an MCP server inside bot processes
// (via the "qdrant" integration). Connects BotFleet bots to whatever shared
// vector memory service the operator configures (lessons, preferences,
// infrastructure runbooks, and decisions). There is no built-in endpoint and
// no built-in collection: unconfigured means the tools report that and do
// nothing. Exposes canonical recall tools and backward-compatible aliases:
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
import { accessHeaders, accessLoginHint, type AccessTokenHeaders } from "../recall-access.ts";
import { executeRecallCli, fetchRecall, findRecallCli, probeRecallService, recallStatus,
  RECALL_TOOL_TIMEOUT_MS } from "../recall-transport.ts";
import { describeCliFailure } from "../cli-failure.ts";
import { redactSecretsInText } from "../redact.ts";

// No default endpoint ships with BotFleet: the operator points this at their
// own service in Settings (or via env), and an empty value means "off".
const RECALL_URL = (
  process.env.OMB_RECALL_URL ||
  process.env.RECALL_URL ||
  process.env.OMB_QDRANT_URL ||
  process.env.QDRANT_URL ||
  ""
).trim().replace(/\/+$/, "");

const RECALL_API_KEY =
  process.env.OMB_RECALL_API_KEY ||
  process.env.RECALL_API_KEY ||
  process.env.OMB_QDRANT_API_KEY ||
  process.env.QDRANT_API_KEY ||
  "";

// A Cloudflare Access service token, when the operator's recall service is
// published behind Access.  Access ignores a bearer credential outright, so
// without this pair every request to such a host comes back as a redirect to
// a login page — which reads like an outage.  Sent ALONGSIDE the bearer, not
// instead of it: a deployment may gate at the edge, the origin, or both.
const ACCESS_CLIENT_ID =
  process.env.OMB_RECALL_ACCESS_CLIENT_ID ||
  process.env.OMB_QDRANT_ACCESS_CLIENT_ID ||
  process.env.CF_ACCESS_CLIENT_ID ||
  "";

const ACCESS_CLIENT_SECRET =
  process.env.OMB_RECALL_ACCESS_CLIENT_SECRET ||
  process.env.OMB_QDRANT_ACCESS_CLIENT_SECRET ||
  process.env.CF_ACCESS_CLIENT_SECRET ||
  "";

type RecallHttpHeaders = AccessTokenHeaders & {
  "Content-Type": string;
  Authorization?: string;
};

/** The headers every HTTP call to the recall service carries. */
function recallHttpHeaders(): RecallHttpHeaders {
  const headers: RecallHttpHeaders = {
    "Content-Type": "application/json",
    ...accessHeaders(ACCESS_CLIENT_ID, ACCESS_CLIENT_SECRET),
  };
  if (RECALL_API_KEY) headers.Authorization = `Bearer ${RECALL_API_KEY}`;
  return headers;
}

const DEFAULT_COLLECTION = (
  process.env.OMB_RECALL_COLLECTION ||
  process.env.RECALL_COLLECTION ||
  process.env.OMB_QDRANT_COLLECTION ||
  process.env.QDRANT_COLLECTION ||
  ""
).trim();

/** Shown wherever a collection name would go and none is configured. */
const COLLECTION_LABEL = DEFAULT_COLLECTION || "agent memory";

export const NOT_CONFIGURED_MESSAGE =
  "Agent RAG is not configured — set a Service URL in Settings";

const BOT_NAME = process.env.OMB_BOT_NAME || "Bot";
const AGENT_SEAT = process.env.AGENT_SEAT || BOT_NAME.toUpperCase();

/** With no local CLI and no configured service there is nothing to call, so
 * every tool says so instead of firing a request at a placeholder host. */
function unconfigured(): boolean {
  return !RECALL_URL && !findRecallCli();
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
    return "No matching records found in agent memory.";
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
  return `Found ${hits.length} hit(s) in agent memory [${COLLECTION_LABEL}]${modeLabel}:\n\n${formatted}`;
}

async function runCli(subcommand: string, args: string[]): Promise<string> {
  const cli = findRecallCli();
  if (!cli) throw new Error("recall CLI not found on host");
  return executeRecallCli(cli, [subcommand, ...args], DEFAULT_COLLECTION, RECALL_TOOL_TIMEOUT_MS);
}

/** The service owns one corpus; verify it before sending a query or contribution. */
async function verifyCollection(signal: AbortSignal): Promise<void> {
  if (!DEFAULT_COLLECTION) return;
  await probeRecallService(RECALL_URL, recallHttpHeaders(), DEFAULT_COLLECTION, signal);
}

function safeError(error: unknown): string {
  return redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 400);
}

const TOOLS = [
  {
    name: "recall_search",
    description:
      "Search the configured shared knowledge corpus (lessons, preferences, infrastructure facts, decisions, runbooks, and notes). Hybrid dense + keyword search with cross-encoder reranking.",
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
        app: { type: "string", description: "Filter by lowercase app slug (e.g. botfleet, docs, research)" },
        source: {
          type: "string",
          enum: ["board", "effort-log", "apple-note", "doc", "skill", "memory", "agent-contribution"],
          description: "Filter by document source",
        },
        seat: { type: "string", description: "Filter by author seat tag (the bot or agent that wrote it)" },
        since_days: { type: "number", description: "Only return content created in the last N days" },
        per_doc: { type: "number", description: "Best N chunks to return per document (default: 1)" },
      },
      required: ["query"],
    },
  },
  {
    name: "recall_contribute",
    description:
      "Store a reusable piece of knowledge, lesson learned, preference, infrastructure fact, or runbook into the configured shared memory corpus so other bots and seats can retrieve it.",
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
    description: "Check the health, status, and point counts of the configured shared memory corpus.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  // Backward-compatible aliases for existing prompts and tests:
  {
    name: "qdrant_search",
    description: "Search the configured shared vector database and knowledge base for relevant documents or memories.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        limit: { type: "number", description: "Maximum results (default: 5)" },
        collection: { type: "string", description: "Target collection (defaults to the configured collection)" },
        filter: { type: "object", description: "Optional metadata filters" },
      },
      required: ["query"],
    },
  },
  {
    name: "qdrant_store",
    description: "Store a new document, note, or lesson in the configured shared vector database.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text content to store" },
        title: { type: "string", description: "Optional title" },
        metadata: { type: "object", description: "Optional metadata" },
        collection: { type: "string", description: "Target collection (defaults to the configured collection)" },
      },
      required: ["text"],
    },
  },
  {
    name: "qdrant_get_context",
    description: "Retrieve synthesized context and prior learnings on a specific topic from shared memory.",
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
    description: "List the status of the configured shared vector database and collections.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

async function recallSearch(args: Record<string, unknown>): Promise<string> {
  if (unconfigured()) return NOT_CONFIGURED_MESSAGE;

  const query = String(args.query || args.topic || "").trim();
  if (!query) return "Error: query parameter is required";

  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
  const category = args.category ? String(args.category).trim() : undefined;
  const app = args.app ? String(args.app).trim() : undefined;
  const source = args.source ? String(args.source).trim() : undefined;
  const seat = args.seat ? String(args.seat).trim() : undefined;
  const sinceDays = args.since_days ? Number(args.since_days) : undefined;
  const perDoc = args.per_doc ? Number(args.per_doc) : undefined;

  // An explicit service URL always wins over the host CLI.
  if (!RECALL_URL) {
    try {
      const cliArgs = ["search", query, "--limit", String(limit), "--json"];
      if (category) cliArgs.push("--category", category);
      if (app) cliArgs.push("--app", app);
      if (source) cliArgs.push("--source", source);
      if (seat) cliArgs.push("--seat", seat);
      if (sinceDays) cliArgs.push("--since-days", String(sinceDays));
      if (perDoc) cliArgs.push("--per-doc", String(perDoc));

      const raw = await runCli("search", cliArgs.slice(1));
      const data = JSON.parse(raw);
      return formatHits(data.hits || [], data.mode);
    } catch (error) {
      return `Agent RAG CLI failed: ${describeCliFailure(error, RECALL_TOOL_TIMEOUT_MS)}.`;
    }
  }

  // Use only the configured HTTP service; never retry writes on another transport.
  if (!RECALL_URL) return NOT_CONFIGURED_MESSAGE;
  try {
    const headers = recallHttpHeaders();
    const signal = AbortSignal.timeout(RECALL_TOOL_TIMEOUT_MS);
    await verifyCollection(signal);

    const payload: Record<string, unknown> = { query, limit };
    if (category) payload.category = category;
    if (app) payload.app = app;
    if (source) payload.source = source;
    if (seat) payload.seat = seat;
    if (sinceDays) payload.since_days = sinceDays;
    if (perDoc) payload.per_doc = perDoc;

    const res = await fetchRecall(`${RECALL_URL}/recall/search`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    });

    const gate = accessLoginHint(res);
    if (gate) return `Agent RAG search failed: ${gate}.`;
    if (res.ok) {
      const data = (await res.json()) as { hits?: HitRecord[]; mode?: string; ok?: boolean; error?: unknown };
      if (data.ok === false || data.error || !Array.isArray(data.hits)) throw new Error("the service returned an invalid search result");
      return formatHits(data.hits, data.mode);
    }
    const errText = await res.text().catch(() => "");
    return `Agent RAG search error (${res.status}): ${safeError(errText || res.statusText)}`;
  } catch (err) {
    return `Failed to query agent RAG at ${RECALL_URL}: ${safeError(err)}`;
  }
}

async function recallContribute(args: Record<string, unknown>): Promise<string> {
  if (unconfigured()) return NOT_CONFIGURED_MESSAGE;

  const text = String(args.text || "").trim();
  if (!text) return "Error: text parameter is required";

  const category = String(args.category || "lesson").trim();
  const app = String(args.app || "botfleet").trim();
  const seat = String(args.seat || BOT_NAME || AGENT_SEAT).trim();
  const title = args.title ? String(args.title).trim() : undefined;
  const url = args.url ? String(args.url).trim() : undefined;
  const force = Boolean(args.force);

  // Use the local corpus only when no service URL was selected.
  if (!RECALL_URL) {
    try {
      const cliArgs = [text, "--category", category, "--app", app, "--seat", seat, "--json"];
      if (title) cliArgs.push("--title", title);
      if (url) cliArgs.push("--url", url);
      if (force) cliArgs.push("--force");

      const raw = await runCli("contribute", cliArgs);
      const data = JSON.parse(raw);
      if (data.status === "duplicate") {
        return `Contribution duplicate: ${data.message || "A similar lesson already exists"}`;
      }
      return `Stored in ${COLLECTION_LABEL} [doc_id: ${data.doc_id || data.id}]: ${title ? `"${title}"` : text.slice(0, 80)}`;
    } catch (error) {
      return `Agent RAG CLI failed: ${describeCliFailure(error, RECALL_TOOL_TIMEOUT_MS)}.`;
    }
  }

  // Use only the configured HTTP service; never retry writes on another transport.
  if (!RECALL_URL) return NOT_CONFIGURED_MESSAGE;
  try {
    const headers = recallHttpHeaders();
    const signal = AbortSignal.timeout(RECALL_TOOL_TIMEOUT_MS);
    await verifyCollection(signal);

    const res = await fetchRecall(`${RECALL_URL}/recall/contribute`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, category, app, seat, title, url, force }),
      signal,
    });

    const gate = accessLoginHint(res);
    if (gate) return `Agent RAG contribute failed: ${gate}.`;
    if (res.ok) {
      const data = (await res.json()) as { doc_id?: string; id?: string; ok?: boolean; error?: unknown; status?: string };
      if (data.ok === false || data.error) throw new Error("the service rejected the contribution");
      if (data.status === "duplicate") return "Contribution duplicate: a similar lesson already exists.";
      if (!data.doc_id && !data.id) throw new Error("the service did not confirm a contribution ID; check before retrying");
      return `Successfully contributed to ${COLLECTION_LABEL} [id: ${data.doc_id || data.id}]`;
    }
    const errText = await res.text().catch(() => "");
    return `Agent RAG contribute error (${res.status}): ${safeError(errText || res.statusText)}`;
  } catch (err) {
    return `Failed to contribute to agent RAG at ${RECALL_URL}: ${safeError(err)}`;
  }
}

async function recallStats(): Promise<string> {
  const status = await recallStatus({ url: RECALL_URL, apiKey: RECALL_API_KEY, collection: DEFAULT_COLLECTION,
    accessClientId: ACCESS_CLIENT_ID, accessClientSecret: ACCESS_CLIENT_SECRET });
  if (!status.configured) return NOT_CONFIGURED_MESSAGE;
  if (!status.ready) return `Agent RAG status check failed: ${status.error}.`;
  return `Agent RAG status [${status.collection}]:\n- Source: ${status.source}\n- Backend: healthy\n- Points: ${status.pointsCount?.toLocaleString()}\n- Checked: ${new Date(status.checkedAt).toISOString()}`;
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  if (args.collection && String(args.collection) !== DEFAULT_COLLECTION) {
    return "Agent RAG cannot select a different collection for one call; select the service and collection in Settings.";
  }
  switch (name) {
    case "recall_search":
    case "qdrant_search":
      return recallSearch(args);

    case "recall_contribute":
      return recallContribute(args);

    case "qdrant_store": {
      const metadata = args.metadata && typeof args.metadata === "object" ? (args.metadata as Record<string, unknown>) : {};
      const category = (metadata.category as string) || "lesson";
      const app = (metadata.app as string) || "botfleet";
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
        content: [{ type: "text", text: `Tool error: ${safeError(err)}` }],
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
