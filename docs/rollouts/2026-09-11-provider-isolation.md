# Provider Request Isolation

## Scope

Issues #278 and #279 isolate provider request context per bot.  Claude no longer imports the user’s global `~/.claude.json` MCP servers, and every Claude turn passes a strict MCP config containing only the bot’s selected integrations.  Grok builds one chat-completions message list from the system prompt, transcript, tool history, and current prompt.

## Validation

- `pnpm exec vitest run server/drivers/claude.test.ts server/drivers/grok.test.ts`: 69 passed, 1 skipped.
- `pnpm exec tsc -p tsconfig.server.json --noEmit`: passed.
- Full `pnpm` gate: pending the shared engine safety slot; no broad test result is claimed here.

## Rollout

Deploy only with a Claude CLI version that supports `--strict-mcp-config`.  The focused fake CLI verifies argument and config isolation; CI and the full gate still need to validate the merged branch across platforms.
