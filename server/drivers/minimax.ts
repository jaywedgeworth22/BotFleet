// MiniMax driver — OpenAI-compatible chat/completions API with SSE streaming.
// Reads an API key from an instance, the environment, or the official
// mmx-cli config at ~/.mmx/config.json.
//
// API: https://api.minimax.io/v1/chat/completions
// Models: https://platform.minimax.io/docs/guides/models-intro

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

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

const DRIVER_KIND = "minimax";
const API_KEY_ENV = "MINIMAX_API_KEY";
const DEFAULT_URL = "https://api.minimax.io/v1";
const CN_URL = "https://api.minimaxi.com/v1";

const MODELS: ModelCatalog = {
  default: "MiniMax-M3",
  options: [
    { id: "MiniMax-M3", label: "MiniMax M3", contextWindow: 1_000_000 },
    { id: "MiniMax-M2.7", label: "MiniMax M2.7", contextWindow: 204_800 },
    { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed", contextWindow: 204_800 },
  ],
};

export interface MinimaxConfig {
  url: string;
}

interface LocalMiniMaxConfig {
  apiKey: string;
  url: string;
  defaultModel: string;
}

const localConfigSchema = z.object({
  api_key: z.string().optional(),
  region: z.enum(["global", "cn"]).optional(),
  base_url: z.string().optional(),
  default_text_model: z.string().optional(),
});

const driverConfigSchema = z.object({
  url: z.string().optional(),
});

function normalizedApiUrl(value: string): string {
  const root = value.trim().replace(/\/+$/, "");
  return root.endsWith("/v1") ? root : `${root}/v1`;
}

export function loadLocalMiniMaxConfig(home = homedir()): LocalMiniMaxConfig {
  try {
    const raw = localConfigSchema.parse(JSON.parse(readFileSync(join(home, ".mmx", "config.json"), "utf8")));
    const region = raw.region === "cn" ? "cn" : "global";
    const configuredUrl = raw.base_url?.trim()
      ? raw.base_url
      : region === "cn" ? CN_URL : DEFAULT_URL;
    return {
      apiKey: raw.api_key?.trim() ?? "",
      url: normalizedApiUrl(configuredUrl),
      defaultModel: raw.default_text_model?.trim() ?? "",
    };
  } catch {
    return { apiKey: "", url: DEFAULT_URL, defaultModel: "" };
  }
}

// ProviderDriver supplies untrusted config as unknown; the schema below is
// the I/O boundary that converts it to the driver's concrete contract.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function decodeMinimaxConfig(raw: unknown): MinimaxConfig {
  const parsed = driverConfigSchema.safeParse(raw ?? {});
  const config = parsed.success ? parsed.data : {};
  const envUrl = process.env.MINIMAX_BASE_URL?.trim();
  return {
    url: normalizedApiUrl(config.url?.trim() || envUrl || DEFAULT_URL),
  };
}

