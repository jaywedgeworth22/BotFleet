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
content = content.replace('existingBot?.computer === "local"', 'existingBot?.computers?.includes("local")')

content = content.replace('function localVmTargetForBot(botId: string): LocalVmTarget {\n  return false ? perBotLocalVmTarget(botId) : SHARED_LOCAL_VM_TARGET;\n}', 'function localVmTargetForBot(_botId?: string): LocalVmTarget {\n  return SHARED_LOCAL_VM_TARGET;\n}')
content = content.replace('function localVmTargetForBot(botId: string): LocalVmTarget {\n  return localVmMode(cfg) === "per-bot" ? perBotLocalVmTarget(botId) : SHARED_LOCAL_VM_TARGET;\n}', 'function localVmTargetForBot(_botId?: string): LocalVmTarget {\n  return SHARED_LOCAL_VM_TARGET;\n}')

content = content.replace('const targets = false\n    ? store.bots.filter((bot) => bot.computers?.includes("vm")).map((bot) => perBotLocalVmTarget(bot.id))\n    : [SHARED_LOCAL_VM_TARGET];', 'const targets = [SHARED_LOCAL_VM_TARGET];')
content = content.replace('const targets = localVmMode(cfg) === "per-bot"\n    ? store.bots.filter((bot) => bot.computer === "vm").map((bot) => perBotLocalVmTarget(bot.id))\n    : [SHARED_LOCAL_VM_TARGET];', 'const targets = [SHARED_LOCAL_VM_TARGET];')

# Manual string replacements to be completely safe
to_delete_perbot_block_1 = """async function existingPerBotLocalVmCount(runtime: Runtime) {
  const targets = [...new Map(store.bots.map((bot) => {
    const target = perBotLocalVmTarget(bot.id);
    return [target.key, target] as const;
  })).values()];
  const existing = await Promise.all(targets.map((target) => containerComputerExists(runtime, target)));
  return existing.filter(Boolean).length;
}

async function perBotLocalVmCountForModeChange(): Promise<number | null> {
  const targets = [...new Map(store.bots.map((bot) => {
    const target = perBotLocalVmTarget(bot.id);
    return [target.key, target] as const;
  })).values()];
  if (targets.length === 0) return 0;
  const runtime = await containerRuntimeStatus();
  if (!runtime.runtime || !runtime.daemonUp) {
    return targets.some((target) => existsSync(target.workspaceDir)) ? null : 0;
  }
  return existingPerBotLocalVmCount(runtime.runtime);
}"""

content = content.replace(to_delete_perbot_block_1, "")

to_delete_changing_mode = """      const changingLocalVmMode = patch.localVm?.mode !== undefined && patch.localVm.mode !== "shared";
      if (changingLocalVmMode) localVmModeChangeBusy = true;
      try {
        if (changingLocalVmMode) {
          if (localVmActiveThreads.size > 0 || localVmLifecycleBusy.size > 0 || localVmImageBusy) {
            return json(res, 409, { error: "stop Local VM turns and setup actions before changing the Local VM isolation mode" });
          }
          if ("shared" === "per-bot" && patch.localVm?.mode === "shared") {
            const existing = await perBotLocalVmCountForModeChange();
            if (existing === null) {
              return json(res, 409, {
                error: "start the container runtime and delete every per-bot VM before switching to shared mode",
              });
            }
            if (existing > 0) {
              return json(res, 409, {
                error: `delete the ${existing} per-bot Local VM${existing === 1 ? "" : "s"} before switching to shared mode`,
              });
            }
          }
        }"""

to_delete_changing_mode_orig = """      const changingLocalVmMode = patch.localVm?.mode !== undefined && patch.localVm.mode !== localVmMode(cfg);
      if (changingLocalVmMode) localVmModeChangeBusy = true;
      try {
        if (changingLocalVmMode) {
          if (localVmActiveThreads.size > 0 || localVmLifecycleBusy.size > 0 || localVmImageBusy) {
            return json(res, 409, { error: "stop Local VM turns and setup actions before changing the Local VM isolation mode" });
          }
          if (localVmMode(cfg) === "per-bot" && patch.localVm?.mode === "shared") {
            const existing = await perBotLocalVmCountForModeChange();
            if (existing === null) {
              return json(res, 409, {
                error: "start the container runtime and delete every per-bot VM before switching to shared mode",
              });
            }
            if (existing > 0) {
              return json(res, 409, {
                error: `delete the ${existing} per-bot Local VM${existing === 1 ? "" : "s"} before switching to shared mode`,
              });
            }
          }
        }"""

content = content.replace(to_delete_changing_mode_orig, "      try {")
content = content.replace('if (changingLocalVmMode) localVmModeChangeBusy = false;', '')

to_delete_delete_block = """      if (localVmMode(cfg) === "per-bot") {
        const target = perBotLocalVmTarget(bot.id);
        if (localVmActiveThreads.has(target.key) || localVmLifecycleBusy.has(target.key)) {
          return json(res, 409, { error: "stop this bot's Local VM turn or setup action before deleting the bot" });
        }
        const vm = await containerComputerStatus(undefined, undefined, target);
        if (!vm.daemonUp && existsSync(target.workspaceDir)) {
          return json(res, 409, {
            error: "start the container runtime and delete this bot's Local VM before deleting the bot",
          });
        }
        if (vm.container !== "missing") {
          return json(res, 409, { error: "delete this bot's Local VM from its Computer panel before deleting the bot" });
        }
      }"""

content = content.replace(to_delete_delete_block, "")

content = content.replace('const target = perBotLocalVmTarget(bot.id);\n      localVmIdles.get(target.key)?.cancel();\n      localVmIdles.delete(target.key);\n', '')


open("server/index.ts", "w").write(content)
