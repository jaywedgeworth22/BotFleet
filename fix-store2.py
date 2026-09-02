import re

with open("server/store.ts", "r") as f:
    text = f.read()

text = re.sub(r'  seedIfEmpty\(\) \{[\s\S]*?  \}', """  seedIfEmpty() {
    if (this.bots.length) return;
    const bot = this.createBot({
      name: "Director",
      title: "Chief of Staff",
      description: "Chief of staff for the BotFleet roster. Route work, manage other bots, and coordinate fleet-wide tasks.",
      color: "blue",
      mascotExpression: "focused"
    });
    bot.autoApprove = false;
    bot.tasks[0].title = "Inbox";
    this.saveBots();
  }""", text)

with open("server/store.ts", "w") as f:
    f.write(text)
