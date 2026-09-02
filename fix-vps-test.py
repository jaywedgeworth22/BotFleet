import re

with open("server/vps-routing.test.ts", "r") as f:
    text = f.read()

old = """      await until(async () => {
        snapshot = await botById(bot.id);
        return (
          snapshot?.busy === false &&
          snapshot.messages.some((m: any) => m.kind === "text" && m.text?.startsWith("echo: "))
        );
      }, "the echoed turn");"""
new = """      await until(async () => {
        snapshot = await botById(bot.id);
        if (!snapshot?.busy) console.log("SNAPSHOT_DEBUG:", snapshot.messages);
        return (
          snapshot?.busy === false &&
          snapshot.messages.some((m: any) => m.kind === "text" && m.text?.startsWith("echo: "))
        );
      }, "the echoed turn");"""
text = text.replace(old, new)
with open("server/vps-routing.test.ts", "w") as f:
    f.write(text)
