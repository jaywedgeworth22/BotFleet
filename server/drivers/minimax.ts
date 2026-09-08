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
import { toolFields } from "../tool-fields.ts";
import { runTurnLoop, type ChatMessage, type TurnLoopDeps } from "./chat-completions/loop.ts";

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
    // Held for the WHOLE turn — every round and every tool call — and dropped
    // only by the loop's finally.  That is what makes Stop work between
    // rounds and mid-tool, where it used to be a silent no-op.
    const active = new Map<string, { abort: AbortController; turnId: string; startedAt: number }>();

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
      // When the caller supplies a signal it already carries the request
      // deadline (the turn loop arms one per round).  A second timer here
      // would race it and make a timeout indistinguishable from a provider
      // error at the point where the loop has to name the exit.  Callers
      // with no signal — generateText for titles and summaries — keep the
      // driver's own 180s ceiling.
      const signal = opts.signal ?? AbortSignal.timeout(180_000);
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
      const { threadId } = turn;
      // Validation throws SYNCHRONOUSLY out of sendTurn, before the loop
      // exists, so startTurn's catch runs in milliseconds exactly as it does
      // for a CLI driver — error chip, watchdog settled, bot idle, all three
      // queue drains.  A rejection here must never become a resolved turn
      // that nothing ever settles.
      if (!apiKey) throw new Error(`no MiniMax key — set ${API_KEY_ENV} or run mmx auth login --api-key …`);
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");

      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId, startedAt: Date.now() });
      const model = turn.model || models.default;
      // Round 1's prefix.  The loop owns this array from here and only ever
      // APPENDS to it, so rounds 2..N re-send a byte-identical prefix.
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
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model });

      // Tool ids this turn has already opened a step for.  The stream
      // announces a call once and then keeps sending argument fragments for
      // it, and the settled reply repeats every call — without this a single
      // tool would open a dozen rows.  Shared with the loop so a call the
      // stream announced is not announced again when the round settles.
      const started = new Set<string>();

      const runRound: TurnLoopDeps["runRound"] = async (roundMessages, opts) => {
        appendNative(threadId, {
          dir: "out",
          source: "minimax.chat.completions",
          msg: { model, messageCount: roundMessages.length, round: opts.round },
        });
        const { text, usage, tool_calls } = await complete(roundMessages, model, {
          stream: true,
          tools: openAiTools,
          signal: opts.signal,
          onDelta: (delta) =>
            emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta }),
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
        });
        appendNative(threadId, {
          dir: "in",
          source: "minimax.chat.completions",
          msg: { textLength: text.length, usage, round: opts.round, toolCalls: tool_calls?.length ?? 0 },
        });
        return { text, usage, toolCalls: tool_calls };
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
        onSettled: () => active.delete(threadId),
      });

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
        // toolLoop: this driver runs the harness tool loop inside sendTurn and
        // emits exactly one turn.started / turn.completed pair per user turn,
        // the way every CLI driver does — so the harness hands it a toolHost
        // and dispatches it on the same one line it uses for Claude.
        capabilities: { sessionModelSwitch: "in-session", agentsMcp: true, toolLoop: true },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        // Insurance the single try/finally should make unreachable: if this
        // ever returns a thread, the loop leaked one, and that is worth
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
