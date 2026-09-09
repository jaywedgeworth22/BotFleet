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
import { parseToolArguments, toolFields } from "../tool-fields.ts";
import { recordExecutedTools, withChatSpan } from "../sentry-ai.ts";

const DRIVER_KIND = "openai-compat";

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
  /** Custom configured models list (IDs or objects) */
  models?: Array<string | { id: string; label?: string }>;
  /** Custom icon URL or data URL (SVG, PNG, etc.) */
  iconUrl?: string;
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
  const rawModels = Array.isArray(o.models) ? o.models : undefined;
  const models: Array<string | { id: string; label?: string }> = [];
  if (rawModels) {
    for (const m of rawModels) {
      if (typeof m === "string" && m.trim()) {
        models.push(m.trim());
      } else if (typeof m === "object" && m !== null && typeof (m as any).id === "string" && (m as any).id.trim()) {
        const id = String((m as any).id).trim();
        const label = typeof (m as any).label === "string" && (m as any).label.trim() ? String((m as any).label).trim() : undefined;
        models.push(label ? { id, label } : { id });
      }
      if (models.length >= 15) break;
    }
  }

  return {
    url:
      typeof o.url === "string" && o.url
        ? o.url.replace(/\/+$/, "")
        : envUrl
          ? envUrl.replace(/\/+$/, "")
          : "https://openrouter.ai/api/v1",
    apiKeyEnv: typeof o.apiKeyEnv === "string" && o.apiKeyEnv ? o.apiKeyEnv : "OPENAI_COMPAT_API_KEY",
    key: typeof o.key === "string" && o.key ? o.key : undefined,
    models: models && models.length > 0 ? models : undefined,
    iconUrl: typeof o.iconUrl === "string" && o.iconUrl.trim() ? o.iconUrl.trim() : undefined,
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
    const active = new Map<string, { abort: AbortController; turnId: string }>();
    const isCustomInstance = instanceId !== "openaiCompat";
    let catalog = DEFAULT_MODELS;
    if (config.models && config.models.length > 0) {
      const options: ModelCatalog["options"] = config.models.map((m) => {
        const id = typeof m === "string" ? m : m.id;
        const label = typeof m === "object" && m.label ? m.label : id;
        return { id, label, custom: true };
      });
      catalog = { default: options[0].id, options };
    }

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
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`;
      }
      const res = await fetch(`${config.url}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(bodyPayload),
        signal: opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(120_000),
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
            if (!streamToolCalls[tcIndex]) streamToolCalls[tcIndex] = { id: "", function: { name: "", arguments: "" } };
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
      if (config.models && config.models.length > 0) return;
      if (!apiKey && !isCustomInstance) return;
      try {
        const headers: Record<string, string> = {};
        if (apiKey) headers.authorization = `Bearer ${apiKey}`;
        const res = await fetch(`${config.url}/models`, {
          headers,
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
    if (apiKey || isCustomInstance) void fetchModels();

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (!apiKey && !isCustomInstance) {
        throw new Error(
          `no API key — set ${config.apiKeyEnv} or add it to the instance config`,
        );
      }
      if (active.has(threadId)) {
        throw new Error("a turn is already running on this thread");
      }
      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId });

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

      const messages = [
        ...(turn.system ? [{ role: "system", content: turn.system }] : []),
        ...(turn.transcript ?? []).flatMap((m: any) => {
          const res = [];
          if (m.role === "assistant") {
            const assistantMsg: any = { role: "assistant", content: m.text || "" };
            if (m.toolCalls && m.toolCalls.length > 0) {
              assistantMsg.tool_calls = m.toolCalls.map((tc: any) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: tc.arguments },
              }));
            }
            res.push(assistantMsg);
          } else {
            if (m.toolResults && m.toolResults.length > 0) {
              for (const tr of m.toolResults) {
                res.push({
                  role: "tool",
                  tool_call_id: tr.id,
                  content: tr.result,
                });
              }
            } else {
              res.push({ role: "user", content: m.text });
            }
          }
          return res;
        }),
        ...(turn.text ? [{ role: "user", content: turn.text }] : []),
      ];
      appendNative(threadId, {
        dir: "out",
        source: "openai-compat.chat.completions",
        // Native logs are diagnostic artifacts users commonly attach to
        // issues. Keep routing metadata, not prompts or transcript content.
        msg: { model: turn.model ?? catalog.default, messageCount: messages.length },
      });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({
        ...base(threadId, turnId),
        type: "session.started",
        sessionId: null,
        model: turn.model ?? catalog.default,
      });

      // Tool ids this turn has already opened a step for.  The stream
      // announces a call once and then keeps sending argument fragments for
      // it, and the settled reply repeats every call — without this a single
      // tool would open a dozen rows.
      const started = new Set<string>();

      (async () => {
        try {
          const model = turn.model || catalog.default;
          const { text, reasoning, tool_calls, usage } = await withChatSpan(
            { model, conversationId: threadId, provider: sentryProviderForUrl(config.url) },
            () =>
              complete(messages, model, {
                stream: true,
                signal: abort.signal,
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
                // settles below where the arguments are whole.
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
              }),
          );
          const toolNames = (tool_calls ?? [])
            .map((tc: { function?: { name?: string } }) => tc?.function?.name)
            .filter((name: unknown): name is string => typeof name === "string" && name.length > 0);
          recordExecutedTools(threadId, toolNames);
          appendNative(threadId, {
            dir: "in",
            source: "openai-compat.chat.completions",
            msg: { textLength: text.length, reasoningLength: reasoning.length, toolCallsLength: tool_calls?.length ?? 0, usage },
          });
          for (const call of tool_calls ?? []) {
            // a step whose arguments never streamed still needs a start, or
            // the completion settles a row nothing opened
            if (call.id && !started.has(call.id)) {
              started.add(call.id);
              emit({
                ...base(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId: call.id,
                title: call.function?.name ?? "tool",
                ...toolFields(call.function?.name, parseToolArguments(call.function?.arguments)),
                arguments: call.function?.arguments,
              });
            }
            emit({
              ...base(threadId, turnId),
              type: "item.completed",
              itemType: "tool",
              itemId: call.id,
              ok: true,
              arguments: call.function?.arguments,
            });
          }
          const replyText = text.trim() ? text : reasoning;
          if (replyText.trim()) {
            emit({
              ...base(threadId, turnId),
              type: "item.completed",
              itemType: "assistant_text",
              text: replyText,
            });
          }
          if (usage) {
            emit({
              ...base(threadId, turnId),
              type: "thread.token-usage.updated",
              ...usage,
            });
          }
          active.delete(threadId);
          const toolCallNames = toolNames.join(", ");
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: true,
            stopReason: toolCallNames ? `tool_calls: ${toolCallNames}` : null,
            cost: null,
            ...(usage ? { usage } : {}),
          });
        } catch (e) {
          active.delete(threadId);
          const aborted = (e as Error).name === "AbortError";
          if (!aborted) {
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: (e as Error).message,
            });
          }
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: false,
            stopReason: aborted ? "interrupted" : "error",
            cost: null,
          });
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!apiKey && !isCustomInstance) {
        return {
          state: "unavailable",
          reason: `no API key — set ${config.apiKeyEnv} or add it to the instance config`,
        };
      }
      return {
        state: "available",
        authenticated: Boolean(apiKey || isCustomInstance),
        version: null,
        ...(apiKey ? { billing: "metered" as const } : {}),
      };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      iconUrl: config.iconUrl,
      get models() {
        return catalog;
      },
      refreshModels: fetchModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        // no MCP server is mounted in this file and respondToRequest answers
        // "unavailable": localComputerMcp would be a knob nothing can turn
        capabilities: { sessionModelSwitch: "in-session", agentsMcp: true },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
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
