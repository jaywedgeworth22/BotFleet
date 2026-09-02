// DeepSeek driver — DeepSeek chat-completions API with SSE streaming. Unlike the
// CLI drivers this one is transcript-replay: the server hands it the
// folded thread history each turn (SendTurnInput.transcript) and it emits
// true token-level content.delta events. Also supplies the instance's
// generateText (bot titles, thread names) — upstream's TextGeneration slot.
import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "deepseek";
const DEFAULT_URL = "https://api.deepseek.com/v1";

// DeepSeek's effort levels are handled implicitly via distinct model selection 
// (e.g., Flash vs Pro vs Reasoner) rather than a separate parameter.
const MODELS = {
  default: "deepseek-v4-flash",
  options: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash-vision-exp", label: "DeepSeek V4 Flash Vision Exp" },
  ],
};

export interface DeepSeekConfig {
  url: string;
  /** resolved at create-time from instance environment / app config */
  apiKeyEnv: string;
}

export interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
}

export function usageFromDeepSeekApi(apiUsage?: DeepSeekUsage | null): { input: number; output: number; cachedInput?: number } | null {
  if (!apiUsage) return null;
  const input = apiUsage.prompt_tokens ?? 0;
  const output = apiUsage.completion_tokens ?? 0;
  const cachedInput = apiUsage.prompt_cache_hit_tokens ?? 0;
  return { input, output, ...(cachedInput > 0 ? { cachedInput } : {}) };
}

export function computeDeepSeekCost(
  modelId: string,
  usage: { input: number; output: number; cachedInput?: number } | null,
): number | null {
  if (!usage) return null;
  const inputTokens = usage.input;
  const outputTokens = usage.output;
  const cachedTokens = usage.cachedInput ?? 0;
  const uncachedInput = Math.max(0, inputTokens - cachedTokens);

  if (modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-flash-vision-exp") {
    return (uncachedInput * 0.7 + cachedTokens * 0.175 + outputTokens * 1.4) / 1_000_000;
  }
  return (uncachedInput * 1.4 + cachedTokens * 0.14 + outputTokens * 2.8) / 1_000_000;
}

function decodeConfig(raw: unknown): DeepSeekConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    url: typeof o.url === "string" ? o.url : DEFAULT_URL,
    apiKeyEnv: typeof o.apiKeyEnv === "string" ? o.apiKeyEnv : "DEEPSEEK_API_KEY",
  };
}

