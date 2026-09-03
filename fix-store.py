import re

with open("server/store.ts", "r") as f:
    text = f.read()

# Replace the catch block in the constructor
old_catch = """    try {
      this.bots = JSON.parse(readFileSync(BOTS_FILE, "utf8"));
    } catch {
      const initialThreadId = newId();
      this.bots = [
        {
          id: newId(),
          threadId: initialThreadId,
          name: "Director",
          title: "Chief of Staff",
          description: "Chief of staff for the BotFleet roster. Route work, manage other bots, and coordinate fleet-wide tasks.",
          notifications: true,
          color: "blue",
          mascotExpression: "focused",
          unread: false,
          modelSelection: this.defaultSelection(),
          resumeCursors: {},
          autoApprove: false,
          tasks: [
            {
              id: newId(),
              threadId: initialThreadId,
              summary: "Inbox",
              active: true,
              updatedAt: Date.now(),
            },
          ],
          createdAt: Date.now(),
        },
      ];
      // Save it immediately so it persists
      writeFileAtomic(BOTS_FILE, JSON.stringify(this.bots, null, 2));
    }"""
new_catch = """    try {
      this.bots = JSON.parse(readFileSync(BOTS_FILE, "utf8"));
    } catch {
      this.bots = [];
    }"""
text = text.replace(old_catch, new_catch)

# Replace seedIfEmpty
old_seed = """  seedIfEmpty() {
    console.log("SEEDING?", this.bots.length); 
    if (this.bots.length) return;
    this.createBot();
  }"""
new_seed = """  seedIfEmpty() {
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
  }"""
text = text.replace(old_seed, new_seed)

with open("server/store.ts", "w") as f:
    f.write(text)
