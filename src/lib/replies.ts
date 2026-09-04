import type { Message } from "@/state/store";

export function replySnippet(text: string, limit = 160): string {
  const clean = text
    .replace(/<attached-image\s+path="[^"]*"\s*\/>/g, "[image]")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
export function replyAuthor(message: Message, fallback = "Assistant"): string {
  // a peer bot's ask_bot reply is also `role: "user"` (it aligns right like
  // any other user-role message) — "You" is only for what the human typed
  return message.role === "user" && !message.from?.botId ? "You" : (message.from?.name ?? fallback);
}
