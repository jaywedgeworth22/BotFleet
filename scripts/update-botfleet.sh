#!/usr/bin/env bash
# On-demand Mac updater entrypoint.  The transaction implementation stays in
# the tracked BotFleet checkout so the installed helper and its tests cannot
# drift apart.  A machine copy of this file lives at ~/apps/update-botfleet.sh.
#
# When Electron spawns this script from a packaged .app, PATH is reduced to
# /usr/bin:/bin:/usr/sbin:/sbin, which does not include Homebrew or nvm.
# Prepend the common node locations so `node` resolves regardless of how this
# script is invoked.
set -euo pipefail

# Extend PATH with every place node is commonly found on macOS (Homebrew Apple
# Silicon, Homebrew Intel, nvm default, fnm default, local pnpm node, and
# Volta).  Already-present entries are harmless duplicates.
export PATH=\
"/opt/homebrew/bin"\
":/usr/local/bin"\
":${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node/" 2>/dev/null | sort -V | tail -1)/bin"\
":${HOME}/.fnm/node-versions/$(ls "${HOME}/.fnm/node-versions/" 2>/dev/null | sort -V | tail -1)/installation/bin"\
":${HOME}/.local/share/pnpm"\
":${HOME}/.local/bin"\
":${HOME}/.volta/bin"\
":${PATH}"

# Resolve the node binary explicitly so a missing one produces a clear message
# rather than a confusing "exec: node: not found" (exit 127) after the script
# was supposed to work.
NODE_BIN=""
for candidate in \
    "$(command -v node 2>/dev/null || true)" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node; do
  if [[ -x "$candidate" ]]; then
    NODE_BIN="$candidate"
    break
  fi
done
if [[ -z "$NODE_BIN" ]]; then
  echo "BotFleet updater: node not found.  Install Node.js via Homebrew: brew install node" >&2
  exit 127
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_IMPL="$SCRIPT_DIR/update-botfleet-mac.mjs"
TRACKED_IMPL="${BOTFLEET_UPDATER_IMPL:-$HOME/apps/botfleet-server/scripts/update-botfleet-mac.mjs}"

if [[ -f "$LOCAL_IMPL" ]]; then
  exec "$NODE_BIN" "$LOCAL_IMPL" "$@"
fi
if [[ -f "$TRACKED_IMPL" ]]; then
  exec "$NODE_BIN" "$TRACKED_IMPL" "$@"
fi

echo "BotFleet updater implementation is missing.  Expected $TRACKED_IMPL" >&2
exit 1
