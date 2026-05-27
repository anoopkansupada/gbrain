#!/bin/bash
# PC3 timeline backfill — ONE-SHOT (component C1 of the weekly meta-cognitive
# cron task). Backfills timeline_entries for correspondence/* + meetings/* pages
# from dated events in their bodies. Idempotent: re-running is a no-op.
#
#   ./run.sh --dry-run   # report only, writes nothing
#   ./run.sh             # real write
#
# NOT installed as a launchd job — this is a one-shot. Lives in
# ~/.gbrain/integrations/timeline-backfill/ at runtime; source-of-truth is the
# gbrain repo under integrations/timeline-backfill/.
set -euo pipefail
source ~/.zprofile 2>/dev/null || true
source ~/.gbrain/env 2>/dev/null || true
export PATH="/Users/jarvis/.nvm/versions/node/v24.15.0/bin:/opt/homebrew/bin:$PATH"

GBRAIN_DIR="$HOME/gbrain"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# bun is the repo runtime; fall back to node if absent. Run with cwd=GBRAIN_DIR
# so postgres.js resolves from the repo's node_modules.
cd "$GBRAIN_DIR"
if command -v bun >/dev/null 2>&1; then
  bun "$SCRIPT_DIR/backfill.ts" "$@"
else
  node --experimental-strip-types "$SCRIPT_DIR/backfill.ts" "$@"
fi
