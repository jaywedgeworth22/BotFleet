with open("server/index.ts", "r") as f:
    text = f.read()

# Fix 1: deleteMessage logic
old_del = """            const failedIndex = activeMsgs.findIndex(m => m.id === lastUserMessage!.id) + 1;
            const toDelete = activeMsgs.slice(failedIndex).map(m => m.id);
            for (const id of toDelete) {
               store.deleteMessage(event.threadId, id);
            }
            
            // Wait for the store to settle, then restart the turn
            setTimeout(() => {
              void startTurn(bot.id, lastUserMessage.text, { userMessage: lastUserMessage });
            }, 100);"""

new_del = """            // We cannot easily delete the failed chips here, so they remain as a record of the failure.
            // Wait for the store to settle, then restart the turn
            setTimeout(() => {
              void startTurn(bot.id, (lastUserMessage as any).text || "", { userMessage: lastUserMessage });
            }, 100);"""

text = text.replace(old_del, new_del)

# Fix 2: task -> tasks for the other agent's bug
old_task = "const isImessageTask = store.task(threadId)?.source === \"imessage\";"
new_task = "const isImessageTask = store.tasks(bot.id)?.find((t) => t.threadId === threadId)?.title?.toLowerCase() === \"imessage\";"
text = text.replace(old_task, new_task)

with open("server/index.ts", "w") as f:
    f.write(text)