export const DeepSeekDriver: ProviderDriver<DeepSeekConfig> = {
  driverKind: DRIVER_KIND,
  // "(API)" distinguishes this key-billed driver from deepseekAgent, the CLI one
  metadata: { displayName: "DeepSeek (API)", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<DeepSeekConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();

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
      messages: any[],
      model: string,
      opts: { stream: boolean; tools?: any[]; signal?: AbortSignal; onDelta?: (d: string) => void; onToolCallDelta?: (index: number, id?: string, name?: string, args?: string) => void },
    ): Promise<{ text: string; tool_calls?: any[]; usage: { input: number; output: number } | null }> => {
      const res = await fetch(`${config.url}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: opts.stream,
          ...(opts.stream ? { stream_options: { include_usage: true } } : {}),
          ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
        }),
        signal: opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`DeepSeek HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }
      if (!opts.stream) {
        const json: any = await res.json();
        return {
          text: json.choices?.[0]?.message?.content ?? "",
          tool_calls: json.choices?.[0]?.message?.tool_calls,
          usage: usageFromDeepSeekApi(json.usage),
        };
      }
      let text = "";
      let usage: { input: number; output: number; cachedInput?: number } | null = null;
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
        const delta = chunk.choices?.[0]?.delta?.content;
        const reasoning = chunk.choices?.[0]?.delta?.reasoning_content;
        if (reasoning) {
          opts.onDelta?.(reasoning);
        }
        if (delta) {
          text += delta;
          opts.onDelta?.(delta);
        }
        if (chunk.usage) {
          usage = usageFromDeepSeekApi(chunk.usage);
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
      return { text, usage, tool_calls: streamToolCalls.length > 0 ? streamToolCalls : undefined };
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const openAiTools = (turn as any).tools ? (turn as any).tools.map((t: any) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters ?? { type: "object", properties: {}, required: [] },
        },
      })) : undefined;
      const { threadId } = turn;
      if (!apiKey) throw new Error(`no DeepSeek key — set ${config.apiKeyEnv} or config.json deepseek.key`);
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const abort = new AbortController();
      let streamedText = false;
      // the backoff is scaled down in tests so a fake's transient failures
      // don't stall real seconds
      const retryScale = Number(process.env.FAKE_DEEPSEEK_RETRY_SCALE ?? "1");
      active.set(threadId, { abort, turnId });

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
                res.push({ role: "tool", tool_call_id: tr.id, content: tr.result });
              }
            } else {
              res.push({ role: "user", content: m.text });
            }
          }
          return res;
        }),
        { role: "user", content: turn.text },
      ];
      appendNative(threadId, { dir: "out", source: "deepseek.chat.completions", msg: { model: turn.model, messages } });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? MODELS.default });

      (async () => {
        let attempt = 0;
        for (;;) {
          try {
            const { text, usage, tool_calls } = await complete(messages, turn.model || MODELS.default, {
              stream: true,
              tools: openAiTools,
              signal: abort.signal,
              onDelta: (delta) => {
                streamedText = true;
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
              },
              onToolCallDelta: (index, id, name, args) => {
                emit({ ...base(threadId, turnId), type: "tool_call.delta", index, toolCallId: id, name, args });
              },
            });
            appendNative(threadId, { dir: "in", source: "deepseek.chat.completions", msg: { text, usage } });
            if (text.trim()) {
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
            }
            if (tool_calls && tool_calls.length > 0) {
              for (const tc of tool_calls) {
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool_call", toolCallId: tc.id, name: tc.function.name, args: tc.function.arguments });
              }
            }
            if (usage) {
              emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...usage });
            }
            const cost = computeDeepSeekCost(turn.model || MODELS.default, usage);
            active.delete(threadId);
            emit({
              ...base(threadId, turnId),
              type: "turn.completed",
              ok: true,
              stopReason: null,
              cost,
              ...(usage ? { usage } : {}),
            });
            return;
          } catch (e) {
            const aborted = (e as Error).name === "AbortError";
            const failure = e instanceof Error ? e : { text: String(e) };
            const verdict = classifyError(failure);
            if (!aborted && !streamedText && verdict.transient && attempt < RETRY_MAX_ATTEMPTS - 1) {
              const delayMs = computeBackoff(attempt);
              attempt++;
              emit({
                ...base(threadId, turnId),
                type: "turn.retrying",
                attempt,
                delayMs,
                reason: verdict.reason,
              });
              const wait = interruptibleDelay(delayMs * retryScale, abort.signal);
              const outcome = await wait.promise;
              if (outcome === "cancelled" || abort.signal.aborted) {
                active.delete(threadId);
                emit({
                  ...base(threadId, turnId),
                  type: "turn.completed",
                  ok: false,
                  stopReason: "interrupted",
                  cost: null,
                });
                return;
              }
              continue;
            }
            active.delete(threadId);
            if (!aborted) {
              emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
            }
            emit({
              ...base(threadId, turnId),
              type: "turn.completed",
              ok: false,
              stopReason: aborted ? "interrupted" : "error",
              cost: null,
            });
            return;
          }
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!apiKey) {
        return {
          state: "unavailable",
          reason: `no DeepSeek API key — add {"deepseek":{"key":"deepseek-…"}} to ~/.botfleet/config.json or set ${config.apiKeyEnv}`,
        };
      }
      return { state: "available", authenticated: true, version: null };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session", localComputerMcp: true },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async () => "unavailable" as const, // this engine has no asks to answer
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
        const { text } = await complete([{ role: "user", content: prompt }], MODELS.default, { stream: false });
        return text;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
