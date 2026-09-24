#!/bin/bash
# Tracked copy of the LaunchAgent entry for app.botfleet.server (legacy label
# com.jay.botfleet-server).  Install to ~/apps/botfleet-server-start.sh and
# point the LaunchAgent ProgramArguments at this path after merge.
#
# Starts the detached checkout harness, exits 0 when :8799 is already healthy,
# and self-heals once when node_modules is missing or imports fail with
# ERR_MODULE_NOT_FOUND / Cannot find package.
set -euo pipefail

ROOT="${BOTFLEET_SERVER_ROOT:-$HOME/apps/botfleet-server}"
PORT="${BOTFLEET_PORT:-8799}"
NODE="${BOTFLEET_NODE:-/opt/homebrew/bin/node}"
PNPM="${BOTFLEET_PNPM:-pnpm}"
HEAL_MINUTES="${BOTFLEET_HEAL_MINUTES:-15}"
STAMP="${BOTFLEET_HEAL_STAMP:-$ROOT/.botfleet-heal-stamp}"
PREFIX="[botfleet-server-start]"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--heal-only]

  --heal-only  Run dependency self-heal if needed, then exit (no server start).
EOF
}

health() {
  /usr/bin/curl -sf -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

log() {
  echo "$PREFIX $*"
}

log_err() {
  echo "$PREFIX $*" >&2
}

stamp_recent() {
  if [ ! -f "$STAMP" ]; then
    return 1
  fi
  local last now
  last="$(cat "$STAMP" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  if [ "$((now - last))" -lt "$((HEAL_MINUTES * 60))" ]; then
    return 0
  fi
  return 1
}

record_heal_attempt() {
  mkdir -p "$(dirname "$STAMP")"
  date +%s >"$STAMP"
}

needs_module_heal() {
  if [ ! -d "$ROOT/node_modules" ]; then
    return 0
  fi
  if [ ! -e "$ROOT/node_modules/yaml" ]; then
    return 0
  fi
  return 1
}

looks_like_missing_module() {
  local log_file="${1:-}"
  [ -n "$log_file" ] || return 1
  if /usr/bin/grep -Eq 'ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module' "$log_file"; then
    return 0
  fi
  return 1
}

run_install_once() {
  if stamp_recent; then
    log_err "dependency self-heal already attempted within ${HEAL_MINUTES}m (stamp: $STAMP)"
    log_err "manual fix: cd $ROOT && $PNPM install --frozen-lockfile"
    return 1
  fi
  if ! command -v "$PNPM" >/dev/null 2>&1; then
    log_err "$PNPM not on PATH; cannot self-heal missing node_modules"
    return 1
  fi
  record_heal_attempt
  log "missing dependencies detected; running $PNPM install --frozen-lockfile in $ROOT"
  (cd "$ROOT" && "$PNPM" install --frozen-lockfile)
}

preflight() {
  if [ ! -f "$ROOT/server/index.ts" ]; then
    log_err "missing $ROOT/server/index.ts"
    exit 1
  fi
  if [ ! -x "$NODE" ]; then
    log_err "missing node at $NODE"
    exit 1
  fi
}

probe_imports() {
  local probe_log
  probe_log="$(mktemp "${TMPDIR:-/tmp}/botfleet-probe.XXXXXX")"
  if (cd "$ROOT" && "$NODE" --experimental-strip-types -e "await import('yaml')") >"$probe_log" 2>&1; then
    rm -f "$probe_log"
    return 0
  fi
  if looks_like_missing_module "$probe_log"; then
    log_err "import probe failed with missing-module error:"
    /usr/bin/tail -n 10 "$probe_log" >&2 || true
    rm -f "$probe_log"
    return 1
  fi
  log_err "import probe failed:"
  /usr/bin/tail -n 20 "$probe_log" >&2 || true
  rm -f "$probe_log"
  return 2
}

maybe_heal_dependencies() {
  if needs_module_heal; then
    run_install_once
    return
  fi
  # The probe must run as an if-condition: under `set -e` a bare failing
  # call exits the script before rc is captured and the self-heal below
  # never runs for a partially broken installation.
  local rc=0
  if probe_imports; then
    return 0
  else
    rc=$?
  fi
  if [ "$rc" -eq 1 ]; then
    run_install_once
  elif [ "$rc" -ne 0 ]; then
    exit 1
  fi
}

HEAL_ONLY=false
if [ "${1:-}" = "--heal-only" ]; then
  HEAL_ONLY=true
elif [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
elif [ "$#" -gt 0 ]; then
  log_err "unknown argument: $1"
  usage >&2
  exit 2
fi

if health; then
  log ":${PORT} already healthy; not starting a second harness"
  exit 0
fi

preflight
maybe_heal_dependencies

if [ "$HEAL_ONLY" = true ]; then
  log "self-heal complete; --heal-only set, not starting server"
  exit 0
fi

if needs_module_heal; then
  log_err "node_modules still missing after self-heal attempt"
  exit 1
fi

cd "$ROOT"
exec "$NODE" --experimental-strip-types server/index.ts
