#!/bin/bash
cd "$(dirname "$0")/../ios"

TIMESTAMP=$(date +%s)

# Read current patch version
CURRENT_MARKETING=$(grep "MARKETING_VERSION:" project.yml | head -n 1 | awk -F'"' '{print $2}')
# Assuming format 1.0.X, let's get X
PATCH=$(echo $CURRENT_MARKETING | awk -F'.' '{print $3}')
NEXT_PATCH=$((PATCH + 1))
NEXT_MARKETING="1.0.$NEXT_PATCH"

echo "Bumping iOS version to $NEXT_MARKETING ($TIMESTAMP)"

sed -i '' "s/MARKETING_VERSION: \".*\"/MARKETING_VERSION: \"$NEXT_MARKETING\"/g" project.yml
sed -i '' "s/CURRENT_PROJECT_VERSION: \".*\"/CURRENT_PROJECT_VERSION: \"$TIMESTAMP\"/g" project.yml

# Re-generate xcodeproj
xcodegen
