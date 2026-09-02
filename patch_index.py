import sys

with open('server/index.ts', 'r') as f:
    code = f.read()

replacement = """const bootSelection = await defaultSelection();
const store = new Store(() => bootSelection);"""

old_str = """let bootSelection = { instanceId: "", model: "" };
const store = new Store(() => bootSelection);
bootSelection = await defaultSelection();"""

if old_str in code:
    with open('server/index.ts', 'w') as f:
        f.write(code.replace(old_str, replacement))
    print("Patched index!")
else:
    print("Could not find exact bootSelection block")
