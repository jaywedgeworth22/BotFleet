import sys
import re

content = open("server/index.ts").read()

content = content.replace("localVmMode,\n", "")
content = content.replace('localVmMode(cfg) === "per-bot"', "false")
content = content.replace('localVmMode(cfg)', '"shared"')

content = content.replace('bot.computer === "vm"', 'bot.computers?.includes("vm")')
content = content.replace('bot.computer === "local"', 'bot.computers?.includes("local")')
content = content.replace('bot.computer !== "cloud"', '!bot.computers?.includes("cloud")')
content = content.replace('wants = opts?.runOn === "cloud" ? "cloud" : bot.computer;', 'wants = opts?.runOn === "cloud" ? "cloud" : bot.computers?.[0];')
content = content.replace('wantsComputer = body.computer !== undefined ? body.computer : existingBot?.computer', 'wantsComputers = body.computers !== undefined ? body.computers : existingBot?.computers')
content = content.replace('wantsComputer === "local"', 'wantsComputers?.includes("local")')
content = content.replace('existingBot?.computer === "local" && existingBot?.autoApprove === true', 'existingBot?.computers?.includes("local") && existingBot?.autoApprove === true')
content = content.replace('existingBot?.computer === "local" && body.computer !== undefined && body.computer !== "local"', 'existingBot?.computers?.includes("local") && body.computers !== undefined && !body.computers.includes("local")')
content = content.replace('existingBot?.computer === "local"', 'existingBot?.computers?.includes("local")')

# localVmTargetForBot
content = content.replace('function localVmTargetForBot(botId: string): LocalVmTarget {\n  return false ? perBotLocalVmTarget(botId) : SHARED_LOCAL_VM_TARGET;\n}', 'function localVmTargetForBot(_botId: string): LocalVmTarget {\n  return SHARED_LOCAL_VM_TARGET;\n}')
content = content.replace('function localVmTargetForBot(botId: string): LocalVmTarget {\n  return localVmMode(cfg) === "per-bot" ? perBotLocalVmTarget(botId) : SHARED_LOCAL_VM_TARGET;\n}', 'function localVmTargetForBot(_botId: string): LocalVmTarget {\n  return SHARED_LOCAL_VM_TARGET;\n}')


# line 1060 IIFE
content = content.replace('const targets = false\n    ? store.bots.filter((bot) => bot.computers?.includes("vm")).map((bot) => perBotLocalVmTarget(bot.id))\n    : [SHARED_LOCAL_VM_TARGET];', 'const targets = [SHARED_LOCAL_VM_TARGET];')
content = content.replace('const targets = localVmMode(cfg) === "per-bot"\n    ? store.bots.filter((bot) => bot.computer === "vm").map((bot) => perBotLocalVmTarget(bot.id))\n    : [SHARED_LOCAL_VM_TARGET];', 'const targets = [SHARED_LOCAL_VM_TARGET];')

# delete per-bot logic
# changingLocalVmMode
content = re.sub(r'const changingLocalVmMode = .*?\n      if \(changingLocalVmMode\) localVmModeChangeBusy = true;\n', '', content)
content = re.sub(r'if \(changingLocalVmMode\) {.*?\n        }', '', content, flags=re.DOTALL)
content = content.replace('if (changingLocalVmMode) localVmModeChangeBusy = false;', '')

# perBotLocalVmCountForModeChange and existingPerBotLocalVmCount
content = re.sub(r'async function existingPerBotLocalVmCount.*?}\n\nasync function perBotLocalVmCountForModeChange.*?}\n\n', '', content, flags=re.DOTALL)

# Delete the DELETE per-bot check
content = re.sub(r'if \(!bot\) return json\(res, 404, \{ error: "no such bot" \}\);\n      if \(localVmMode\(cfg\) === "per-bot"\) \{.*?\}\n', 'if (!bot) return json(res, 404, { error: "no such bot" });\n', content, flags=re.DOTALL)
content = re.sub(r'if \(!bot\) return json\(res, 404, \{ error: "no such bot" \}\);\n      if \(false\) \{.*?\}\n', 'if (!bot) return json(res, 404, { error: "no such bot" });\n', content, flags=re.DOTALL)

# perBotLocalVmTarget deletion in DELETE
content = re.sub(r'const target = perBotLocalVmTarget\(bot.id\);\n      localVmIdles.get\(target.key\)\?.cancel\(\);\n      localVmIdles.delete\(target.key\);\n', '', content)

open("server/index.ts", "w").write(content)
