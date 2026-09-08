// Sentry AI / agent observability for the BotFleet harness.
//
// Drivers speak CLI, ACP, or raw OpenAI-compatible HTTP — not the OpenAI,
// Anthropic, Vercel AI, or LangChain SDKs — so official auto-instrumentation
// has nothing to patch.  We emit the same gen_ai.* spans those integrations
// would: invoke_agent, execute_tool, gen_ai.chat.  Conversation id is the
// thread id.  Prompts, transcripts, and tool arguments stay off the wire
// (they can carry credentials).
//
// The gen_ai.* vocabulary here is SENTRY's, not Usage Monitor's.  `x_ai`,
// `gcp.gemini`, and `moonshot` are Sentry provider names; the Usage Monitor
// canon (`xai`, `google-ai`, …) lives in server/telemetry.ts.  The two must
// not be unified — they are different registries that happen to overlap.
import type { RuntimeEvent } from "./contracts.ts";
import { observability } from "./observability.ts";
import { getSentry, isSentryActive } from "./sentry.ts";

export type SpanLike = {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus?(status: { code: number; message?: string }): void;
  end(): void;
};

/** Scope a single capture without touching the global Sentry scope. */
export type SentryCaptureContext = {
  tags?: Record<string, string>;
};

export type SentryBreadcrumb = {
  category: string;
  message: string;
  level?: "info" | "warning" | "error";
  data?: Record<string, string | number | boolean>;
};

export type SentryAiSink = {
  setConversationId?: (id: string) => void;
  startInactiveSpan: (opts: {
    op: string;
    name: string;
    attributes?: Record<string, string | number | boolean>;
  }) => SpanLike;
  captureException: (error: Error, context?: SentryCaptureContext) => void;
  addBreadcrumb?: (crumb: SentryBreadcrumb) => void;
};

/** Who ran this turn.  A driver only ever knows a thread id; the harness
 * store knows which bot, which engine instance, and which room that thread
 * belongs to, so the harness installs a resolver at boot and every span
 * picks the identity up from there. */
export interface TurnIdentity {
  botId?: string;
  botName?: string;
  instanceId?: string;
  model?: string;
  roomId?: string;
  roomName?: string;
}

type AgentTurn = {
  span: SpanLike;
  model?: string;
  provider: string;
  identity: TurnIdentity | null;
  tools: Map<string, SpanLike>;
};

const turns = new Map<string, AgentTurn>();

let identityResolver: ((threadId: string) => TurnIdentity | null) | null = null;

/** Install (or clear, with null) the harness's thread → identity lookup. */
export function configureTurnIdentity(
  resolver: ((threadId: string) => TurnIdentity | null) | null,
): void {
  identityResolver = resolver;
}

function identityFor(threadId: string): TurnIdentity | null {
  if (!identityResolver) return null;
  try {
    return identityResolver(threadId);
  } catch {
    // Telemetry must never take down a turn.  A resolver that throws —
    // a store lookup racing a deleted bot — degrades to no identity.
    return null;
  }
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed || undefined;
}

/** The botfleet.* attributes one turn contributes to a span or a capture.
 * Every field is optional because a blank one is skipped outright: an
 * empty-string tag is worse than an absent one, since Sentry then groups
 * every unidentified turn under a single facet value. */
export type TurnIdentityAttributes = {
  "botfleet.bot.id"?: string;
  "botfleet.bot.name"?: string;
  "botfleet.instance.id"?: string;
  "botfleet.room.id"?: string;
  "botfleet.room.name"?: string;
};

/** Identity attributes plus `gen_ai.agent.name`, for the span shapes that
 * have no driver kind to fall back on. */
export type IdentifiedAgentAttributes = TurnIdentityAttributes & {
  "gen_ai.agent.name"?: string;
};

/** What a failed turn is tagged with in Sentry. */
export type TurnFailureTags = TurnIdentityAttributes & {
  "botfleet.provider": string;
  "botfleet.thread.id": string;
  "gen_ai.provider.name": string;
  "gen_ai.request.model"?: string;
};

