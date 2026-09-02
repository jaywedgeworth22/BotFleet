import sys

with open('server/index.ts', 'r') as f:
    code = f.read()

replacement = """  const pick = available.find((d) => d.driverKind === "antigravityAgent") ?? available.find((d) => d.driverKind === "grokAgent") ?? available.find((d) => d.driverKind === "claudeAgent") ?? available[0];"""
old_str = """  const pick = available.find((d) => d.driverKind === "claudeAgent") ?? available[0];"""

if old_str in code:
    with open('server/index.ts', 'w') as f:
        f.write(code.replace(old_str, replacement))
    print("Patched defaultSelection!")
else:
    print("Could not find defaultSelection line")
