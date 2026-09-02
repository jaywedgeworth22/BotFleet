import re

with open('server/index.ts', 'r') as f:
    content = f.read()

# Locate the fallback block
old_block = """        if (event.ok) fallbackAttemptByTurn.delete(fallbackKey);
        if (
          !event.ok &&
          event.stopReason !== "interrupted" &&
          event.stopReason !== "cancelled" &&
          bot.modelSelection.fallbacks?.length
        ) {
          const activeMsgs = store.activePath(event.threadId);
          let lastUserIdx = -1;
          for (let i = activeMsgs.length - 1; i >= 0; i--) {
            if (activeMsgs[i].role === "user" && activeMsgs[i].kind === "text") {
              lastUserIdx = i;
              fallbackUserMessage = activeMsgs[i];
              break;
            }
          }
          const produced =
            lastUserIdx >= 0 &&
            activeMsgs.slice(lastUserIdx + 1).some(
              (message) => message.role === "bot" && (message.kind === "text" || (message.kind === "activity" && message.tool?.ok !== false)),
            );"""

new_block = """        const activeMsgs = store.activePath(event.threadId);
        let lastUserIdx = -1;
        for (let i = activeMsgs.length - 1; i >= 0; i--) {
          if (activeMsgs[i].role === "user" && activeMsgs[i].kind === "text") {
            lastUserIdx = i;
            fallbackUserMessage = activeMsgs[i];
            break;
          }
        }

        let isTextError = false;
        if (lastUserIdx >= 0) {
          const botReplies = activeMsgs.slice(lastUserIdx + 1).filter(m => m.role === "bot" && m.kind === "text" && typeof m.text === "string");
          if (botReplies.length === 1) {
            const txt = botReplies[0].text!.trim();
            if (
               /session limit|rate.?limit|too many requests|overloaded|capacity|internal server error|bad gateway|service unavailable|account_inactive/i.test(txt) &&
               txt.length < 300
            ) {
               isTextError = true;
            }
          }
        }

        const isOk = event.ok && !isTextError;

        if (isOk) fallbackAttemptByTurn.delete(fallbackKey);
        if (
          !isOk &&
          event.stopReason !== "interrupted" &&
          event.stopReason !== "cancelled" &&
          bot.modelSelection.fallbacks?.length
        ) {
          const produced =
            lastUserIdx >= 0 &&
            activeMsgs.slice(lastUserIdx + 1).some(
              (message) => message.role === "bot" && ((message.kind === "text" && !isTextError) || (message.kind === "activity" && message.tool?.ok !== false)),
            );"""

content = content.replace(old_block, new_block)

with open('server/index.ts', 'w') as f:
    f.write(content)

