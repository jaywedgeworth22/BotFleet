const fs = require('fs');
let code = fs.readFileSync('server/store.ts', 'utf8');
code = code.replace(
  '    } catch {\n      this.bots = [];\n    }',
  `    } catch {
      const { newId } = require("../shared/id.ts");
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
      const { writeFileAtomic } = require("./atomic.ts");
      writeFileAtomic(require("./paths.ts").BOTS_FILE, JSON.stringify(this.bots, null, 2));
    }`
);
fs.writeFileSync('server/store.ts', code);
