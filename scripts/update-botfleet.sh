#!/usr/bin/env bash
# On-demand Mac updater entrypoint.  The transaction implementation stays in
# the tracked BotFleet checkout so the installed helper and its tests cannot
# drift apart.  A machine copy of this file lives at ~/apps/update-botfleet.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_IMPL="$SCRIPT_DIR/update-botfleet-mac.mjs"
TRACKED_IMPL="${BOTFLEET_UPDATER_IMPL:-$HOME/apps/botfleet-server/scripts/update-botfleet-mac.mjs}"

# launchd provides a minimal PATH. Ensure node/pnpm/git are found for source builds.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.asdf/shims:$PATH"
if [[ -d "$HOME/.nvm/versions/node" ]]; then
  LATEST_NODE="$(ls -t "$HOME/.nvm/versions/node" 2>/dev/null | head -n 1 || true)"
  if [[ -n "$LATEST_NODE" ]]; then
    export PATH="$HOME/.nvm/versions/node/$LATEST_NODE/bin:$PATH"
  fi
fi
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  export NVM_DIR="$HOME/.nvm"
  \. "$NVM_DIR/nvm.sh"
fi
if [[ -s "$HOME/.bun/bin/bun" ]]; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

if [[ -f "$LOCAL_IMPL" ]]; then
  exec node "$LOCAL_IMPL" "$@"
fi
if [[ -f "$TRACKED_IMPL" ]]; then
  exec node "$TRACKED_IMPL" "$@"
fi

echo "BotFleet updater implementation is missing.  Expected $TRACKED_IMPL" >&2
exit 1
