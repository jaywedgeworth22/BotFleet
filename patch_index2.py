import sys

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

# localVmTargetForBot
content = content.replace('function localVmTargetForBot(botId: string): LocalVmTarget {\n  return false ? perBotLocalVmTarget(botId) : SHARED_LOCAL_VM_TARGET;\n}', 'function localVmTargetForBot(_botId: string): LocalVmTarget {\n  return SHARED_LOCAL_VM_TARGET;\n}')

# line 1060 IIFE
content = content.replace('const targets = false\n    ? store.bots.filter((bot) => bot.computers?.includes("vm")).map((bot) => perBotLocalVmTarget(bot.id))\n    : [SHARED_LOCAL_VM_TARGET];', 'const targets = [SHARED_LOCAL_VM_TARGET];')

# delete per-bot logic
content = content.replace('const changingLocalVmMode = patch.localVm?.mode !== undefined && patch.localVm.mode !== "shared";\n      if (changingLocalVmMode) localVmModeChangeBusy = true;', '')
content = content.replace('if (changingLocalVmMode) {\n          if (localVmActiveThreads.size > 0 || localVmLifecycleBusy.size > 0 || localVmImageBusy) {\n            return json(res, 409, { error: "stop Local VM turns and setup actions before changing the Local VM isolation mode" });\n          }\n          if (false && patch.localVm?.mode === "shared") {\n            const existing = await perBotLocalVmCountForModeChange();\n            if (existing === null) {\n              return json(res, 409, {\n                error: "start the container runtime and delete every per-bot VM before switching to shared mode",\n              });\n            }\n            if (existing > 0) {\n              return json(res, 409, {\n                error: `delete the ${existing} per-bot Local VM${existing === 1 ? "" : "s"} before switching to shared mode`,\n              });\n            }\n          }\n        }', '')

content = content.replace('if (changingLocalVmMode) localVmModeChangeBusy = false;', '')

open("server/index.ts", "w").write(content)
