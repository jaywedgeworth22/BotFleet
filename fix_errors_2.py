import re

# 1. src/App.tsx
with open("src/App.tsx", "r") as f:
    app = f.read()

app = app.replace('computer: bot.computer', 'computers: bot.computers ?? []')
app = app.replace('computer: bot.computers', 'computers: bot.computers ?? []')

with open("src/App.tsx", "w") as f:
    f.write(app)

# 2. src/components/ComputerPanel.tsx
with open("src/components/ComputerPanel.tsx", "r") as f:
    cp = f.read()

cp = cp.replace('computer: bot.computer', 'computers: bot.computers')
cp = cp.replace('patch({ computer: "cloud" })', 'patch({ computers: ["cloud"] })')
cp = cp.replace('computers: bot.computers,', 'computer: bot.computers,') # Wait! The error was Object literal may only specify known properties, but 'computers' does not exist in type '{ platform: "darwin" | "linux" | "win32" | "other"; computer: any; capabilitiesReady: boolean; localSelectable: boolean; }'. Did you mean to write 'computer'?
# Line 376 is probably an object like this. Let's inspect it manually?
# Actually, I'll just change `computers:` to `computer:` where it occurs near `platform:`
cp = re.sub(r'platform: capabilities\.host\.platform,\s*computers: bot\.computers,', 'platform: capabilities.host.platform,\n          computer: bot.computers,', cp)

with open("src/components/ComputerPanel.tsx", "w") as f:
    f.write(cp)

# 3. src/components/LocalComputerSection.tsx
with open("src/components/LocalComputerSection.tsx", "r") as f:
    lcs = f.read()
# Replace `status?.mode === "per-bot"` with `false` if it still exists
lcs = re.sub(r'status\?\.mode === "per-bot"', 'false', lcs)
lcs = re.sub(r'status\.mode === "per-bot"', 'false', lcs)
# Also remove `mode:` from being accessed at all
lcs = re.sub(r'status\.mode', 'false', lcs)
with open("src/components/LocalComputerSection.tsx", "w") as f:
    f.write(lcs)

# 4. src/components/SettingsModal.tsx
with open("src/components/SettingsModal.tsx", "r") as f:
    sm = f.read()
sm = sm.replace('| "computer"', '| "computers"')
sm = sm.replace('section === "computer"', 'section === "computers"')
with open("src/components/SettingsModal.tsx", "w") as f:
    f.write(sm)

# 5. src/lib/local-computer.ts
with open("src/lib/local-computer.ts", "r") as f:
    llc = f.read()
llc = llc.replace('bot.computer', '(bot.computers ?? [])')
with open("src/lib/local-computer.ts", "w") as f:
    f.write(llc)

# 6. src/state/bot-patch-queue.test.ts
with open("src/state/bot-patch-queue.test.ts", "r") as f:
    bpq_test = f.read()
bpq_test = bpq_test.replace('computer: "cloud"', 'computers: ["cloud"]')
with open("src/state/bot-patch-queue.test.ts", "w") as f:
    f.write(bpq_test)

