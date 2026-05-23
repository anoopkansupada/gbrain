#!/usr/bin/env bash
# bin/upgrade.sh — automated gbrain upgrade (Mac Mini)
#
# Usage:
#   ./bin/upgrade.sh                 # full upgrade with pg_dump
#   ./bin/upgrade.sh --skip-backup   # skip pg_dump (faster, riskier)
#   ./bin/upgrade.sh --resume        # continue after manual conflict resolution
#
# On conflict, the script exits with code 2 and instructions. After resolving
# manually (`git rebase --continue` etc.), re-run with --resume to pick up at
# the build step.

set -euo pipefail

REPO_DIR="$HOME/gbrain"
BACKUP_DIR="$HOME/gbrain-backups"
DATE=$(date +%Y%m%d-%H%M%S)
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"

JOBS=(
  com.gbrain.serve com.gbrain.autopilot com.gbrain.cycle
  com.gbrain.granola-sync com.gbrain.calendar-sync com.gbrain.token-launch-feed
  com.gbrain.milo-drift com.gbrain.pre-meeting-brief com.gbrain.serve-watchdog
  com.gbrain.repair-type-field-canary com.anoop.gbrain-hash-source-sync
)

MODE="full"
for arg in "$@"; do
  case "$arg" in
    --skip-backup) MODE="skip-backup" ;;
    --resume)      MODE="resume" ;;
    *) echo "unknown flag: $arg"; exit 1 ;;
  esac
done

cd "$REPO_DIR"

log() { echo "[upgrade $(date +%H:%M:%S)] $*"; }

stop_jobs() {
  log "stopping launchd jobs..."
  for job in "${JOBS[@]}"; do
    plist="$HOME/Library/LaunchAgents/$job.plist"
    [ -f "$plist" ] && launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  done
}

start_jobs() {
  log "restarting launchd jobs..."
  for job in "${JOBS[@]}"; do
    plist="$HOME/Library/LaunchAgents/$job.plist"
    [ -f "$plist" ] && launchctl bootstrap "gui/$(id -u)" "$plist" 2>&1 | tail -1 || true
  done
}

build_and_migrate() {
  log "bun install..."
  bun install
  log "bun build..."
  bun run build
  local ver
  ver=$(./bin/gbrain --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  log "new version: $ver"
  log "running migrations (session pool)..."
  GBRAIN_DISABLE_DIRECT_POOL=1 ./bin/gbrain init --migrate-only
}

smoke_test() {
  log "smoke test: dream --dry-run (bypass lock, timeout 10m)..."
  if ! GBRAIN_DISABLE_DIRECT_POOL=1 timeout 600 \
       ./bin/gbrain dream --unsafe-bypass-lock --dry-run > /tmp/upgrade-dream.log 2>&1; then
    log "WARN: dream --dry-run timed out or errored (exit $?). Tail:"
    tail -20 /tmp/upgrade-dream.log
  else
    tail -5 /tmp/upgrade-dream.log
  fi
}

health_check() {
  sleep 5
  log "health check..."
  if curl -fs http://localhost:3132/health >/tmp/upgrade-health.json 2>&1; then
    cat /tmp/upgrade-health.json
    echo
  else
    log "WARN: serve not responding on :3132"
    return 1
  fi
}

# ---- resume path ----
if [ "$MODE" = "resume" ]; then
  if [ -d "$REPO_DIR/.git/rebase-merge" ] || [ -d "$REPO_DIR/.git/rebase-apply" ]; then
    log "ERROR: rebase still in progress. Finish it (git rebase --continue) before --resume."
    exit 1
  fi
  build_and_migrate
  smoke_test
  start_jobs
  health_check
  log "DONE (resumed)."
  exit 0
fi

# ---- pre-flight ----
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "ERROR: dirty working tree. Stash, commit, or discard first."
  git status --short
  exit 1
fi

# Untracked files in tracked dirs block rebase. .gitignore should catch scratch,
# but anything that slipped through needs to move before we proceed.
BLOCK=$(git status --porcelain | awk '/^\?\? (src\/|skills\/|test\/|recipes\/|scripts\/)/{print $2}' || true)
if [ -n "$BLOCK" ]; then
  log "ERROR: untracked files in tracked dirs would block rebase:"
  echo "$BLOCK"
  log "Move them to ~/gbrain-backups/scratch/ or add to .gitignore, then retry."
  exit 1
fi

git fetch origin --tags --quiet
BEHIND=$(git rev-list --count HEAD..origin/master)
log "$BEHIND commits behind origin/master"
if [ "$BEHIND" -eq 0 ]; then
  log "already up to date. Nothing to do."
  exit 0
fi

# ---- snapshot ----
TAG="pre-upgrade-$DATE"
git tag "$TAG" HEAD
log "tagged $TAG"

if [ "$MODE" != "skip-backup" ]; then
  mkdir -p "$BACKUP_DIR"
  DUMP="$BACKUP_DIR/$TAG.sql.gz"
  log "pg_dump → $DUMP"
  DSN=$(python3 -c "import json; print(json.load(open('$HOME/.gbrain/config.json'))['database_url'])")
  pg_dump "$DSN" --no-owner --no-acl 2>/dev/null | gzip > "$DUMP"
  log "backup size: $(ls -lh "$DUMP" | awk '{print $5}')"
fi

# ---- the actual upgrade ----
stop_jobs

log "rebasing onto origin/master..."
if ! git rebase origin/master; then
  cat <<EOF

[upgrade] REBASE CONFLICT — manual resolution required.

To resolve:
  cd $REPO_DIR
  # Inspect conflicts:
  git status
  # Per-file decisions:
  #   take upstream (recommended for src/core/* unless you know what's there):
  #     git show :2:<file> > <file>; git add <file>
  #   take local incoming:
  #     git show :3:<file> > <file>; git add <file>
  #   manual edit:
  #     \$EDITOR <file>; git add <file>
  git rebase --continue

When the rebase finishes, re-run:
  $0 --resume

To bail out:
  git rebase --abort
  git reset --hard $TAG
EOF
  exit 2
fi

build_and_migrate
smoke_test
start_jobs
health_check

cat <<EOF

[upgrade] DONE.
  tag:       $TAG
  backup:    ${DUMP:-(skipped)}
  rollback:  git reset --hard $TAG  (then re-run launchctl bootstrap)
EOF
