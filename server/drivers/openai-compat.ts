// OpenAI-compatible driver — any endpoint that speaks the OpenAI
// chat-completions shape (OpenRouter, Groq, Together, a local llama.cpp,
// …). This is the "free models" entry point: point it at OpenRouter's
// free tier or Groq's open-model endpoints and a bot runs without a
// paid Claude/Codex/Grok subscription.
//
// Transcript-replay like grok.ts: the harness folds thread history and
// hands it back each turn (SendTurnInput.transcript); we emit true
// token-level content.delta events and supply generateText.
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";
import { toolFields } from "../tool-fields.ts";
import { recordExecutedTools, withChatSpan } from "../sentry-ai.ts";
import { runTurnLoop, type ChatMessage, type TurnLoopDeps } from "./chat-completions/loop.ts";

const DRIVER_KIND = "openai-compat";

// One model request's ceiling.  Unchanged from the pre-loop driver, and
// handed to the loop as its per-round budget so an OpenRouter or Groq bot
// waits exactly as long as it always has.
const REQUEST_TIMEOUT_MS = 120_000;

// Default catalog — overwritten by /models when the endpoint answers.
// Free-tier-friendly defaults so the picker is never empty.
const DEFAULT_MODELS: ModelCatalog = {
  default: "meta-llama/llama-3.3-70b-instruct",
  options: [
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B (OpenRouter)" },
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Groq)" },
  ],
};

export interface OpenAICompatConfig {
  /** Base URL, no trailing /v1 assumed — we append /chat/completions. */
  url: string;
  /** Env var (instance environment or process.env) carrying the API key. */
  apiKeyEnv: string;
  /** Direct API key if configured */
  key?: string;
}

// Sentry's gen_ai.provider.name for whoever is actually answering.  Every
// endpoint here speaks the OpenAI wire shape, so the URL is the only thing
// that says whether a span belongs to OpenAI, OpenRouter, or Groq — calling
// them all "openai" put four vendors in one Sentry bucket.
export function sentryProviderForUrl(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "openai-compat";
  }
  const hostMatches = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (hostMatches("openrouter.ai")) return "openrouter";
  if (hostMatches("groq.com")) return "groq";
  if (hostMatches("api.openai.com")) return "openai";
  return "openai-compat";
}

function decodeConfig(raw: unknown): OpenAICompatConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const envUrl = process.env.OPENAI_COMPAT_URL;
  return {
    url:
      typeof o.url === "string" && o.url
        ? o.url.replace(/\/+$/, "")
        : envUrl
          ? envUrl.replace(/\/+$/, "")
          : "https://openrouter.ai/api/v1",
    apiKeyEnv: typeof o.apiKeyEnv === "string" && o.apiKeyEnv ? o.apiKeyEnv : "OPENAI_COMPAT_API_KEY",
    key: typeof o.key === "string" && o.key ? o.key : undefined,
  };
}

