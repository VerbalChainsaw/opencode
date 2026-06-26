#!/usr/bin/env bash
#
# VerbalChainsaw fork release pipeline. One command, end-to-end:
#   1. Builds the Windows desktop exe with OPENCODE_CHANNEL=prod (CRITICAL
#      — defaulting to "dev" creates a separate appId / appData folder so
#      the new exe doesn't see the prior install's projects, sessions, or
#      settings).
#   2. Tags the current HEAD with the supplied version.
#   3. Pushes the tag to origin.
#   4. Cuts a GitHub release with the exe + blockmap and auto-generated
#      release notes from the commit log since the previous tag.
#
# Usage:
#   ./script/release-fork.sh v1.17.6-vc1
#   ./script/release-fork.sh v1.17.6-vc1 "Optional release-notes lead-in"
#
# Prereqs: bun, gh, git. No CI dependency; everything runs locally.

set -euo pipefail

VERSION="${1:-}"
NOTES_LEAD="${2:-}"

if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version> [notes-lead]" >&2
  echo "Example: $0 v1.17.6-vc1" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if git rev-parse --verify "refs/tags/$VERSION" >/dev/null 2>&1; then
  echo "Tag $VERSION already exists locally. Delete it first or pick another version." >&2
  exit 3
fi

PREV_TAG="$(git describe --tags --abbrev=0 --match 'v*-vc*' 2>/dev/null || echo '')"

echo "==> Building Windows desktop exe (channel=prod)..."
(
  cd packages/desktop
  OPENCODE_CHANNEL=prod bun run package:win
)

EXE_PATH="$REPO_ROOT/packages/desktop/dist/opencode-desktop-win-x64.exe"
BLOCKMAP_PATH="$EXE_PATH.blockmap"

if [[ ! -f "$EXE_PATH" ]]; then
  echo "Build finished but $EXE_PATH is missing. Aborting." >&2
  exit 4
fi

EXE_SIZE_MB=$(( $(stat -c%s "$EXE_PATH" 2>/dev/null || wc -c < "$EXE_PATH") / 1048576 ))
echo "==> Built: $EXE_PATH (${EXE_SIZE_MB} MB)"

echo "==> Tagging $VERSION on $(git rev-parse --short HEAD)..."
git tag -a "$VERSION" -m "$VERSION"
git push origin "$VERSION" --no-verify

echo "==> Generating release notes..."
NOTES_FILE="$(mktemp)"
{
  if [[ -n "$NOTES_LEAD" ]]; then
    printf '%s\n\n' "$NOTES_LEAD"
  fi
  if [[ -n "$PREV_TAG" ]]; then
    COMMIT_COUNT=$(git rev-list "$PREV_TAG..HEAD" --count)
    printf '**%s commits since [%s](https://github.com/VerbalChainsaw/opencode/releases/tag/%s).**\n\n' \
      "$COMMIT_COUNT" "$PREV_TAG" "$PREV_TAG"
    printf '## Commits\n\n'
    git log "$PREV_TAG..HEAD" --pretty=format:'- %s' --no-merges
    printf '\n\n'
  fi
  printf '## Install\n\nDownload `opencode-desktop-win-x64.exe` (~%s MB) below and run.\n' "$EXE_SIZE_MB"
} > "$NOTES_FILE"

echo "==> Cutting GitHub release..."
gh release create "$VERSION" \
  "$EXE_PATH" \
  "$BLOCKMAP_PATH" \
  --title "OpenCode VerbalChainsaw Edition $VERSION" \
  --notes-file "$NOTES_FILE"

rm -f "$NOTES_FILE"

echo "==> Done."
echo "    Release: https://github.com/VerbalChainsaw/opencode/releases/tag/$VERSION"
echo "    Exe:     $EXE_PATH"
