#!/bin/bash
# Adds one file to this run's release, creating the release if it's the
# first platform to finish. Used by .github/workflows/build.yml.
set -euo pipefail
FILE="$1"
REPO="$GITHUB_REPOSITORY"

for attempt in 1 2 3; do
  if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    gh release upload "$TAG" "$FILE" --repo "$REPO" --clobber
    exit 0
  fi
  if gh release create "$TAG" "$FILE" --repo "$REPO" --target "$GITHUB_SHA" \
       --title "Maple Tracker $TAG" --notes "$NOTES" --latest; then
    exit 0
  fi
  # The other platform created it at the same moment: try uploading instead.
  sleep 5
done
echo "Couldn't publish $FILE" >&2
exit 1