function identityAttributes(identity: TurnIdentity | null): TurnIdentityAttributes {
  const out: TurnIdentityAttributes = {};
  if (!identity) return out;
  const put = (key: keyof TurnIdentityAttributes, value: string | undefined) => {
    const text = clean(value);
    if (text) out[key] = text;
  };
  put("botfleet.bot.id", identity.botId);
  put("botfleet.bot.name", identity.botName);
  put("botfleet.instance.id", identity.instanceId);
  put("botfleet.room.id", identity.roomId);
  put("botfleet.room.name", identity.roomName);
  return out;
}

function identityWithAgentName(identity: TurnIdentity | null): IdentifiedAgentAttributes {
  const out: IdentifiedAgentAttributes = identityAttributes(identity);
  const botName = clean(identity?.botName);
  if (botName) out["gen_ai.agent.name"] = botName;
  return out;
}

function agentName(identity: TurnIdentity | null, fallback: string): string {
  return clean(identity?.botName) ?? fallback;
}

function turnKey(threadId: string, turnId?: string): string {
  return `${threadId}:${turnId ?? "_"}`;
}

function liveSink(): SentryAiSink | null {
  if (!isSentryActive()) return null;
  const Sentry = getSentry();
  if (!Sentry) return null;
  return {
    setConversationId: (id) => {
      Sentry.setConversationId(id);
    },
    startInactiveSpan: (opts) => {
      const span = Sentry.startInactiveSpan({
        op: opts.op,
        name: opts.name,
        attributes: opts.attributes,
      });
      // SAFETY: Sentry v10 inactive spans expose setAttribute/end; setStatus is optional.
      return span as SpanLike;
    },
    captureException: (error, context) => {
      Sentry.captureException(error, context?.tags ? { tags: context.tags } : undefined);
      observability.noteCapture();
    },
    addBreadcrumb: (crumb) => {
      Sentry.addBreadcrumb({
        category: crumb.category,
        message: crumb.message,
        level: crumb.level ?? "info",
        data: crumb.data,
      });
    },
  };
}

function applyConversation(sink: SentryAiSink, threadId: string): void {
  sink.setConversationId?.(threadId);
}

// Sentry's gen_ai.provider.name vocabulary, keyed by lowercased driver kind.
// A substring test used to answer "openai" for `openai-compat`, which put
// every OpenRouter and Groq span in the OpenAI provider bucket.
const GEN_AI_PROVIDERS = new Map<string, string>([
  ["codex", "openai"],
  ["openai", "openai"],
  ["openai-compat", "openai-compat"],
  ["claude", "anthropic"],
  ["claudeagent", "anthropic"],
  ["anthropic", "anthropic"],
  ["grok", "x_ai"],
  ["grokagent", "x_ai"],
  ["xai", "x_ai"],
  ["antigravity", "gcp.gemini"],
  ["antigravityagent", "gcp.gemini"],
  ["gemini", "gcp.gemini"],
  ["deepseek", "deepseek"],
  ["deepseekagent", "deepseek"],
  ["dsh", "deepseek"],
  ["dshagent", "deepseek"],
  ["kimi", "moonshot"],
  ["kimiagent", "moonshot"],
  ["cursor", "cursor"],
  ["cursoragent", "cursor"],
  ["minimax", "minimax"],
  ["boxagent", "box"],
]);

/** Map a BotFleet driver kind onto Sentry's provider vocabulary.  An engine
 * Sentry has no name for keeps its own kind rather than being folded into a
 * neighbour it does not belong to. */
