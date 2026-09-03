// Qdrant Agent RAG MCP proxy — spawned as an MCP server inside bot processes
// (via the "qdrant" integration). Exposes four tools that let bots perform
// semantic memory retrieval, document storage, and fleet knowledge sharing
// backed by a shared Qdrant vector database:
//
//   qdrant_search(query, limit?, collection?, filter?) → search vector memory
//   qdrant_store(text, title?, metadata?, collection?) → store document / memory
//   qdrant_get_context(topic, limit?)                 → retrieve synthesized context
//   qdrant_list_collections()                         → inspect vector collections
//
// Speaks raw JSON-RPC 2.0 over stdio matching BotFleet proxy conventions.
import readline from "node:readline";
import { createHash, randomUUID } from "node:crypto";

const QDRANT_URL = (
  process.env.OMB_QDRANT_URL ||
  process.env.QDRANT_URL ||
  "http://127.0.0.1:6333"
).replace(/\/+$/, "");

const QDRANT_API_KEY = process.env.OMB_QDRANT_API_KEY || process.env.QDRANT_API_KEY || "";
const DEFAULT_COLLECTION = process.env.OMB_QDRANT_COLLECTION || process.env.QDRANT_COLLECTION || "botfleet-agent-rag";
const BOT_ID = process.env.OMB_BOT_ID || "";
const BOT_NAME = process.env.OMB_BOT_NAME || "Bot";
const VECTOR_SIZE = 128; // Standard fast deterministic semantic projection vector size

function deterministicVector(text: string, size = VECTOR_SIZE): number[] {
  const normalized = text.toLowerCase().trim();
  const vector = new Array<number>(size).fill(0);
  const words = normalized.split(/\s+/).filter(Boolean);
  
  if (words.length === 0) {
    return vector;
  }

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const hash = createHash("sha256").update(word).digest();
    for (let j = 0; j < size; j++) {
      const byteVal = hash[j % hash.length];
      const sign = (byteVal & 1) === 1 ? 1 : -1;
      const weight = (byteVal / 255) * (1 / Math.sqrt(i + 1));
      vector[j] += sign * weight;
    }
  }

  // Normalize to unit length (L2 norm)
  let norm = 0;
  for (let j = 0; j < size; j++) norm += vector[j] * vector[j];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let j = 0; j < size; j++) vector[j] = parseFloat((vector[j] / norm).toFixed(6));
  }
  return vector;
}

async function qdrantFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const url = `${QDRANT_URL}${path.startsWith("/") ? "" : "/"}${path}`;
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");
  if (QDRANT_API_KEY) {
    headers.set("api-key", QDRANT_API_KEY);
  }
  return fetch(url, { ...options, headers });
}

async function ensureCollection(collectionName: string): Promise<boolean> {
  try {
    const checkRes = await qdrantFetch(`/collections/${collectionName}`);
    if (checkRes.ok) return true;
    if (checkRes.status === 404) {
      const createRes = await qdrantFetch(`/collections/${collectionName}`, {
        method: "PUT",
        body: JSON.stringify({
          vectors: {
            size: VECTOR_SIZE,
            distance: "Cosine",
          },
        }),
      });
      return createRes.ok;
    }
    return false;
  } catch {
    return false;
  }
}

