import { afterEach, describe, expect, it } from "vitest";
import {
  observeRuntimeEvent,
  recordExecutedTools,
  resetSentryAiForTests,
  type SentryAiSink,
  withChatSpan,
} from "./sentry-ai.ts";
import type { RuntimeEvent } from "./contracts.ts";

function base(over: Partial<RuntimeEvent> & Pick<RuntimeEvent, "type">): RuntimeEvent {
  const event = {
    eventId: "e1",
    provider: "openai-compat",
    threadId: "thread-1",
    turnId: "turn-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
  // SAFETY: tests assemble a RuntimeEvent from the required base plus one typed variant.
  return event as RuntimeEvent;
}

function recordingSink() {
  const spans: Array<{
    op: string;
    name: string;
    attributes: Record<string, string | number | boolean>;
    ended: boolean;
    status?: { code: number; message?: string };
  }> = [];
  const exceptions: unknown[] = [];
  const conversations: string[] = [];
  const sink: SentryAiSink = {
    setConversationId: (id) => conversations.push(id),
    startInactiveSpan: (opts) => {
      const rec = {
        op: opts.op,
        name: opts.name,
        attributes: { ...opts.attributes },
        ended: false,
        status: undefined as { code: number; message?: string } | undefined,
      };
      spans.push(rec);
      return {
        setAttribute: (key, value) => {
          rec.attributes[key] = value;
        },
        setStatus: (status) => {
          rec.status = status;
        },
        end: () => {
          rec.ended = true;
        },
      };
    },
    captureException: (error) => {
      exceptions.push(error);
    },
  };
  return { sink, spans, exceptions, conversations };
}

afterEach(() => {
  resetSentryAiForTests();
});

describe("Sentry AI observability", () => {
  it("is a no-op without a sink so tests never talk to Sentry", () => {
    observeRuntimeEvent(base({ type: "turn.started" }), null);
    recordExecutedTools("thread-1", ["bash"], null);
  });

  it("opens an invoke_agent span, tags the conversation, model, tokens, and tools", () => {
    const { sink, spans, conversations } = recordingSink();
    observeRuntimeEvent(base({ type: "turn.started" }), sink);
    observeRuntimeEvent(base({ type: "session.started", sessionId: "s", model: "gpt-test" }), sink);
    observeRuntimeEvent(
      base({ type: "item.started", itemType: "tool", itemId: "tool-1", title: "bash ls" }),
      sink,
    );
    observeRuntimeEvent(base({ type: "item.completed", itemType: "tool", itemId: "tool-1", ok: true }), sink);
    observeRuntimeEvent(base({ type: "thread.token-usage.updated", input: 11, output: 7 }), sink);
    observeRuntimeEvent(base({ type: "turn.completed", ok: true, usage: { input: 11, output: 7 } }), sink);

    expect(conversations[0]).toBe("thread-1");
    expect(spans.map((s) => s.op)).toEqual(["gen_ai.invoke_agent", "gen_ai.execute_tool"]);
    expect(spans[0].attributes["gen_ai.conversation.id"]).toBe("thread-1");
    expect(spans[0].attributes["gen_ai.request.model"]).toBe("gpt-test");
    expect(spans[0].attributes["gen_ai.usage.input_tokens"]).toBe(11);
    expect(spans[0].attributes["gen_ai.usage.output_tokens"]).toBe(7);
    expect(spans[1].attributes["gen_ai.tool.name"]).toBe("bash");
    expect(spans.every((s) => s.ended)).toBe(true);
  });

  it("captures runtime errors without attaching prompt text", () => {
    const { sink, exceptions, spans } = recordingSink();
    observeRuntimeEvent(base({ type: "runtime.error", message: "upstream HTTP 500" }), sink);
    expect(exceptions).toHaveLength(1);
    expect(String(exceptions[0])).toContain("upstream HTTP 500");
    expect(JSON.stringify(spans)).not.toMatch(/sk-|password|BEGIN /);
  });

  it("records API-backed tool names and chat tokens without messages", async () => {
    const { sink, spans } = recordingSink();
    recordExecutedTools("thread-9", ["read_file", "write_file"], sink);
    expect(spans.map((s) => s.attributes["gen_ai.tool.name"])).toEqual(["read_file", "write_file"]);
    expect(spans.every((s) => s.ended)).toBe(true);

    const result = await withChatSpan(
      { model: "llama-test", conversationId: "thread-9", provider: "openai" },
      async () => ({ text: "ok", usage: { input: 3, output: 1 } }),
      sink,
    );
    expect(result.text).toBe("ok");
    const chat = spans.find((s) => s.op === "gen_ai.chat");
    expect(chat?.attributes["gen_ai.request.model"]).toBe("llama-test");
    expect(chat?.attributes["gen_ai.usage.input_tokens"]).toBe(3);
    expect(chat?.attributes["gen_ai.conversation.id"]).toBe("thread-9");
    expect(JSON.stringify(spans)).not.toMatch(/prompt|messages|sk-/);
  });
});
