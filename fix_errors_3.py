import re

def rep(file, old, new):
    with open(file, "r") as f:
        content = f.read()
    with open(file, "w") as f:
        f.write(content.replace(old, new))

# 1. src/App.tsx
rep("src/App.tsx", "patch: { computer: undefined }", "patch: { computers: undefined }")

# 2. src/components/ComputerPanel.tsx
rep("src/components/ComputerPanel.tsx", "patch: { computer: \"cloud\" }", "patch: { computers: [\"cloud\"] }")

# 3. src/components/LocalComputerSection.tsx
with open("src/components/LocalComputerSection.tsx", "r") as f:
    lcs = f.read()
lcs = re.sub(r'const \[policyPending, setPolicyPending\] = useState\(false\);\n', '', lcs)
lcs = re.sub(r'const savePolicy = \(mode: Status\["mode"\]\) => \{\n[\s\S]*?^\s*\};\n', '', lcs, flags=re.MULTILINE)
with open("src/components/LocalComputerSection.tsx", "w") as f:
    f.write(lcs)

# 4. src/components/SettingsModal.tsx
rep("src/components/SettingsModal.tsx", " | \"computer\"", " | \"computers\"")
rep("src/components/SettingsModal.tsx", "section === \"computer\"", "section === \"computers\"")

# 5. src/lib/local-computer.ts
rep("src/lib/local-computer.ts", "bot.computer", "(bot.computers ?? [])")

# 6. src/state/bot-patch-queue.test.ts
rep("src/state/bot-patch-queue.test.ts", "computer: \"cloud\"", "computers: [\"cloud\"]")