const TOOLS = [
  {
    name: "qdrant_search",
    description:
      "Search the shared Qdrant vector database and fleet knowledge base for relevant documents, facts, code snippets, or memories using semantic vector search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The natural language search query or keywords to look up" },
        limit: { type: "number", description: "Maximum number of relevant results to return (default: 5, max: 20)" },
        collection: { type: "string", description: "Target Qdrant collection (default: botfleet-agent-rag)" },
        filter: { type: "object", description: "Optional metadata filters to narrow search results" },
      },
      required: ["query"],
    },
  },
  {
    name: "qdrant_store",
    description:
      "Store a new document, guideline, learning, decision, or note in the shared Qdrant vector database so other bots and future turns can retrieve it via semantic search.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text content, note, or document to store in vector memory" },
        title: { type: "string", description: "Optional title or concise summary of the document" },
        metadata: { type: "object", description: "Optional metadata key-value pairs (e.g. { topic: 'deploy', tags: ['sentry', 'ci'] })" },
        collection: { type: "string", description: "Target Qdrant collection (default: botfleet-agent-rag)" },
      },
      required: ["text"],
    },
  },
  {
    name: "qdrant_get_context",
    description:
      "Quickly retrieve synthesized context and prior fleet learnings on a specific topic from Qdrant vector memory.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The topic, library, or question to gather context about" },
        limit: { type: "number", description: "Max number of relevant memories to include (default: 5)" },
      },
      required: ["topic"],
    },
  },
  {
    name: "qdrant_list_collections",
    description: "List all existing collections and vector statuses available in the shared Qdrant server.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "qdrant_search": {
      const query = String(args.query || "").trim();
      if (!query) return "Error: query parameter is required";
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
      const collection = String(args.collection || DEFAULT_COLLECTION).trim();
      const vector = deterministicVector(query);

      try {
        const searchBody: Record<string, unknown> = {
          vector,
          limit,
          with_payload: true,
        };
        if (args.filter && typeof args.filter === "object") {
          searchBody.filter = args.filter;
        }

        const res = await qdrantFetch(`/collections/${collection}/points/search`, {
          method: "POST",
          body: JSON.stringify(searchBody),
        });

        if (!res.ok) {
          if (res.status === 404) {
            return `Collection "${collection}" does not exist yet. Use qdrant_store to index the first document.`;
          }
          const errText = await res.text().catch(() => "");
          return `Qdrant search error (${res.status}): ${errText || res.statusText}`;
        }

        const data = await res.json() as { result?: Array<{ id: string | number; score: number; payload?: Record<string, unknown> }> };
        const results = data.result || [];
        if (results.length === 0) {
          return `No matching records found in collection "${collection}" for query: "${query}"`;
        }

        const formatted = results.map((item, idx) => {
          const payload = item.payload || {};
          const title = payload.title ? `### ${payload.title}\n` : "";
          const text = payload.text || payload.content || JSON.stringify(payload);
          const author = payload.author ? `Author: ${payload.author} | ` : "";
          const date = payload.createdAt ? `Date: ${payload.createdAt} | ` : "";
          const score = `Similarity: ${(item.score * 100).toFixed(1)}%`;
          return `${idx + 1}. ${title}${text}\n_${author}${date}${score}_`;
        }).join("\n\n---\n\n");

        return `Found ${results.length} relevant record(s) in Qdrant [${collection}]:\n\n${formatted}`;
      } catch (err) {
        return `Failed to reach Qdrant server at ${QDRANT_URL}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case "qdrant_store": {
      const text = String(args.text || "").trim();
      if (!text) return "Error: text parameter is required";
      const title = args.title ? String(args.title).trim() : undefined;
      const collection = String(args.collection || DEFAULT_COLLECTION).trim();
      const metadata = (args.metadata && typeof args.metadata === "object") ? args.metadata as Record<string, unknown> : {};

      try {
        await ensureCollection(collection);
        const vector = deterministicVector(text);
        const pointId = randomUUID();
        const payload = {
          text,
          title,
          author: BOT_NAME,
          botId: BOT_ID,
          createdAt: new Date().toISOString(),
          ...metadata,
        };

        const res = await qdrantFetch(`/collections/${collection}/points?wait=true`, {
          method: "PUT",
          body: JSON.stringify({
            points: [
              {
                id: pointId,
                vector,
                payload,
              },
            ],
          }),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          return `Failed to store point in Qdrant (${res.status}): ${errText || res.statusText}`;
        }

        return `Successfully stored document in Qdrant [collection: ${collection}, id: ${pointId}]${title ? `: "${title}"` : ""}`;
      } catch (err) {
        return `Failed to connect to Qdrant at ${QDRANT_URL}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case "qdrant_get_context": {
      const topic = String(args.topic || "").trim();
      if (!topic) return "Error: topic parameter is required";
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
      const collection = DEFAULT_COLLECTION;

      try {
        const vector = deterministicVector(topic);
        const res = await qdrantFetch(`/collections/${collection}/points/search`, {
          method: "POST",
          body: JSON.stringify({
            vector,
            limit,
            with_payload: true,
          }),
        });

        if (!res.ok) {
          return `No prior context found for "${topic}" (collection ${collection} is empty or uninitialized).`;
        }

        const data = await res.json() as { result?: Array<{ score: number; payload?: Record<string, unknown> }> };
        const results = (data.result || []).filter((r) => r.score > 0.1);
        if (results.length === 0) {
          return `No existing memories or documentation found for topic: "${topic}".`;
        }

        const contextBlocks = results.map((r) => {
          const p = r.payload || {};
          const header = p.title ? `[${p.title}] ` : "";
          return `- ${header}${p.text || JSON.stringify(p)}`;
        }).join("\n");

        return `### Fleet Context on "${topic}":\n\n${contextBlocks}`;
      } catch (err) {
        return `Qdrant server unreachable at ${QDRANT_URL}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case "qdrant_list_collections": {
      try {
        const res = await qdrantFetch("/collections");
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          return `Failed to list collections from Qdrant (${res.status}): ${errText || res.statusText}`;
        }

        const data = await res.json() as { result?: { collections?: Array<{ name: string }> } };
        const collections = data.result?.collections || [];
        if (collections.length === 0) {
          return `Connected to Qdrant at ${QDRANT_URL}. No collections have been created yet. Default collection "${DEFAULT_COLLECTION}" will be created automatically on first store.`;
        }

        const names = collections.map((c) => `- \`${c.name}\``).join("\n");
        return `Qdrant collections at ${QDRANT_URL}:\n\n${names}`;
      } catch (err) {
        return `Cannot connect to Qdrant server at ${QDRANT_URL}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

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
