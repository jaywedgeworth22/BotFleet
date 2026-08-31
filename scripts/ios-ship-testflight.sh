#!/usr/bin/env bash
# Thin wrapper: ship BotFleet companion to TestFlight (no Xcode UI).
# Canonical implementation: /Users/jay/apps/ios-fleet/ship-testflight.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

MAC="/Users/jay/apps/ios-fleet/ship-testflight.sh"
if [[ -f "$MAC" ]]; then
  exec bash "$MAC" botfleet --repo-root "$ROOT" "$@"
fi
echo "error: ios-fleet ship-testflight.sh not found at ${MAC}" >&2
exit 1
