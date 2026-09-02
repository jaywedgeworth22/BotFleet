#!/usr/bin/env bash
# Vercel Ignored Build Step.  Exit 0 skips the build.  Exit 1 (or greater) builds.
# Automatic git deploys: production at most once per hour; skip preview.
# Manual: VERCEL_FORCE_DEPLOY=1, or Dashboard Redeploy with Ignore Build Step unchecked.
set -euo pipefail

if [[ "${VERCEL_FORCE_DEPLOY:-}" == "1" ]]; then
  echo "force deploy"
  exit 1
fi

if [[ "${VERCEL_ENV:-}" != "production" ]]; then
  echo "skip preview auto-deploy (owner: one production site deploy per hour)"
  exit 0
fi

if [[ -n "${VERCEL_TOKEN:-}" && -n "${VERCEL_PROJECT_ID:-}" ]]; then
  team="${VERCEL_ORG_ID:-}"
  qs="projectId=${VERCEL_PROJECT_ID}&target=production&limit=1"
  if [[ -n "$team" ]]; then
    qs="${qs}&teamId=${team}"
  fi
  created=$(curl -fsS -H "Authorization: Bearer ${VERCEL_TOKEN}" \
    "https://api.vercel.com/v6/deployments?${qs}" \
    | python3 -c "import json,sys
d=json.load(sys.stdin)
deps=d.get('deployments') or []
print(deps[0]['created'] if deps else 0)" 2>/dev/null || echo 0)
  now_ms=$(python3 -c "import time; print(int(time.time()*1000))")
  if [[ "$created" =~ ^[0-9]+$ ]] && [[ "$created" -gt 0 ]]; then
    age=$(( (now_ms - created) / 1000 ))
    if [[ "$age" -lt 3600 ]]; then
      echo "skip production: last deploy ${age}s ago (cap 1/hour)"
      exit 0
    fi
  fi
fi

echo "build production"
exit 1
