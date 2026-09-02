import re

with open('src/components/EnginesSettings.tsx', 'r') as f:
    content = f.read()

# Replace the rows filter
new_filter = """const rows = state.instances.filter((i) => i.cli !== undefined || i.cliDefault !== undefined);"""
content = re.sub(r'const rows = state\.instances\.filter\(\(i\) => i\.cli !== undefined \|\| i\.cliDefault !== undefined \|\| i\.snapshot\.state === "unavailable"\);', new_filter, content)

with open('src/components/EnginesSettings.tsx', 'w') as f:
    f.write(content)
