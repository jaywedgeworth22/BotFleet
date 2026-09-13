#!/usr/bin/env bash
# Vercel Ignored Build Step.  Exit 0 skips the build.  Exit 1 (or greater) builds.
#
# Owner 2026-09-13: merge to main is production.  Skip Vercel *preview*
# auto-deploys only.  Do not cap production to once per hour and do not skip
# a production git deploy because git-diff or a quota heuristic said so.
# Manual: VERCEL_FORCE_DEPLOY=1, or Dashboard Redeploy.
set -euo pipefail

if [[ "${VERCEL_FORCE_DEPLOY:-}" == "1" ]]; then
  echo "force deploy"
  exit 1
fi

if [[ "${VERCEL_ENV:-}" != "production" ]]; then
  echo "skip preview auto-deploy"
  exit 0
fi

echo "build production (merge = live)"
exit 1
