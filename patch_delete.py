with open("server/index.ts", "r") as f:
    text = f.read()

old_logic = """            const failedIndex = activeMsgs.findIndex(m => m.id === lastUserMessage!.id) + 1;
            const toDelete = activeMsgs.slice(failedIndex).map(m => m.id);
            for (const id of toDelete) {
               store.deleteMessage(event.threadId, id);
            }"""

new_logic = """            // We cannot easily delete the failed chips here, so they remain as a record of the failure.
            // The fallback model will simply continue from the same userMessage."""

text = text.replace(old_logic, new_logic)

with open("server/index.ts", "w") as f:
    f.write(text)
