// Outbound Linq delivery for completed bot turns.
//
// The Mac relay polls messages.db for `[to iMessage]` replies.  Linq has no
// local chat.db, so the harness must push those tagged replies through the
// partner API.  We reuse `outboundImessageText` — the same gate the relay
// uses — and keep chatId correlation here so dispatch/index stay thin.

import { outboundImessageText } from "../../shared/imessage-message.ts";
import { linqSendMessage, linqStopTyping } from "./client.ts";
import { loadConfig } from "../config.ts";

interface LinqChatBinding {
  chatId: string;
  botId: string;
}

/** threadId → active Linq chat.  Set on inbound; cleared after release. */
const chatByThread = new Map<string, LinqChatBinding>();

export function rememberLinqChat(threadId: string, botId: string, chatId: string): void {
  chatByThread.set(threadId, { chatId, botId });
}

export function peekLinqChat(threadId: string): LinqChatBinding | undefined {
  return chatByThread.get(threadId);
}

export function releaseLinqChat(threadId: string): void {
  chatByThread.delete(threadId);
}

/** Stop the typing indicator for a remembered chat (best-effort). */
export async function stopLinqTypingForThread(threadId: string): Promise<void> {
  const binding = chatByThread.get(threadId);
  if (!binding) return;
  try {
    await linqStopTyping(binding.chatId);
  } catch {
    /* typing is advisory */
  }
}

/** If this bot text is a `[to iMessage]` reply for a Linq-origin thread,
 *  send it through the partner API. */
export async function deliverLinqOutboundIfNeeded(
  threadId: string,
  botId: string,
  text: string,
): Promise<{ sent: boolean; reason?: string }> {
  const binding = chatByThread.get(threadId);
  if (!binding || binding.botId !== botId) {
    return { sent: false, reason: "no_linq_chat" };
  }
  const cfg = loadConfig();
  if (cfg.botDefaults?.imessagePerBot?.[botId] !== "linq") {
    return { sent: false, reason: "bot_not_linq" };
  }
  const outbound = outboundImessageText(text);
  if (!outbound) return { sent: false, reason: "not_tagged" };
  try {
    await linqSendMessage(binding.chatId, { text: outbound });
    await linqStopTyping(binding.chatId).catch(() => undefined);
    return { sent: true };
  } catch (err) {
    await linqStopTyping(binding.chatId).catch(() => undefined);
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "send_failed",
    };
  }
}
