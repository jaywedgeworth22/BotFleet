// Sentry AI / agent observability for the BotFleet harness.
//
// Drivers speak CLI, ACP, or raw OpenAI-compatible HTTP — not the OpenAI,
// Anthropic, Vercel AI, or LangChain SDKs — so official auto-instrumentation
// has nothing to patch.  We emit the same gen_ai.* spans those integrations
// would: invoke_agent, execute_tool, gen_ai.chat.  Conversation id is the
// thread id.  Prompts, transcripts, and tool arguments stay off the wire
// (they can carry credentials).
import type { RuntimeEvent } from "./contracts.ts";
import { getSentry, isSentryInitialized } from "./sentry.ts";

export type SpanLike = {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus?(status: { code: number; message?: string }): void;
  end(): void;
};

export type SentryAiSink = {
  setConversationId?: (id: string) => void;
  startInactiveSpan: (opts: {
    op: string;
    name: string;
    attributes?: Record<string, string | number | boolean>;
  }) => SpanLike;
  captureException: (error: Error) => void;
};

type AgentTurn = {
  span: SpanLike;
  model?: string;
  provider: string;
  tools: Map<string, SpanLike>;
};

const turns = new Map<string, AgentTurn>();

function turnKey(threadId: string, turnId?: string): string {
  return `${threadId}:${turnId ?? "_"}`;
}

function liveSink(): SentryAiSink | null {
  if (!isSentryInitialized()) return null;
  const Sentry = getSentry();
  if (!Sentry) return null;
  return {
    startInactiveSpan: (opts) => {
      const span = Sentry.startInactiveSpan({
        op: opts.op,
        name: opts.name,
        attributes: opts.attributes,
      });
      // SAFETY: Sentry v10 inactive spans expose setAttribute/end; setStatus is optional.
      return span as SpanLike;
    },
    captureException: (error) => {
      Sentry.captureException(error);
    },
  };
}

function applyConversation(sink: SentryAiSink, threadId: string): void {
  sink.setConversationId?.(threadId);
}

function genAiProvider(driverKind: string): string {
  const kind = driverKind.toLowerCase();
  if (kind.includes("claude") || kind.includes("anthropic")) return "anthropic";
  if (kind.includes("codex") || kind.includes("openai")) return "openai";
  if (kind.includes("grok") || kind.includes("xai")) return "x_ai";
  if (kind.includes("gemini") || kind.includes("antigravity")) return "gcp.gemini";
  if (kind.includes("deepseek")) return "deepseek";
  return driverKind || "custom";
}

function endTurn(key: string, ok: boolean, usage?: { input?: number; output?: number; cachedInput?: number }): void {
  const turn = turns.get(key);
  if (!turn) return;
  for (const tool of turn.tools.values()) tool.end();
  turn.tools.clear();
  if (usage?.input != null) turn.span.setAttribute("gen_ai.usage.input_tokens", usage.input);
  if (usage?.output != null) turn.span.setAttribute("gen_ai.usage.output_tokens", usage.output);
  if (usage?.cachedInput != null) turn.span.setAttribute("gen_ai.usage.input_tokens.cached", usage.cachedInput);
  if (!ok) turn.span.setStatus?.({ code: 2, message: "internal_error" });
  turn.span.end();
  turns.delete(key);
}

