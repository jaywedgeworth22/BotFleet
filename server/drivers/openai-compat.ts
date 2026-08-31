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
    const active = new Map<string, { abort: AbortController; turnId: string }>();
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
      const res = await fetch(`${config.url}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(bodyPayload),
        signal: opts.signal ?? AbortSignal.timeout(120_000),
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
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
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
              const tcId = tc.id;
              const tcName = tc.function?.name;
              const tcArgs = tc.function?.arguments;
              opts.onToolCallDelta?.(tcIndex, tcId, tcName, tcArgs);
            }
          }
          if (chunk.usage) {
            usage = {
              input: chunk.usage.prompt_tokens ?? 0,
              output: chunk.usage.completion_tokens ?? 0,
            };
          }
        }
      }
      return { text, reasoning, usage };
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
      active.set(threadId, { abort, turnId });

      const openAiTools = (turn as any).tools ? (turn as any).tools.map((t: any) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters ?? { type: "object", properties: {}, required: [] },
        },
      })) : undefined;

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
        { role: "user", content: turn.text },
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

      (async () => {
        try {
          const { text, reasoning, tool_calls, usage } = await complete(
            messages,
            turn.model || catalog.default,
            {
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
              onToolCallDelta: (index, id, name, args) => {
                emit({
                  ...base(threadId, turnId),
                  type: "tool_call.delta",
                  index,
                  toolCallId: id,
                  name,
                  args,
                } as any);
              }
            },
          );
          appendNative(threadId, {
            dir: "in",
            source: "openai-compat.chat.completions",
            msg: { textLength: text.length, reasoningLength: reasoning.length, toolCallsLength: tool_calls?.length ?? 0, usage },
          });
          const replyText = text.trim() ? text : reasoning;
          if (replyText.trim() || (tool_calls && tool_calls.length > 0)) {
            emit({
              ...base(threadId, turnId),
              type: "item.completed",
              itemType: "assistant_text",
              text: replyText,
              toolCalls: tool_calls,
            } as any);
          }
          if (usage) {
            emit({
              ...base(threadId, turnId),
              type: "thread.token-usage.updated",
              ...usage,
            });
          }
          active.delete(threadId);
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: true,
            stopReason: null,
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
        capabilities: { sessionModelSwitch: "in-session", localComputerMcp: true },
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
