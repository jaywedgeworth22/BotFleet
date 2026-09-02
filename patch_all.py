import os
import re

# 1. Update store.tsx: change `computer?:` to `computers?: Array<"cloud" | "vm" | "local">;`
with open("src/state/store.tsx", "r") as f:
    store = f.read()

store = store.replace('computer?: "cloud" | "vm" | "local" | "off";', 'computers?: Array<"cloud" | "vm" | "local">;')
# Replace occurrences of `computer: source.computer,` with `computers: source.computers,`
store = store.replace('computer: source.computer,', 'computers: source.computers,')

with open("src/state/store.tsx", "w") as f:
    f.write(store)


# 2. Update SettingsPanel.tsx
with open("src/components/SettingsPanel.tsx", "r") as f:
    settings = f.read()

# Replace types
settings = settings.replace('| "computer"', '| "computers"')

# Replace Where this bot's computer runs
settings = settings.replace('Where this bot\'s computer runs{bot.computer ? "" : " (currently: auto)"}',
                            'Where this bot\'s computer runs{bot.computers?.length ? "" : " (currently: auto)"}')

# Replace the button rendering logic for computer
old_btn_logic = """                  onClick={() => {
                    if (mode === bot.computer) return;
                    if (mode === "local" && bot.autoApprove) setLocalAutoWarning("local");
                    else patch({ computer: mode });
                  }}
                  className={cn(
                    "flex-1 py-1.5 text-[13px] capitalize",
                    i > 0 && "border-l border-hairline/40",
                    mode === "local" && !localSelectable && "cursor-not-allowed opacity-40",
                    bot.computer === mode
                      ? "bg-control text-ink"
                      : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                  )}"""

new_btn_logic = """                  onClick={() => {
                    const current = bot.computers ?? [];
                    if (current.includes(mode)) {
                      patch({ computers: current.filter(x => x !== mode) });
                    } else {
                      if (mode === "local" && bot.autoApprove) setLocalAutoWarning("local");
                      patch({ computers: [...current, mode] });
                    }
                  }}
                  className={cn(
                    "flex-1 py-1.5 text-[13px] capitalize",
                    i > 0 && "border-l border-hairline/40",
                    mode === "local" && !localSelectable && "cursor-not-allowed opacity-40",
                    (bot.computers ?? []).includes(mode)
                      ? "bg-control text-ink"
                      : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                  )}"""

settings = settings.replace(old_btn_logic, new_btn_logic)

# Replace (!bot.computer || bot.computer === "cloud")
settings = settings.replace('(!bot.computer || bot.computer === "cloud")', '(!(bot.computers?.length) || bot.computers?.includes("cloud"))')
settings = settings.replace('!bot.computer && bot.cloudBackend === "vps"', '!(bot.computers?.length) && bot.cloudBackend === "vps"')
settings = settings.replace('bot.computer === "local"', '(bot.computers ?? []).includes("local")')

with open("src/components/SettingsPanel.tsx", "w") as f:
    f.write(settings)


# 3. LocalComputerSection.tsx - remove per-bot
with open("src/components/LocalComputerSection.tsx", "r") as f:
    local_sec = f.read()

local_sec = re.sub(r'mode: "shared" \| "per-bot";\n\s*', '', local_sec)
local_sec = re.sub(r'const perBot = status\?\.mode === "per-bot";\n\s*', 'const perBot = false;\n  ', local_sec)
local_sec = re.sub(r'\{\(\["shared", "per-bot"\] as const\)\.map\(\(mode, index\) => \([\s\S]*?\}\)\}\n\s*', '', local_sec)
local_sec = re.sub(r'\{perBot && \([\s\S]*?\}\n\s*', '', local_sec)

with open("src/components/LocalComputerSection.tsx", "w") as f:
    f.write(local_sec)


# 4. ComputerPanel.tsx - display 2 desktops
with open("src/components/ComputerPanel.tsx", "r") as f:
    comp_panel = f.read()

comp_panel = comp_panel.replace('bot.computer', 'bot.computers')
comp_panel = comp_panel.replace('bot.computers === "cloud"', '(bot.computers ?? []).includes("cloud")')
comp_panel = comp_panel.replace('bot.computers === "vm"', '(bot.computers ?? []).includes("vm")')
comp_panel = comp_panel.replace('bot.computers === "local"', '(bot.computers ?? []).includes("local")')
comp_panel = comp_panel.replace('bot.computers === "off"', '(bot.computers ?? []).length === 0')
comp_panel = comp_panel.replace('bot.computers !== "cloud"', '!(bot.computers ?? []).includes("cloud")')
comp_panel = comp_panel.replace('computers: bot.computers,', 'computers: bot.computers ?? [],')
comp_panel = comp_panel.replace('(!bot.computers || bot.computers === "cloud")', '(!(bot.computers?.length) || bot.computers?.includes("cloud"))')
comp_panel = comp_panel.replace('!bot.computers && cloudBackend', '!(bot.computers?.length) && cloudBackend')

# Also change the mode selection in ComputerPanel
comp_panel = comp_panel.replace("""                  if (mode === bot.computers) return;
                  if (mode === "local" && bot.autoApprove) setLocalAutoWarning("local");
                  else patch({ computers: mode });""",
"""                  const current = bot.computers ?? [];
                  if (current.includes(mode)) {
                    patch({ computers: current.filter(x => x !== mode) });
                  } else {
                    if (mode === "local" && bot.autoApprove) setLocalAutoWarning("local");
                    patch({ computers: [...current, mode] });
                  }""")

comp_panel = comp_panel.replace("""                  bot.computers === mode
                    ? "bg-control text-ink"
                    : "text-ink-secondary hover:bg-control/60 hover:text-ink",""",
"""                  (bot.computers ?? []).includes(mode)
                    ? "bg-control text-ink"
                    : "text-ink-secondary hover:bg-control/60 hover:text-ink",""")


# Now handle the 2 desktops rendering simultaneously
# Look for <LocalScreenPreview> inside the rendering
# It currently probably has if/else to show one or the other. Let's inspect it later.

with open("src/components/ComputerPanel.tsx", "w") as f:
    f.write(comp_panel)