/** Map a harness runtime event onto gen_ai spans.  No-op without a sink. */
export function observeRuntimeEvent(event: RuntimeEvent, sink: SentryAiSink | null = liveSink()): void {
  if (!sink) return;
  applyConversation(sink, event.threadId);
  const key = turnKey(event.threadId, event.turnId);
  const provider = genAiProvider(event.provider);

  switch (event.type) {
    case "turn.started": {
      const span = sink.startInactiveSpan({
        op: "gen_ai.invoke_agent",
        name: `invoke_agent ${event.provider}`,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": event.provider,
          "gen_ai.provider.name": provider,
          "gen_ai.conversation.id": event.threadId,
          "gen_ai.system": provider,
        },
      });
      turns.set(key, { span, provider, tools: new Map() });
      break;
    }
    case "session.started": {
      const turn = turns.get(key);
      if (turn && event.model) {
        turn.model = event.model;
        turn.span.setAttribute("gen_ai.request.model", event.model);
      }
      break;
    }
    case "item.started": {
      if (event.itemType !== "tool") break;
      const turn = turns.get(key);
      if (!turn) break;
      const toolName = (event.title ?? "tool").split(/\s/)[0] || "tool";
      const toolId = event.itemId ?? toolName;
      const toolSpan = sink.startInactiveSpan({
        op: "gen_ai.execute_tool",
        name: `execute_tool ${toolName}`,
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": toolName,
          "gen_ai.conversation.id": event.threadId,
          "gen_ai.agent.name": event.provider,
        },
      });
      turn.tools.set(toolId, toolSpan);
      break;
    }
    case "item.completed": {
      if (event.itemType !== "tool") break;
      const turn = turns.get(key);
      if (!turn || !event.itemId) break;
      const toolSpan = turn.tools.get(event.itemId);
      if (!toolSpan) break;
      if (!event.ok) toolSpan.setStatus?.({ code: 2, message: "internal_error" });
      toolSpan.end();
      turn.tools.delete(event.itemId);
      break;
    }
    case "request.opened": {
      const turn = turns.get(key);
      if (!turn) break;
      const toolName = event.tool || "tool";
      const toolId = event.requestId ?? toolName;
      if (turn.tools.has(toolId)) break;
      const toolSpan = sink.startInactiveSpan({
        op: "gen_ai.execute_tool",
        name: `execute_tool ${toolName}`,
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": toolName,
          "gen_ai.conversation.id": event.threadId,
          "gen_ai.agent.name": event.provider,
        },
      });
      turn.tools.set(toolId, toolSpan);
      break;
    }
    case "thread.token-usage.updated": {
      const turn = turns.get(key);
      if (!turn) break;
      turn.span.setAttribute("gen_ai.usage.input_tokens", event.input);
      turn.span.setAttribute("gen_ai.usage.output_tokens", event.output);
      if (event.cachedInput != null) {
        turn.span.setAttribute("gen_ai.usage.input_tokens.cached", event.cachedInput);
      }
      break;
    }
    case "runtime.error": {
      sink.captureException(new Error(event.message.slice(0, 500)));
      break;
    }
    case "turn.completed": {
      endTurn(key, event.ok, event.usage);
      break;
    }
    default:
      break;
  }
}

export function resetSentryAiForTests(): void {
  for (const turn of turns.values()) {
    for (const tool of turn.tools.values()) tool.end();
    turn.span.end();
  }
  turns.clear();
}

/** Record tool names from an API-backed driver that does not emit item.started. */
export function recordExecutedTools(
  conversationId: string,
  toolNames: string[],
  sink: SentryAiSink | null = liveSink(),
): void {
  if (!sink || toolNames.length === 0) return;
  applyConversation(sink, conversationId);
  for (const raw of toolNames) {
    const toolName = raw.trim() || "tool";
    const span = sink.startInactiveSpan({
      op: "gen_ai.execute_tool",
      name: `execute_tool ${toolName}`,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": toolName,
        "gen_ai.conversation.id": conversationId,
      },
    });
    span.end();
  }
}

/** Wrap one OpenAI-compatible chat completion.  Never attach messages. */
export async function withChatSpan<T extends { usage?: { input: number; output: number } | null }>(
  opts: { model: string; conversationId: string; provider?: string },
  fn: () => Promise<T>,
  sink: SentryAiSink | null = liveSink(),
): Promise<T> {
  if (!sink) return fn();
  const provider = opts.provider ?? "openai";
  const span = sink.startInactiveSpan({
    op: "gen_ai.chat",
    name: `chat ${opts.model}`,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": opts.model,
      "gen_ai.provider.name": provider,
      "gen_ai.system": provider,
      "gen_ai.conversation.id": opts.conversationId,
    },
  });
  try {
    const result = await fn();
    if (result.usage) {
      span.setAttribute("gen_ai.usage.input_tokens", result.usage.input);
      span.setAttribute("gen_ai.usage.output_tokens", result.usage.output);
    }
    return result;
  } catch (error) {
    span.setStatus?.({ code: 2, message: "internal_error" });
    throw error;
  } finally {
    span.end();
  }
}
