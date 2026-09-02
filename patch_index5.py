import sys
import re

content = open("server/index.ts").read()

# Delete DELETE block
content = re.sub(r'if \(!bot\) return json\(res, 404, \{ error: "no such bot" \}\);\n      if \(false\) \{.*?\n      \}\n      // a running turn dies with its bot', 'if (!bot) return json(res, 404, { error: "no such bot" });\n      // a running turn dies with its bot', content, flags=re.DOTALL)

# Delete changingLocalVmMode check
content = re.sub(r'const changingLocalVmMode = .*?\n      if \(changingLocalVmMode\) localVmModeChangeBusy = true;\n      try \{\n        if \(changingLocalVmMode\) \{.*?\n        \}\n      // A project key is useful', '      try {\n      // A project key is useful', content, flags=re.DOTALL)

# Delete existingPerBotLocalVmCount check inside /api/local-computer/:botId/setup POST
content = re.sub(r'if \(!\(await containerComputerExists\(before.runtime, target\)\)\) \{\n            const count = await existingPerBotLocalVmCount\(before.runtime\);\n            if \(count >= localVmMaxInstances\(cfg\)\) \{\n              return json\(res, 409, \{\n                error: `The per-bot Local VM limit is \$\{localVmMaxInstances\(cfg\)\} — delete an unused bot VM or raise the limit in App Settings`,\n              \}\);\n            \}\n          \}', '', content)

# Also fix the import unused errors:
content = content.replace("containerRuntimeStatus,", "")
content = content.replace("  Runtime,\n", "")

open("server/index.ts", "w").write(content)
