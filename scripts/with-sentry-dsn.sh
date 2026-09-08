#!/usr/bin/env bash
# Resolve SENTRY_DSN and VITE_SENTRY_DSN for a local packaging run, export
# both, then exec the given command.  electron-builder / Vite inline
# VITE_SENTRY_DSN at build time, so it must be in the environment before
# `pnpm package:mac:local` (or any other package:* script) starts.
#
# Resolution order per name: already-exported environment variable ->
# Infisical (only if the `infisical` CLI is on PATH and already logged in --
# this script never runs `infisical login`) -> the local handoff file
# ~/.secrets/botfleet-sentry.env (grep -m1 "^NAME=" | cut -d= -f2-, matching
# the fleet's grep-trap-safe pattern).  A value found for SENTRY_DSN but not
# VITE_SENTRY_DSN is copied across, since they are meant to be the same DSN.
# Never echoes, logs, or otherwise prints a resolved value.
#
# Usage:
#   scripts/with-sentry-dsn.sh pnpm package:mac:local
#
# Missing everywhere is not an error: the command still runs, packaged with
# Sentry inert (see src/lib/sentry.ts and server/sentry.ts, both no-op on an
# empty DSN).

set -uo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi

HANDOFF_FILE="${BOTFLEET_SENTRY_HANDOFF:-$HOME/.secrets/botfleet-sentry.env}"

# Reads $1 from (in order) the current environment, Infisical, then the
# handoff file.  Prints the resolved value on stdout; prints nothing (and
# nothing else, ever) when unresolved.  Callers capture this with
# command substitution, so no other output may reach stdout here.
resolve_secret() {
  local name="$1"
  local val="${!name:-}"

  if [[ -z "$val" ]] && command -v infisical >/dev/null 2>&1; then
    val="$(infisical secrets get "$name" \
      --plain --silent --telemetry=false --expand=false \
      --env=prod --path=/ 2>/dev/null || true)"
  fi

  if [[ -z "$val" && -f "$HANDOFF_FILE" ]]; then
    val="$(grep -m1 "^${name}=" "$HANDOFF_FILE" | cut -d= -f2-)"
  fi

  printf '%s' "$val"
}

SENTRY_DSN="$(resolve_secret SENTRY_DSN)"
VITE_SENTRY_DSN="$(resolve_secret VITE_SENTRY_DSN)"

if [[ -z "$VITE_SENTRY_DSN" ]]; then
  VITE_SENTRY_DSN="$SENTRY_DSN"
fi
if [[ -z "$SENTRY_DSN" ]]; then
  SENTRY_DSN="$VITE_SENTRY_DSN"
fi

if [[ -z "$SENTRY_DSN" ]]; then
  echo "[with-sentry-dsn] no SENTRY_DSN found (checked env, Infisical, $HANDOFF_FILE); packaging with Sentry inert" >&2
fi

export SENTRY_DSN VITE_SENTRY_DSN

exec "$@"
