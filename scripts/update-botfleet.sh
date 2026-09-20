#!/usr/bin/env bash
# On-demand Mac updater entrypoint.  The transaction implementation stays in
# the tracked BotFleet checkout so the installed helper and its tests cannot
# drift apart.  A machine copy of this file lives at ~/apps/update-botfleet.sh.
#
# When Electron spawns this script from a packaged .app, PATH is reduced to
# /usr/bin:/bin:/usr/sbin:/sbin, which does not include Homebrew or nvm.
# Prepend the common node locations so `node` resolves regardless of how this
# script is invoked.
#
# `ubf` is a no-op when the local BotFleet checkout is already at origin/main.
# Override with BOTFLEET_FORCE=1 to reinstall anyway.  The transaction inside
# update-botfleet-mac.mjs has no built-in "already current" short circuit; the
# skip happens here so a second `ubf` an hour later is sub-second instead of a
# 2-minute interruption.
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

# Skip the close / rebuild / relaunch dance when the local BotFleet checkout is
# already at origin/main.  Override the check with BOTFLEET_FORCE=1 or by
# passing --force / -f.  Override the checkout location with BOTFLEET_CHECKOUT
# (defaults to the parent of the tracked implementation).
# --force / -f mirrors the env-var override; recognised here so the documented
# flag does what its name says.
if [[ -z "${BOTFLEET_FORCE:-}" ]]; then
  for arg in "$@"; do
    case "$arg" in
      --force|-f) BOTFLEET_FORCE=1 ;;
    esac
  done
fi
if [[ -z "${BOTFLEET_CHECKOUT:-}" ]]; then
  # Defensive: `set -e` is on, but the parent of $TRACKED_IMPL may not exist
  # yet (first run, custom $BOTFLEET_UPDATER_IMPL, etc.).  Swallow the cd
  # failure and let the next test fall through to the updater.
  BOTFLEET_CHECKOUT="$(cd "$(dirname "$(dirname "$TRACKED_IMPL")")" 2>/dev/null && pwd)" || BOTFLEET_CHECKOUT=""
fi
if [[ "${BOTFLEET_FORCE:-}" == "1" ]]; then
  echo "⚠️  BOTFLEET_FORCE=1 — running updater even if $BOTFLEET_CHECKOUT is already at origin/main."
elif [[ -n "$BOTFLEET_CHECKOUT" && -d "$BOTFLEET_CHECKOUT/.git" ]]; then
  if git -C "$BOTFLEET_CHECKOUT" fetch --quiet origin main 2>/dev/null; then
    LOCAL_HEAD=$(git -C "$BOTFLEET_CHECKOUT" rev-parse HEAD)
    REMOTE_HEAD=$(git -C "$BOTFLEET_CHECKOUT" rev-parse origin/main)
    if [[ "$LOCAL_HEAD" == "$REMOTE_HEAD" ]]; then
      CURRENT=$(git -C "$BOTFLEET_CHECKOUT" log --oneline -1)
      echo "✅ Already at $CURRENT.  Nothing to update.  (Set BOTFLEET_FORCE=1 or pass --force to reinstall anyway.)"
      exit 0
    fi
  else
    echo "⚠️  Could not fetch origin/main from $BOTFLEET_CHECKOUT; running updater anyway."
  fi
fi

if [[ -f "$LOCAL_IMPL" ]]; then
  exec "$NODE_BIN" "$LOCAL_IMPL" "$@" </dev/null
fi
if [[ -f "$TRACKED_IMPL" ]]; then
  exec "$NODE_BIN" "$TRACKED_IMPL" "$@" </dev/null
fi

echo "BotFleet updater implementation is missing.  Expected $TRACKED_IMPL" >&2
exit 1
