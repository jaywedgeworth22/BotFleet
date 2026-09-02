#!/usr/bin/env bash
# Vercel Ignored Build Step.  Exit 0 skips the build.  Exit 1 (or greater) builds.
#
# Automatic git deploys:
#   - skip every preview
#   - skip when this commit did not change site files
#   - production at most once per hour
# Manual: VERCEL_FORCE_DEPLOY=1, or Dashboard Redeploy with Ignore Build Step unchecked.
set -euo pipefail

if [[ "${VERCEL_FORCE_DEPLOY:-}" == "1" ]]; then
  echo "force deploy"
  exit 1
fi

if [[ "${VERCEL_ENV:-}" != "production" ]]; then
  echo "skip preview auto-deploy"
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
git_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"

# Paths to treat as "the website".  Nested scripts (apps/site, site/, web/)
# watch their own folder.  A repo-root script (DealDex) watches the tree
# minus native/docs/CI so an iOS or effort-log commit does not ship the site.
watch_args=()
if [[ -n "${VERCEL_IGNORE_WATCH:-}" ]]; then
  # shellcheck disable=SC2206
  watch_args=(${VERCEL_IGNORE_WATCH})
elif [[ -n "$git_root" && "$script_dir" != "$git_root" ]]; then
  watch_args=("${script_dir#"$git_root"/}")
else
  watch_args=(
    .
    ":(exclude)docs"
    ":(exclude)native"
    ":(exclude)ios"
    ":(exclude)android"
    ":(exclude).github"
    ":(exclude)Apps"
    ":(exclude)*.xcodeproj"
  )
fi

site_changed() {
  local before after rc
  after="${VERCEL_GIT_COMMIT_SHA:-HEAD}"
  if [[ -n "${VERCEL_GIT_PREVIOUS_SHA:-}" ]]; then
    before="${VERCEL_GIT_PREVIOUS_SHA}"
  elif git rev-parse --verify --quiet HEAD^ >/dev/null; then
    before="HEAD^"
  else
    echo "no previous commit; treat as site changed"
    return 0
  fi
  set +e
  git diff --quiet "$before" "$after" -- "${watch_args[@]}"
  rc=$?
  set -e
  # 0 = identical, 1 = changed, 2 = git error (shallow clone, missing sha)
  if [[ "$rc" -eq 0 ]]; then
    return 1
  fi
  if [[ "$rc" -eq 1 ]]; then
    return 0
  fi
  echo "git diff failed (rc $rc); treat as site changed"
  return 0
}

if ! site_changed; then
  echo "skip production: no site-file changes (${watch_args[*]})"
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