export const MinimaxDriver: ProviderDriver<MinimaxConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "MiniMax CLI", supportsMultipleInstances: true },
  models: MODELS,
  install: {
    docsUrl: "https://platform.minimax.io/docs/token-plan/minimax-cli",
    command: {
      darwin: "npm install -g mmx-cli",
      linux: "npm install -g mmx-cli",
      win32: "npm install -g mmx-cli",
    },
    signInCommand: "mmx auth login --api-key YOUR_MINIMAX_API_KEY",
    needsNode: true,
  },
  decodeConfig: decodeMinimaxConfig,
  defaultConfig: () => decodeMinimaxConfig({}),

  async create(input: DriverCreateInput<MinimaxConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;

    const local = loadLocalMiniMaxConfig();
    // Resolution order: instance env → process env → official mmx-cli config.
    // Empty higher-priority values are skipped instead of masking a real key.
    const apiKey =
      input.environment[API_KEY_ENV]?.trim() ||
      process.env[API_KEY_ENV]?.trim() ||
      local.apiKey;
    const apiUrl = config.url === DEFAULT_URL && local.url !== DEFAULT_URL ? local.url : config.url;
    const models = local.defaultModel && MODELS.options.some((model) => model.id === local.defaultModel)
      ? { ...MODELS, default: local.defaultModel }
      : MODELS;

    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();

    const emit = (event: RuntimeEvent) => {
      for (const l of listeners) l(event);
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
      const timeout = AbortSignal.timeout(180_000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      const body = {
        model,
        messages,
        stream: opts.stream,
        reasoning_split: true,
        stream_options: opts.stream ? { include_usage: true } : undefined,
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      };
      const res = await fetch(`${apiUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`MiniMax HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
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

      // SSE streaming — identical to grok.ts pattern
      let text = "";
      let usage: { input: number; output: number } | null = null;
      const streamToolCalls: any[] = [];
      if (!res.body) throw new Error("MiniMax returned no response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        readLoop: for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") break readLoop;
            let chunk: any;
            try { chunk = JSON.parse(data); } catch { continue; }
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) { text += delta; opts.onDelta?.(delta); }
            const toolCalls = chunk.choices?.[0]?.delta?.tool_calls;
            if (toolCalls && Array.isArray(toolCalls)) {
              for (const tc of toolCalls) {
                const index = tc.index ?? 0;
                if (!streamToolCalls[index]) {
                  streamToolCalls[index] = { id: tc.id ?? "", type: "function", function: { name: tc.function?.name ?? "", arguments: "" } };
                }
                if (tc.id) streamToolCalls[index].id = tc.id;
                if (tc.function?.name) streamToolCalls[index].function.name = tc.function.name;
                if (tc.function?.arguments) streamToolCalls[index].function.arguments += tc.function.arguments;
                opts.onToolCallDelta?.(index, streamToolCalls[index].id, tc.function?.name, tc.function?.arguments);
              }
            }
            if (chunk.usage) {
              usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
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
      if (!apiKey) throw new Error(`no MiniMax key — set ${API_KEY_ENV} or run mmx auth login --api-key …`);
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");

      const turnId = newId();
      const abort = new AbortController();
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

      appendNative(threadId, {
        dir: "out",
        source: "minimax.chat.completions",
        msg: { model: turn.model ?? models.default, messageCount: messages.length },
      });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? models.default });

      // Tool ids this turn has already opened a step for.  The stream
      // announces a call once and then keeps sending argument fragments for
      // it, and the settled reply repeats every call — without this a single
      // tool would open a dozen rows.
      const started = new Set<string>();

      (async () => {
        try {
          const { text, usage, tool_calls } = await complete(messages, turn.model || models.default, {
            stream: true,
            tools: openAiTools,
            signal: abort.signal,
            onDelta: (delta) =>
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta }),
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

          appendNative(threadId, {
            dir: "in",
            source: "minimax.chat.completions",
            msg: { textLength: text.length, usage },
          });

          if (text.trim()) {
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
            }
            if (tool_calls && tool_calls.length > 0) {
              for (const tc of tool_calls) {
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
          const completed: RuntimeEvent = {
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: true,
            stopReason: toolNames ? `tool_calls: ${toolNames}` : null,
            cost: null,
          };
          emit(usage ? { ...completed, usage } : completed);
        } catch (e) {
          active.delete(threadId);
          const error = e instanceof Error ? e : new Error(String(e));
          const aborted = error.name === "AbortError";
          if (!aborted) {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: error.message });
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
          reason: `no MiniMax API key — run mmx auth login --api-key … or set ${API_KEY_ENV}`,
        };
      }
      return { state: "available", authenticated: true, version: null, billing: "metered" };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        // no MCP server is mounted in this file and respondToRequest answers
        // "unavailable": localComputerMcp would be a knob nothing can turn
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async (): Promise<"unavailable"> => "unavailable",
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => { for (const { abort } of active.values()) abort.abort(); },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt: string) => {
        const { text } = await complete([{ role: "user", content: prompt }], models.default, { stream: false });
        return text;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
