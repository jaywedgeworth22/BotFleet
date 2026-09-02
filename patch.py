import sys

with open('server/store.ts', 'r') as f:
    code = f.read()

replacement = """    } catch {
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

old_str = """    } catch {
      this.bots = [];
    }"""

if old_str in code:
    with open('server/store.ts', 'w') as f:
        f.write(code.replace(old_str, replacement))
    print("Patched!")
else:
    print("Could not find exact catch block to replace")
