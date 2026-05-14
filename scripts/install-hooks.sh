#!/usr/bin/env bash
# Installs versioned git hooks into the local .git/hooks/ directory.
# Works in worktrees (uses --git-common-dir).
# Run once per fresh clone: `bash scripts/install-hooks.sh`.
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_COMMON="$(git rev-parse --git-common-dir)"
SOURCE="$REPO_ROOT/scripts/git-hooks"
DEST="$GIT_COMMON/hooks"
mkdir -p "$DEST"
for hook in "$SOURCE"/*; do
  name=$(basename "$hook")
  cp "$hook" "$DEST/$name"
  chmod +x "$DEST/$name"
  echo "installed: $DEST/$name"
done
