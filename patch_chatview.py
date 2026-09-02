import re

with open("src/components/ChatView.tsx", "r") as f:
    content = f.read()

# 2. Bot-to-bot messages styling
# "const user = message.role === "user";"
# Change to "const user = message.role === "user" && !message.from;"
content = content.replace('const user = message.role === "user";', 'const user = message.role === "user" && !message.from;')

# 3. Expandable bot-to-bot references
# Find ActivityChip and add state
# Replace ActivityChip with the expandable version
activity_chip_old = """function ActivityChip({ message }: { message: Message }) {
  const { dispatch } = useStore();
  const tool = message.tool;
  if (!tool) return null;
  // bot⇄bot comm chip: opens the channel where the exchange lives
  const comm = message.comm;
  if (comm) {
    return (
      <div className="flex justify-start">
        <button
          onClick={() => dispatch({ type: "select", id: comm.groupId })}
          title={`Open the conversation with ${comm.withName}`}
          className="flex items-center gap-2 rounded-xl border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <MausAvatar color={comm.withColor} state="happy" size={16} />
          <span className="max-w-[480px] truncate">{tool.name}</span>
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }"""

activity_chip_new = """function ActivityChip({ message }: { message: Message }) {
  const { dispatch } = useStore();
  const [expanded, setExpanded] = React.useState(false);
  const tool = message.tool;
  if (!tool) return null;
  // bot⇄bot comm chip: opens the channel where the exchange lives
  const comm = message.comm;
  if (comm) {
    if (expanded) {
      return (
        <div className="flex justify-start">
          <div className="flex flex-col gap-2 rounded-xl border border-hairline/40 bg-panel p-3 shadow-sm min-w-[320px] max-w-[480px]">
             <div className="flex items-center justify-between">
                <button onClick={() => setExpanded(false)} className="flex items-center gap-2 text-[13px] text-ink-secondary hover:text-ink">
                  <MausAvatar color={comm.withColor} state="happy" size={16} />
                  <span className="font-medium truncate">{tool.name}</span>
                  <ChevronDown size={13} />
                </button>
                <button
                  onClick={() => dispatch({ type: "select", id: comm.groupId })}
                  title={`Open the conversation with ${comm.withName}`}
                  className="rounded bg-control px-2 py-1 text-[11px] font-medium text-ink hover:bg-raised-hover"
                >
                  View Chat
                </button>
             </div>
             <div className="mt-1 text-[13px] text-ink whitespace-pre-wrap">
               {message.text}
             </div>
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-start">
        <button
          onClick={() => setExpanded(true)}
          title={`Expand message`}
          className="flex items-center gap-2 rounded-xl border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <MausAvatar color={comm.withColor} state="happy" size={16} />
          <span className="max-w-[480px] truncate">{tool.name}</span>
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }"""

content = content.replace(activity_chip_old, activity_chip_new)
content = content.replace('import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";',
                          'import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";')

# 4. Model logo on hover
# In MessageRow, bot is available.
# We need to import ProviderMark
content = content.replace('import { ProviderMark } from "./ProviderIcons";\n', '')
content = content.replace('import { ProviderMark } from "./ProviderIcons";', '')
content = content.replace('import { BotAvatar, MausAvatar } from "./Avatar";', 'import { BotAvatar, MausAvatar } from "./Avatar";\nimport { ProviderMark } from "./ProviderIcons";')

# add model logo to the hover options
hover_options_old = """            <button
              onClick={() =>
                dispatch({
                  type: "updateBot",
                  botId: bot.id,
                  patch: { pinnedMessageId: bot.pinnedMessageId === message.id ? "" : message.id },
                })
              }"""

hover_options_new = """            {bot && bot.modelSelection && (
              <div
                className="flex items-center justify-center p-1.5 text-ink-secondary opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                title={bot.modelSelection.model}
              >
                <ProviderMark driverKind={state.instances.find(i => i.instanceId === bot.modelSelection.instanceId)?.driverKind ?? "openai"} size={14} />
              </div>
            )}
            <button
              onClick={() =>
                dispatch({
                  type: "updateBot",
                  botId: bot.id,
                  patch: { pinnedMessageId: bot.pinnedMessageId === message.id ? "" : message.id },
                })
              }"""

content = content.replace(hover_options_old, hover_options_new)

with open("src/components/ChatView.tsx", "w") as f:
    f.write(content)
