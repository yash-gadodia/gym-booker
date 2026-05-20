#!/bin/bash
# Send Wodup workout DMs 24 hours before each booked class.
# Runs daily at 19:00 SGT — 24h+ before morning classes, after most WOD posts.
# Idempotent via state file.

set -euo pipefail

# Get SGT date (tomorrow) — the date users have classes booked
# macOS date requires custom format; SGT is UTC+8
TOMORROW_SGT=$(TZ=Asia/Singapore date -d '+1 day' '+%Y-%m-%d' 2>/dev/null || date -v+1d '+%Y-%m-%d')

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNS_DIR="$REPO_DIR/runs"
STATE_FILE="$RUNS_DIR/wodup-dm-$TOMORROW_SGT.json"
LOG_FILE="$RUNS_DIR/wodup-daily-$(date '+%Y-%m-%d_%H-%M-%S').log"

mkdir -p "$RUNS_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=== Wodup workout DM cron ==="
echo "Tomorrow (SGT): $TOMORROW_SGT"
echo "State file: $STATE_FILE"
echo "Log file: $LOG_FILE"

# Check if we've already sent DMsto everyone for this date
if [[ -f "$STATE_FILE" ]]; then
  echo "State file exists, checking if complete..."
  COMPLETED=$(jq -r '.completed // false' "$STATE_FILE" 2>/dev/null || echo 'false')
  if [[ "$COMPLETED" == "true" ]]; then
    echo "Already sent all DMsfor $TOMORROW_SGT. Exiting."
    exit 0
  fi
fi

# Fetch workouts for tomorrow
echo "Fetching workouts from Wodup for $TOMORROW_SGT..."
node "$REPO_DIR/wodup-daily-fetch.js" "$TOMORROW_SGT" 2>&1 || {
  echo "ERROR: wodup-daily-fetch.js failed"
  exit 1
}

# Send DMswith the workouts
echo "Sending DMs..."
node "$REPO_DIR/wodup-daily-send.js" "$TOMORROW_SGT" "$STATE_FILE" 2>&1 || {
  echo "ERROR: wodup-daily-send.js failed"
  exit 1
}

echo "=== Done ==="
