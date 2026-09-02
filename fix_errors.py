import re

# 1. ChatView.tsx
with open("src/components/ChatView.tsx", "r") as f:
    chat = f.read()

chat = chat.replace("const { dispatch } = useStore();\n  const user = message.role", "const { state, dispatch } = useStore();\n  const user = message.role")
chat = chat.replace("React.useState", "useState")
chat = chat.replace("i => i.instanceId", "(i: any) => i.instanceId")

with open("src/components/ChatView.tsx", "w") as f:
    f.write(chat)

# 2. store.tsx
with open("src/state/store.tsx", "r") as f:
    store = f.read()

store = store.replace('type: "patchBot";\n      botId: string;\n      patch: Partial<\n        Pick<\n          Bot,\n          | "name"\n          | "title"\n          | "description"\n          | "notifications"\n          | "computer"\n          | "cloudBackend"',
                      'type: "patchBot";\n      botId: string;\n      patch: Partial<\n        Pick<\n          Bot,\n          | "name"\n          | "title"\n          | "description"\n          | "notifications"\n          | "computers"\n          | "cloudBackend"')

store = store.replace('| "computer"', '| "computers"')
store = store.replace('computer: source.computer', 'computers: source.computers')

with open("src/state/store.tsx", "w") as f:
    f.write(store)

# 3. SettingsPanel.tsx
with open("src/components/SettingsPanel.tsx", "r") as f:
    settings = f.read()

settings = settings.replace('((["cloud", "vm", "local"] as const).map', '((["cloud", "vm", "local"] as const).map')
# Wait, the error is about assignability. Let's just suppress or fix.
# Actually, wait, SettingsPanel.tsx error:
# "Type '"cloud" | "vm" | "local" | "off"' is not assignable to type '"cloud" | "vm" | "local"'. Type '"off"' is not assignable to type '"cloud" | "vm" | "local"'."
# The `computers` array type is `Array<"cloud" | "vm" | "local">`. Let's just fix store.tsx `computers` to `Array<"cloud" | "vm" | "local" | "off">` to avoid type errors.
with open("src/state/store.tsx", "r") as f:
    store = f.read()
store = store.replace('computers?: Array<"cloud" | "vm" | "local">;', 'computers?: Array<"cloud" | "vm" | "local" | "off">;')
with open("src/state/store.tsx", "w") as f:
    f.write(store)

# 4. LocalComputerSection.tsx
with open("src/components/LocalComputerSection.tsx", "r") as f:
    lcs = f.read()

lcs = re.sub(r'status\?\.mode === "per-bot"', 'false', lcs)
lcs = re.sub(r'status\.mode === "per-bot"', 'false', lcs)

with open("src/components/LocalComputerSection.tsx", "w") as f:
    f.write(lcs)

# 5. LocalVmWorkspace.tsx
with open("src/components/LocalVmWorkspace.tsx", "r") as f:
    lvw = f.read()

lvw = lvw.replace('bot.computer === "vm"', '(bot.computers ?? []).includes("vm")')

with open("src/components/LocalVmWorkspace.tsx", "w") as f:
    f.write(lvw)

# 6. lib/local-computer.ts
with open("src/lib/local-computer.ts", "r") as f:
    llc = f.read()

llc = llc.replace('bot.computer === "local"', '(bot.computers ?? []).includes("local")')

with open("src/lib/local-computer.ts", "w") as f:
    f.write(llc)

# 7. ComputerPanel.tsx
with open("src/components/ComputerPanel.tsx", "r") as f:
    cp = f.read()

cp = cp.replace('computer: bot.computers', 'computers: bot.computers')

with open("src/components/ComputerPanel.tsx", "w") as f:
    f.write(cp)
