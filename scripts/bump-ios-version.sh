#!/usr/bin/env bash
# Bump the iOS marketing version, stamp a fresh build number, and regenerate
# the Xcode project.
#
#   MARKETING_VERSION        X.Y.Z  ->  X.Y.(Z+1)
#   CURRENT_PROJECT_VERSION  UTC yyyymmddHHMM, the minute the build was cut
#
# Usage:
#   scripts/bump-ios-version.sh            # build number = now (UTC)
#   scripts/bump-ios-version.sh 202609021530
#
# The build-number scheme is shared with ios/project.yml and the fleet ship
# script (/Users/jay/apps/ios-fleet/ship-testflight.sh).  An epoch-seconds
# value (10 digits) sorts LOWER than every yyyymmddHHMM build already shipped
# (12 digits), and App Store Connect rejects a CFBundleVersion that does not
# increase, so this script refuses anything that is not a later 12-digit stamp.
set -euo pipefail
cd "$(dirname "$0")/../ios"

die() { echo "error: $*" >&2; exit 1; }

current_marketing=$(grep -m1 'MARKETING_VERSION:' project.yml | awk -F'"' '{print $2}')
current_build=$(grep -m1 'CURRENT_PROJECT_VERSION:' project.yml | awk -F'"' '{print $2}')

[[ "$current_marketing" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] \
  || die "MARKETING_VERSION '$current_marketing' in project.yml is not X.Y.Z"
next_marketing="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1))"

next_build="${1:-$(date -u +%Y%m%d%H%M)}"
[[ "$next_build" =~ ^[0-9]{12}$ ]] \
  || die "build number '$next_build' must be UTC yyyymmddHHMM (12 digits)"
if [[ "$current_build" =~ ^[0-9]+$ ]] && (( 10#$next_build <= 10#$current_build )); then
  die "build number $next_build is not greater than the current $current_build; wait a minute or pass a later stamp"
fi

echo "Bumping iOS version $current_marketing ($current_build) -> $next_marketing ($next_build)"

# Both targets carry the same pair of settings; /g keeps them in step.
sed -i '' "s/MARKETING_VERSION: \".*\"/MARKETING_VERSION: \"$next_marketing\"/g" project.yml
sed -i '' "s/CURRENT_PROJECT_VERSION: \".*\"/CURRENT_PROJECT_VERSION: \"$next_build\"/g" project.yml

# BotFleet.xcodeproj is gitignored; project.yml is the only file to commit.
xcodegen generate
