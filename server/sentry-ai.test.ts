import { afterEach, describe, expect, it } from "vitest";
import {
  configureTurnIdentity,
  genAiProvider,
  observeRuntimeEvent,
  recordExecutedTools,
  resetSentryAiForTests,
  type SentryAiSink,
  type SentryBreadcrumb,
  type SentryCaptureContext,
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
  const contexts: Array<SentryCaptureContext | undefined> = [];
  const breadcrumbs: SentryBreadcrumb[] = [];
  const conversations: string[] = [];
  const sink: SentryAiSink = {
    setConversationId: (id) => conversations.push(id),
    startInactiveSpan: (opts) => {
      // SAFETY: the field starts unset and only setStatus ever writes it, so
      // the assertion widens `undefined` to the shape that write produces.
      const emptyStatus = undefined as { code: number; message?: string } | undefined;
      const rec = {
        op: opts.op,
        name: opts.name,
        attributes: { ...opts.attributes },
        ended: false,
        status: emptyStatus,
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
    captureException: (error, context) => {
      exceptions.push(error);
      contexts.push(context);
    },
    addBreadcrumb: (crumb) => breadcrumbs.push(crumb),
  };
  return { sink, spans, exceptions, contexts, breadcrumbs, conversations };
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

describe("failed turns become Issues", () => {
  it("captures exactly one exception, tagged, when a turn ends not ok", () => {
    const { sink, exceptions, contexts, spans } = recordingSink();
    observeRuntimeEvent(base({ type: "turn.started" }), sink);
    observeRuntimeEvent(base({ type: "session.started", sessionId: "s", model: "gpt-test" }), sink);
    observeRuntimeEvent(base({ type: "turn.completed", ok: false, stopReason: "exit code 1" }), sink);

    expect(exceptions).toHaveLength(1);
    expect(String(exceptions[0])).toContain("bot turn failed: exit code 1");
    expect(contexts[0]?.tags).toMatchObject({
      "botfleet.provider": "openai-compat",
      "botfleet.thread.id": "thread-1",
      "gen_ai.provider.name": "openai-compat",
      "gen_ai.request.model": "gpt-test",
    });
    expect(spans[0].status).toEqual({ code: 2, message: "internal_error" });
    expect(spans[0].ended).toBe(true);
  });

  it("captures nothing when a turn ends ok", () => {
    const { sink, exceptions } = recordingSink();
    observeRuntimeEvent(base({ type: "turn.started" }), sink);
    observeRuntimeEvent(base({ type: "turn.completed", ok: true, usage: { input: 1, output: 1 } }), sink);
    expect(exceptions).toHaveLength(0);
  });

  it("says unknown rather than null when the driver reports no stop reason", () => {
    const { sink, exceptions } = recordingSink();
    observeRuntimeEvent(base({ type: "turn.started" }), sink);
    observeRuntimeEvent(base({ type: "turn.completed", ok: false, stopReason: null }), sink);
    expect(String(exceptions[0])).toContain("bot turn failed: unknown");
  });
});

describe("approval, retry, and session lifecycle", () => {
  it("ends the approval span with the decision before the turn completes", () => {
    const { sink, spans } = recordingSink();
    observeRuntimeEvent(base({ type: "turn.started" }), sink);
    observeRuntimeEvent(
      base({
        type: "request.opened",
        requestId: "req-1",
        requestType: "permission",
        tool: "bash",
        summary: "run ls",
      }),
      sink,
    );
    const approval = spans[1];
    expect(approval.op).toBe("gen_ai.execute_tool");
    expect(approval.ended).toBe(false);

    observeRuntimeEvent(
      base({ type: "request.resolved", requestId: "req-1", behavior: "allow", source: "user" }),
      sink,
    );
    expect(approval.attributes["botfleet.approval.behavior"]).toBe("allow");
    expect(approval.attributes["botfleet.approval.source"]).toBe("user");
    expect(approval.ended).toBe(true);

    observeRuntimeEvent(base({ type: "turn.completed", ok: true }), sink);
    expect(spans.every((s) => s.ended)).toBe(true);
  });

  it("records a breadcrumb when a turn is retried", () => {
    const { sink, breadcrumbs, spans } = recordingSink();
    observeRuntimeEvent(base({ type: "turn.started" }), sink);
    observeRuntimeEvent(
      base({ type: "turn.retrying", attempt: 2, delayMs: 1500, reason: "transport reset" }),
      sink,
    );
    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0].message).toBe("turn retrying: transport reset");
    expect(breadcrumbs[0].data).toMatchObject({ attempt: 2, delayMs: 1500 });
    // A retry is not a new span.
    expect(spans).toHaveLength(1);
  });

  it("closes an open turn when the session exits under it", () => {
    const { sink, spans } = recordingSink();
    observeRuntimeEvent(base({ type: "turn.started" }), sink);
    observeRuntimeEvent(
      base({ type: "item.started", itemType: "tool", itemId: "tool-1", title: "bash ls" }),
      sink,
    );
    observeRuntimeEvent(base({ type: "session.exited", reason: "cli exited" }), sink);
    expect(spans.every((s) => s.ended)).toBe(true);
    expect(spans[0].status).toEqual({ code: 2, message: "internal_error" });
  });

  it("attaches a failed tool's detail, clipped, and never its arguments", () => {
    const { sink, spans } = recordingSink();
    observeRuntimeEvent(base({ type: "turn.started" }), sink);
    observeRuntimeEvent(
      base({ type: "item.started", itemType: "tool", itemId: "tool-1", title: "bash ls" }),
      sink,
    );
    observeRuntimeEvent(
      base({
        type: "item.completed",
        itemType: "tool",
        itemId: "tool-1",
        ok: false,
        detail: "x".repeat(500),
        arguments: '{"password":"sk-secret"}',
      }),
      sink,
    );
    const detail = spans[1].attributes["gen_ai.tool.result.detail"];
    expect(detail).toEqual(expect.any(String));
    expect(String(detail)).toHaveLength(200);
    expect(spans[1].status).toEqual({ code: 2, message: "internal_error" });
    expect(JSON.stringify(spans)).not.toMatch(/sk-|password|BEGIN /);
  });

  it("leaves a successful tool without a result detail", () => {
    const { sink, spans } = recordingSink();
    observeRuntimeEvent(base({ type: "turn.started" }), sink);
    observeRuntimeEvent(
      base({ type: "item.started", itemType: "tool", itemId: "tool-1", title: "bash ls" }),
      sink,
    );
    observeRuntimeEvent(
      base({ type: "item.completed", itemType: "tool", itemId: "tool-1", ok: true, detail: "3 rows" }),
      sink,
    );
    expect(spans[1].attributes["gen_ai.tool.result.detail"]).toBeUndefined();
  });
});

describe("bot and room identity", () => {
  it("stamps every span, and tags the failure, when a resolver is installed", () => {
    const { sink, spans, contexts } = recordingSink();
    configureTurnIdentity(() => ({
      botId: "bot-7",
      botName: "Scout",
      instanceId: "claudeAgent",
      model: "sonnet-test",
      roomId: "room-3",
      roomName: "Standup",
    }));

    observeRuntimeEvent(base({ type: "turn.started" }), sink);
    observeRuntimeEvent(
      base({ type: "item.started", itemType: "tool", itemId: "tool-1", title: "bash ls" }),
      sink,
    );
    observeRuntimeEvent(
      base({
        type: "request.opened",
        requestId: "req-1",
        requestType: "permission",
        tool: "bash",
        summary: "run ls",
      }),
      sink,
    );
    recordExecutedTools("thread-1", ["read_file"], sink);
    observeRuntimeEvent(base({ type: "turn.completed", ok: false, stopReason: "boom" }), sink);

    expect(spans).toHaveLength(4);
    for (const span of spans) {
      expect(span.attributes["botfleet.bot.id"]).toBe("bot-7");
      expect(span.attributes["botfleet.bot.name"]).toBe("Scout");
      expect(span.attributes["botfleet.instance.id"]).toBe("claudeAgent");
      expect(span.attributes["botfleet.room.id"]).toBe("room-3");
      expect(span.attributes["botfleet.room.name"]).toBe("Standup");
      expect(span.attributes["gen_ai.agent.name"]).toBe("Scout");
    }
    expect(spans[0].attributes["gen_ai.request.model"]).toBe("sonnet-test");
    expect(contexts[0]?.tags).toMatchObject({
      "botfleet.bot.id": "bot-7",
      "botfleet.room.id": "room-3",
      "gen_ai.request.model": "sonnet-test",
    });
  });

  it("stamps a chat span too", async () => {
    const { sink, spans } = recordingSink();
    configureTurnIdentity(() => ({ botId: "bot-7", botName: "Scout" }));
    await withChatSpan(
      { model: "llama-test", conversationId: "thread-1", provider: "openrouter" },
      async () => ({ text: "ok", usage: { input: 1, output: 1 } }),
      sink,
    );
    expect(spans[0].attributes["botfleet.bot.id"]).toBe("bot-7");
    expect(spans[0].attributes["gen_ai.agent.name"]).toBe("Scout");
    expect(spans[0].attributes["gen_ai.provider.name"]).toBe("openrouter");
  });

  it("writes no botfleet attribute at all without a resolver", () => {
    const { sink, spans } = recordingSink();
    observeRuntimeEvent(base({ type: "turn.started" }), sink);
    expect(Object.keys(spans[0].attributes).sort()).toEqual([
      "gen_ai.agent.name",
      "gen_ai.conversation.id",
      "gen_ai.operation.name",
      "gen_ai.provider.name",
      "gen_ai.system",
    ]);
    expect(spans[0].attributes["gen_ai.agent.name"]).toBe("openai-compat");
    expect(Object.values(spans[0].attributes).some((value) => value === "")).toBe(false);
  });

  it("skips blank identity fields rather than writing empty attributes", () => {
    const { sink, spans } = recordingSink();
    configureTurnIdentity(() => ({ botId: "bot-7", botName: "   ", roomId: "" }));
    observeRuntimeEvent(base({ type: "turn.started" }), sink);
    expect(spans[0].attributes["botfleet.bot.id"]).toBe("bot-7");
    expect(spans[0].attributes).not.toHaveProperty("botfleet.bot.name");
    expect(spans[0].attributes).not.toHaveProperty("botfleet.room.id");
    // Falls back to the driver kind when the bot has no usable display name.
    expect(spans[0].attributes["gen_ai.agent.name"]).toBe("openai-compat");
    expect(Object.values(spans[0].attributes).some((value) => value === "")).toBe(false);
  });

  it("survives a resolver that throws", () => {
    const { sink, spans } = recordingSink();
    configureTurnIdentity(() => {
      throw new Error("store went away");
    });
    observeRuntimeEvent(base({ type: "turn.started" }), sink);
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["gen_ai.agent.name"]).toBe("openai-compat");
  });
});

