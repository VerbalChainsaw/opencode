#!/usr/bin/env bash
# assert-autogoal-repo.sh — fail loudly if the current working tree is
# not the canonical opencode-source monorepo with the AutoGoal package
# present. Run before any AutoGoal work to catch stale shells that
# still cd into the retired ../OpenGoal sibling.
#
# Exit codes:
#   0  — repository identity confirmed
#   1  — not inside a git work tree
#   2  — git root is not the opencode-source monorepo
#   3  — AutoGoal package directory missing
#
# Usage:
#   ./scripts/assert-autogoal-repo.sh
#
# Or from CI as a gate:
#   ./scripts/assert-autogoal-repo.sh || exit 1

set -eu

# Resolve the git root portably (works in WSL, git-bash on Windows, and
# POSIX shells). Don't hardcode /mnt/c paths.
if ! git_root=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "assert-autogoal-repo: not inside a git work tree" >&2
  exit 1
fi

# The expected repo root's basename must be `opencode-source`. This is
# the portable, host-independent check.
repo_basename=$(basename "$git_root")
if [ "$repo_basename" != "opencode-source" ]; then
  echo "assert-autogoal-repo: git root is '$git_root'" >&2
  echo "  expected basename 'opencode-source' (the canonical monorepo)." >&2
  echo "  The former sibling 'OpenGoal' was retired on 2026-06-22 and" >&2
  echo "  must not be used as a working directory." >&2
  exit 2
fi

# Verify the AutoGoal package is present. Use a relative path from the
# git root so the script is portable across host filesystems.
missing=0
for marker in packages/autogoal/src packages/autogoal/test packages/autogoal/specs; do
  if [ ! -d "$git_root/$marker" ]; then
    echo "assert-autogoal-repo: missing required path: $marker" >&2
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  echo "assert-autogoal-repo: AutoGoal package layout is incomplete." >&2
  echo "  Required: packages/autogoal/{src,test,specs}" >&2
  exit 3
fi

echo "assert-autogoal-repo: OK ($git_root)"
exit 0