export const OpenAICompatDriver: ProviderDriver<OpenAICompatConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenAI-compatible (OpenRouter / Groq)",
    supportsMultipleInstances: true,
    access: "custom",
  },
  models: DEFAULT_MODELS,
  // No CLI to install — the "install" is getting a free API key.
  install: {
    docsUrl: "https://openrouter.ai/keys",
    signInCommand:
      "add {\"openaiCompat\":{\"key\":\"sk-or-v1-…\"}} to ~/.botfleet/config.json (or set OPENAI_COMPAT_API_KEY)",
    command: {
      darwin:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to ~/.botfleet/config.json under openaiCompat.key",
      linux:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to ~/.botfleet/config.json under openaiCompat.key",
      win32:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to %USERPROFILE%\\.botfleet\\config.json under openaiCompat.key",
    },
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<OpenAICompatConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const apiKey =
      config.key ??
      input.environment[config.apiKeyEnv] ??
      input.environment["OPENAI_COMPAT_API_KEY"] ??
      process.env[config.apiKeyEnv] ??
      process.env["OPENAI_COMPAT_API_KEY"] ??
      "";
    const listeners = new Set<RuntimeEventListener>();
    // Held for the WHOLE turn — every round and every tool call — and dropped
    // only by the loop's finally, so Stop reaches a turn that is sitting
    // between rounds or inside a tool call.
    const active = new Map<string, { abort: AbortController; turnId: string; startedAt: number }>();
    let catalog = DEFAULT_MODELS;

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const complete = async (
      messages: Array<any>,
      model: string,
      opts: {
        stream: boolean;
        signal?: AbortSignal;
        tools?: any[];
        onDelta?: (d: string, streamKind?: "assistant_text" | "reasoning_text") => void;
        onToolCallDelta?: (index: number, id: string | undefined, name: string | undefined, args: string | undefined) => void;
        onUsage?: (usage: { input: number; output: number }) => void;
      },
    ): Promise<{
      text: string;
      reasoning: string;
      tool_calls?: any[];
      usage: { input: number; output: number } | null;
    }> => {
      const bodyPayload: any = { model, messages, stream: opts.stream };
      if (opts.tools && opts.tools.length > 0) {
        bodyPayload.tools = opts.tools;
      }
      // When the caller supplies a signal it already carries this round's
      // deadline (the turn loop arms one per round, at the same 120s this
      // driver has always used).  A second timer here would race it and make
      // a timeout indistinguishable from a provider error at the point where
      // the loop has to name the exit.  Callers with no signal —
      // generateText for titles and summaries — keep the driver's own
      // ceiling.
      const res = await fetch(`${config.url}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(bodyPayload),
        signal: opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `upstream HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        );
      }
      if (!opts.stream) {
        const json: any = await res.json();
        const msg = json.choices?.[0]?.message;
        const mainContent = typeof msg?.content === "string" ? msg.content : "";
        const reasoningContent = typeof msg?.reasoning_content === "string" ? msg.reasoning_content : "";
        return {
          text: mainContent,
          reasoning: reasoningContent,
          tool_calls: msg?.tool_calls,
          usage: json.usage
            ? {
                input: json.usage.prompt_tokens ?? 0,
                output: json.usage.completion_tokens ?? 0,
              }
            : null,
        };
      }
      let text = "";
      let reasoning = "";
      let usage: { input: number; output: number } | null = null;
      let streamToolCalls: any[] = [];
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const takeSseLine = (line: string) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          return;
        }
        const delta = chunk.choices?.[0]?.delta;
        const contentDelta = typeof delta?.content === "string" ? delta.content : undefined;
        const reasoningDelta = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : undefined;
        const toolCallsDelta = Array.isArray(delta?.tool_calls) ? delta.tool_calls : undefined;

        if (reasoningDelta) {
          reasoning += reasoningDelta;
          opts.onDelta?.(reasoningDelta, "reasoning_text");
        }
        if (contentDelta) {
          text += contentDelta;
          opts.onDelta?.(contentDelta, "assistant_text");
        }
        if (toolCallsDelta) {
          for (const tc of toolCallsDelta) {
            const tcIndex = tc.index ?? 0;
            if (!streamToolCalls[tcIndex]) {
              // `type` is part of the OpenAI shape and goes back on the wire
              // verbatim in the next round's assistant message — minimax.ts
              // has always set it and this driver did not.
              streamToolCalls[tcIndex] = { id: "", type: "function", function: { name: "", arguments: "" } };
            }
            // Only the arguments stream in fragments.  A provider that
            // repeats the id and the name on every chunk — several do — used
            // to accumulate `call_acall_acall_a` and `bashbashbash`, so the
            // settled call could never be matched to the step it opened.
            if (tc.id && !streamToolCalls[tcIndex].id) streamToolCalls[tcIndex].id = tc.id;
            if (tc.function?.name && !streamToolCalls[tcIndex].function.name) {
              streamToolCalls[tcIndex].function.name = tc.function.name;
            }
            if (tc.function?.arguments) streamToolCalls[tcIndex].function.arguments += tc.function.arguments;
            opts.onToolCallDelta?.(tcIndex, tc.id, tc.function?.name, tc.function?.arguments);
          }
        }
        if (chunk.usage) {
          usage = {
            input: chunk.usage.prompt_tokens ?? 0,
            output: chunk.usage.completion_tokens ?? 0,
          };
          // LIVE channel, separate from the resolved return value: a round
          // that streams usage and then fails still has to be billed for
          // what it spent.
          opts.onUsage?.(usage);
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          buf += decoder.decode();
          if (buf.trim()) takeSseLine(buf.trim());
          break;
        }
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          takeSseLine(line);
        }
      }
      return { text, reasoning, usage, tool_calls: streamToolCalls.length > 0 ? streamToolCalls : undefined };
    };

    const fetchModels = async (): Promise<void> => {
      if (!apiKey) return;
      try {
        const res = await fetch(`${config.url}/models`, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) return;
        const json: any = await res.json();
        const rows: Array<{ id?: unknown; name?: unknown }> = Array.isArray(json)
          ? json
          : Array.isArray(json?.data)
            ? json.data
            : [];
        const seen = new Set<string>();
        const options: ModelCatalog["options"] = [];
        for (const row of rows) {
          const id = typeof row.id === "string" ? row.id : "";
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const label =
            typeof row.name === "string" && row.name.trim()
              ? row.name
              : id;
          options.push({ id, label });
        }
        if (options.length) {
          catalog = { default: options[0].id, options };
        }
      } catch {
        // keep DEFAULT_MODELS — never fail the instance on a catalog miss
      }
    };
    if (apiKey) void fetchModels();

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      // Validation throws SYNCHRONOUSLY out of sendTurn, before the loop
      // exists, so startTurn's catch runs in milliseconds exactly as it does
      // for a CLI driver — error chip, watchdog settled, bot idle, all three
      // queue drains.  A rejection here must never become a resolved turn
      // that nothing ever settles.
      if (!apiKey) {
        throw new Error(
          `no API key — set ${config.apiKeyEnv} or add it to the instance config`,
        );
      }
      if (active.has(threadId)) {
        throw new Error("a turn is already running on this thread");
      }
      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId, startedAt: Date.now() });

      const openAiTools = turn.tools && turn.tools.length > 0
        ? turn.tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters ?? { type: "object", properties: {}, required: [] },
            },
          }))
        : undefined;

      const model = turn.model || catalog.default;
      // Round 1's prefix.  The loop owns this array from here and only ever
      // APPENDS to it, so rounds 2..N re-send a byte-identical prefix and the
      // endpoint's prompt cache stays reachable.
      const messages: ChatMessage[] = [
        ...(turn.system ? [{ role: "system" as const, content: turn.system }] : []),
        ...(turn.transcript ?? []).flatMap((m): ChatMessage[] => {
          const res: ChatMessage[] = [];
          if (m.role === "assistant") {
            const assistantMsg: ChatMessage = { role: "assistant", content: m.text || "" };
            if (m.toolCalls && m.toolCalls.length > 0) {
              assistantMsg.tool_calls = m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
              }));
            }
            res.push(assistantMsg);
          } else {
            if (m.toolResults && m.toolResults.length > 0) {
              for (const tr of m.toolResults) {
                res.push({ role: "tool", tool_call_id: tr.id, content: tr.result });
              }
            } else {
              res.push({ role: "user", content: m.text });
            }
          }
          return res;
        }),
        ...(turn.text ? [{ role: "user" as const, content: turn.text }] : []),
      ];

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({
        ...base(threadId, turnId),
        type: "session.started",
        sessionId: null,
        model,
      });

      // Tool ids this turn has already opened a step for.  The stream
      // announces a call once and then keeps sending argument fragments for
      // it, and the settled reply repeats every call — without this a single
      // tool would open a dozen rows.  Shared with the loop so a call the
      // stream announced is not announced again when the round settles.
      const started = new Set<string>();

      const runRound: TurnLoopDeps["runRound"] = async (roundMessages, opts) => {
        appendNative(threadId, {
          dir: "out",
          source: "openai-compat.chat.completions",
          // Native logs are diagnostic artifacts users commonly attach to
          // issues. Keep routing metadata, not prompts or transcript content.
          msg: { model, messageCount: roundMessages.length, round: opts.round },
        });
        const { text, reasoning, tool_calls, usage } = await withChatSpan(
          { model, conversationId: threadId, provider: sentryProviderForUrl(config.url) },
          () =>
            complete(roundMessages, model, {
              stream: true,
              signal: opts.signal,
              tools: openAiTools,
              onDelta: (delta, streamKind = "assistant_text") =>
                emit({
                  ...base(threadId, turnId),
                  type: "content.delta",
                  streamKind,
                  delta,
                }),
              // Contract-shaped tool steps.  This used to emit
              // `tool_call.delta`, which is not in the RuntimeEvent union
              // and was cast past the type checker with `as any`; the
              // harness has no arm for it, so a turn that called five
              // tools rendered no steps at all.  A streamed delta is only
              // the argument text arriving, so the step starts here and
              // the loop settles it once the host has actually run it.
              onToolCallDelta: (_index, id, name, args) => {
                if (!id || started.has(id)) return;
                started.add(id);
                emit({
                  ...base(threadId, turnId),
                  type: "item.started",
                  itemType: "tool",
                  itemId: id,
                  title: name || "tool",
                  ...toolFields(name, undefined),
                  arguments: args,
                });
              },
              // Forwarded straight to the loop's own live channel, so a
              // round that errors mid-stream after several chunks still gets
              // its usage folded into the terminal event instead of
              // reporting zero.
              onUsage: (u) => opts.onUsage?.(u),
            }),
        );
        const toolNames = (tool_calls ?? [])
          .map((tc: { function?: { name?: string } }) => tc?.function?.name)
          .filter((name: unknown): name is string => typeof name === "string" && name.length > 0);
        recordExecutedTools(threadId, toolNames);
        appendNative(threadId, {
          dir: "in",
          source: "openai-compat.chat.completions",
          msg: { textLength: text.length, reasoningLength: reasoning.length, toolCallsLength: tool_calls?.length ?? 0, usage, round: opts.round },
        });
        // A reply that is entirely reasoning (no assistant text) still needs
        // to render as something — fall back to the reasoning text rather
        // than settling a silently empty turn.  The loop is what turns a
        // non-empty `text` into the `item.completed` event and into the next
        // round's assistant-message prefix, so folding the fallback in here
        // is what makes both of those honour it too.
        const replyText = text.trim() ? text : reasoning;
        return { text: replyText, usage, toolCalls: tool_calls };
      };

      // Detached, exactly as every CLI driver runs its turn: sendTurn
      // resolves at DISPATCH so markTaskDispatched and the rewind clear are
      // not deferred to the end of the loop.  runTurnLoop never rejects — it
      // emits one turn.completed on every exit and resolves with which one.
      void runTurnLoop({
        base: () => base(threadId, turnId),
        emit,
        runRound,
        messages,
        toolHost: turn.toolHost,
        signal: abort.signal,
        startedToolIds: started,
        // The per-round ceiling this driver has always used, so an
        // OpenRouter or Groq bot waits exactly as long as it did before.
        budget: { requestTimeoutMs: REQUEST_TIMEOUT_MS },
        onSettled: () => active.delete(threadId),
      });

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!apiKey) {
        return {
          state: "unavailable",
          reason: `no API key — set ${config.apiKeyEnv} or add it to the instance config`,
        };
      }
      return { state: "available", authenticated: true, version: null, billing: "metered" };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return catalog;
      },
      refreshModels: fetchModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        // no MCP server is mounted in this file and respondToRequest answers
        // "unavailable": localComputerMcp would be a knob nothing can turn
        // toolLoop: this driver runs the harness tool loop inside sendTurn and
        // emits exactly one turn.started / turn.completed pair per user turn,
        // the way every CLI driver does — so the harness hands it a toolHost
        // and dispatches it on the same one line it uses for Claude.
        capabilities: { sessionModelSwitch: "in-session", agentsMcp: true, toolLoop: true },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        // Insurance the loop's single try/finally should make unreachable: if
        // this ever returns a thread, the loop leaked one, and that is worth
        // knowing.  Aborting settles the turn through the same finally, so
        // even the sweep produces exactly one terminal event.
        sweepStuckTurns: async (olderThanMs: number) => {
          const cutoff = Date.now() - olderThanMs;
          const stuck: string[] = [];
          for (const [threadId, entry] of active) {
            if (entry.startedAt > cutoff) continue;
            stuck.push(threadId);
            entry.abort.abort();
          }
          return stuck;
        },
        respondToRequest: async () => "unavailable" as const,
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { abort } of active.values()) abort.abort();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt: string) => {
        const { text, reasoning } = await complete(
          [{ role: "user", content: prompt }],
          catalog.default,
          { stream: false },
        );
        return text.trim() ? text : reasoning;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
