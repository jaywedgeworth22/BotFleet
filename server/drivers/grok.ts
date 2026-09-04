// Grok driver — xAI chat-completions API with SSE streaming. Unlike the
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
import { parseToolArguments, toolFields } from "../tool-fields.ts";

const DRIVER_KIND = "grok";
const DEFAULT_URL = "https://api.x.ai/v1";

const MODELS = {
  default: "grok-4",
  options: [
    { id: "grok-4", label: "Grok 4" },
    { id: "grok-4-fast", label: "Grok 4 Fast" },
    { id: "grok-3-mini", label: "Grok 3 Mini" },
  ],
};

export interface GrokConfig {
  url: string;
  /** resolved at create-time from instance environment / app config */
  apiKeyEnv: string;
}

function decodeConfig(raw: unknown): GrokConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    url: typeof o.url === "string" ? o.url : DEFAULT_URL,
    apiKeyEnv: typeof o.apiKeyEnv === "string" ? o.apiKeyEnv : "XAI_API_KEY",
  };
}

export const GrokDriver: ProviderDriver<GrokConfig> = {
  driverKind: DRIVER_KIND,
  // "(API)" distinguishes this key-billed driver from grokAgent, the CLI one
  // BYOK, billed to the user's own XAI_API_KEY — the same shape as
  // "MiniMax (API)" and openai-compat, both of which say so.  Omitting it
  // defaulted to "subscription" and put a bring-your-own-key engine above
  // the picker's Custom divider alongside Claude and Codex.
  metadata: { displayName: "Grok (API)", supportsMultipleInstances: true, access: "custom" },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<GrokConfig>): Promise<ProviderInstance> {
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
      opts: { stream: boolean; tools?: any[]; signal?: AbortSignal; onDelta?: (d: string, streamKind?: string) => void; onToolCallDelta?: (index: number, id?: string, name?: string, args?: string) => void },
    ): Promise<{ text: string; tool_calls?: any[]; usage: { input: number; output: number } | null }> => {
      const res = await fetch(`${config.url}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages, stream: opts.stream, ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}) }),
        signal: opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`xAI HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }
      if (!opts.stream) {
        const json: any = await res.json();
        return {
          text: json.choices?.[0]?.message?.content ?? "",
          tool_calls: json.choices?.[0]?.message?.tool_calls,
          usage: json.usage
            ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 }
            : null,
        };
      }
      let text = "";
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
        const deltaObj = chunk.choices?.[0]?.delta;
        const delta = deltaObj?.content;
        const toolCallsDelta = Array.isArray(deltaObj?.tool_calls) ? deltaObj.tool_calls : undefined;
        
        if (delta) {
          text += delta;
          opts.onDelta?.(delta, "assistant_text");
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
          usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
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
      if (!apiKey) throw new Error(`no xAI key — set ${config.apiKeyEnv} or config.json xai.key`);
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const abort = new AbortController();
      let streamedText = false;
      // the backoff is scaled down in tests so a fake's transient failures
      // don't stall real seconds
      const retryScale = Number(process.env.FAKE_GROK_RETRY_SCALE ?? "1");
      active.set(threadId, { abort, turnId });

      
      const messages: any[] = [
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
      
      for (const m of (turn.transcript ?? [])) {
        if (m.role === "assistant") {
          messages.push({ role: "assistant", content: m.text });
        } else {
          messages.push({ role: "user", content: m.text });
        }
      }
      messages.push({ role: "user", content: turn.text });
      appendNative(threadId, { dir: "out", source: "xai.chat.completions", msg: { model: turn.model, messages } });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? MODELS.default });

      // Tool ids this turn has already opened a step for.  The stream
      // announces a call once and then keeps sending argument fragments for
      // it, and the settled reply repeats every call — without this a single
      // tool would open a dozen rows.
      const started = new Set<string>();

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
              // Contract-shaped tool steps.  These three API drivers used to
              // emit `tool_call.delta` and `itemType: "tool_call"` — neither
              // is in the RuntimeEvent union, both were cast past the type
              // checker with `as any`, and the harness's switch has no arm
              // for either, so a turn that called five tools rendered no
              // steps at all.  A streamed delta is only the argument text
              // arriving, so the step starts here and settles on the
              // completed call below, where the arguments are whole.
              onToolCallDelta: (_index, id, name) => {
                if (!id || started.has(id)) return;
                started.add(id);
                emit({
                  ...base(threadId, turnId),
                  type: "item.started",
                  itemType: "tool",
                  itemId: id,
                  title: name || "tool",
                  ...toolFields(name, undefined),
                });
              },
            });
            appendNative(threadId, { dir: "in", source: "xai.chat.completions", msg: { text, usage } });
            if (text.trim()) {
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
            }
            if (tool_calls && tool_calls.length > 0) {
              for (const tc of tool_calls) {
                // a step whose arguments never streamed still needs a start,
                // or the completion below settles a row nothing opened
                if (tc.id && !started.has(tc.id)) {
                  started.add(tc.id);
                  emit({
                    ...base(threadId, turnId),
                    type: "item.started",
                    itemType: "tool",
                    itemId: tc.id,
                    title: tc.function.name,
                    ...toolFields(tc.function.name, parseToolArguments(tc.function.arguments)),
                  });
                }
                emit({
                  ...base(threadId, turnId),
                  type: "item.completed",
                  itemType: "tool",
                  itemId: tc.id,
                  ok: true,
                });
              }
            }
            if (usage) {
              emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...usage });
            }
            active.delete(threadId);
            const toolNames = ((tool_calls as any[] | undefined) ?? [])
              .map((tc: any) => tc?.function?.name)
              .filter(Boolean)
              .join(", ");
            emit({
              ...base(threadId, turnId),
              type: "turn.completed",
              ok: true,
              stopReason: toolNames ? `tool_calls: ${toolNames}` : null,
              cost: null,
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
          reason: `no xAI API key — add {"xai":{"key":"xai-…"}} to ~/.botfleet/config.json or set ${config.apiKeyEnv}`,
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
        // no MCP server is mounted anywhere in this file and respondToRequest
        // answers "unavailable", so localComputerMcp would be a knob the
        // driver cannot turn — contracts.ts is explicit that we never show one
        capabilities: { sessionModelSwitch: "in-session" },
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
        const { text } = await complete([{ role: "user", content: prompt }], "grok-3-mini", { stream: false });
        return text;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