export function genAiProvider(driverKind: string): string {
  const kind = (driverKind || "").trim().toLowerCase();
  return GEN_AI_PROVIDERS.get(kind) ?? (driverKind || "custom");
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
      const identity = identityFor(event.threadId);
      const span = sink.startInactiveSpan({
        op: "gen_ai.invoke_agent",
        name: `invoke_agent ${event.provider}`,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": agentName(identity, event.provider),
          "gen_ai.provider.name": provider,
          "gen_ai.conversation.id": event.threadId,
          "gen_ai.system": provider,
          ...identityAttributes(identity),
        },
      });
      const model = clean(identity?.model);
      if (model) span.setAttribute("gen_ai.request.model", model);
      turns.set(key, { span, provider, identity, model, tools: new Map() });
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
    case "session.exited": {
      // A session that dies mid-turn never sends turn.completed, so the
      // invoke_agent span would hang open until the process exits.
      const prefix = `${event.threadId}:`;
      for (const openKey of turns.keys()) {
        if (openKey.startsWith(prefix)) endTurn(openKey, false);
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
          "gen_ai.agent.name": agentName(turn.identity, event.provider),
          ...identityAttributes(turn.identity),
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
      if (!event.ok) {
        toolSpan.setStatus?.({ code: 2, message: "internal_error" });
        // A failure's one-line detail is the whole reason the row is worth
        // reading.  Arguments stay off the wire; only the result line goes.
        const detail = clean(event.detail);
        if (detail) toolSpan.setAttribute("gen_ai.tool.result.detail", detail.slice(0, 200));
      }
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
          "gen_ai.agent.name": agentName(turn.identity, event.provider),
          ...identityAttributes(turn.identity),
        },
      });
      turn.tools.set(toolId, toolSpan);
      break;
    }
    case "request.resolved": {
      const turn = turns.get(key);
      if (!turn || !event.requestId) break;
      const toolSpan = turn.tools.get(event.requestId);
      if (!toolSpan) break;
      toolSpan.setAttribute("botfleet.approval.behavior", event.behavior);
      toolSpan.setAttribute("botfleet.approval.source", event.source);
      toolSpan.end();
      turn.tools.delete(event.requestId);
      break;
    }
    case "turn.retrying": {
      sink.addBreadcrumb?.({
        category: "botfleet.turn",
        message: `turn retrying: ${clean(event.reason)?.slice(0, 200) ?? "unknown"}`,
        level: "warning",
        data: {
          attempt: event.attempt,
          delayMs: event.delayMs,
          provider: event.provider,
          threadId: event.threadId,
        },
      });
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
      if (!event.ok) {
        // A failed turn is the thing an operator wants an Issue for.  Most
        // drivers report the failure only here — they never emit
        // runtime.error — so without this a broken engine was invisible.
        const turn = turns.get(key);
        const identity = turn?.identity ?? identityFor(event.threadId);
        const tags: TurnFailureTags = {
          "botfleet.provider": event.provider,
          "botfleet.thread.id": event.threadId,
          "gen_ai.provider.name": provider,
          ...identityAttributes(identity),
        };
        const model = clean(turn?.model) ?? clean(identity?.model);
        if (model) tags["gen_ai.request.model"] = model;
        const stopReason = clean(event.stopReason)?.slice(0, 200) ?? "unknown";
        sink.captureException(new Error(`bot turn failed: ${stopReason}`), { tags });
      }
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
  identityResolver = null;
}

/** Record tool names from an API-backed driver that does not emit item.started. */
export function recordExecutedTools(
  conversationId: string,
  toolNames: string[],
  sink: SentryAiSink | null = liveSink(),
): void {
  if (!sink || toolNames.length === 0) return;
  applyConversation(sink, conversationId);
  const identityAttrs = identityWithAgentName(identityFor(conversationId));
  for (const raw of toolNames) {
    const toolName = raw.trim() || "tool";
    const span = sink.startInactiveSpan({
      op: "gen_ai.execute_tool",
      name: `execute_tool ${toolName}`,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": toolName,
        "gen_ai.conversation.id": conversationId,
        ...identityAttrs,
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
  const identityAttrs = identityWithAgentName(identityFor(opts.conversationId));
  const span = sink.startInactiveSpan({
    op: "gen_ai.chat",
    name: `chat ${opts.model}`,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": opts.model,
      "gen_ai.provider.name": provider,
      "gen_ai.system": provider,
      "gen_ai.conversation.id": opts.conversationId,
      ...identityAttrs,
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