describe("Sentry provider vocabulary", () => {
  it("keeps OpenAI-compatible endpoints out of the OpenAI bucket", () => {
    expect(genAiProvider("openai-compat")).not.toBe("openai");
    expect(genAiProvider("openai-compat")).toBe("openai-compat");
    expect(genAiProvider("codex")).toBe("openai");
  });

  it("maps every shipped driver kind to Sentry's name", () => {
    expect(genAiProvider("claudeAgent")).toBe("anthropic");
    expect(genAiProvider("grokAgent")).toBe("x_ai");
    expect(genAiProvider("grok")).toBe("x_ai");
    expect(genAiProvider("antigravityAgent")).toBe("gcp.gemini");
    expect(genAiProvider("deepseekAgent")).toBe("deepseek");
    expect(genAiProvider("dshAgent")).toBe("deepseek");
    expect(genAiProvider("kimiAgent")).toBe("moonshot");
    expect(genAiProvider("cursorAgent")).toBe("cursor");
    expect(genAiProvider("minimax")).toBe("minimax");
    expect(genAiProvider("boxAgent")).toBe("box");
  });

  it("keeps an engine Sentry has no name for as its own kind", () => {
    expect(genAiProvider("opencodeGo")).toBe("opencodeGo");
    expect(genAiProvider("")).toBe("custom");
  });
});
