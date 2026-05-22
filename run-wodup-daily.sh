#!/bin/bash
# Send Wodup workout DMs ~12-17h before each booked class.
# Runs daily at 19:00 SGT — covers tomorrow's morning and lunch classes.
# Idempotent via state file. Logs from line 1; DMs Yash on any failure.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNS_DIR="$REPO_DIR/runs"
mkdir -p "$RUNS_DIR"

# Open the log BEFORE any other commands so early-exit failures still leave
# evidence. The previous version did date math + sourcing before exec>tee,
# which meant if set -e fired early the launchd run vanished silently.
LOG_FILE="$RUNS_DIR/wodup-daily-$(date '+%Y-%m-%d_%H-%M-%S').log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=== wodup-daily $(date) ==="
echo "log: $LOG_FILE"
echo "pwd: $REPO_DIR"

# DM-on-failure trap: any non-zero exit pings Yash so a silent cron drop
# doesn't go unnoticed for days (which is exactly how this bug was spotted).
# Reads TG creds from .env (loaded after this trap is wired).
yash_dm_on_fail() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    if [[ -f "$REPO_DIR/.env" ]]; then
      # shellcheck disable=SC1091
      set +u; source "$REPO_DIR/.env"; set -u
    fi
    if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
      local tail
      tail=$(tail -20 "$LOG_FILE" 2>/dev/null | sed 's/[`"]/_/g' | tr '\n' ' ')
      curl -sS -m 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -H 'content-type: application/json' \
        -d "{\"chat_id\":166637821,\"text\":\"WOD cron FAIL (rc=$rc): $tail\"}" \
        >/dev/null || true
    fi
  fi
}
trap yash_dm_on_fail EXIT

# Compute tomorrow's date (SGT). GNU date (`-d`) does not exist on macOS, so
# the BSD `-v+1d` is the real path here. Wrap in `set +e` so a missing date
# binary doesn't kill the script before we get a chance to log the failure.
set +e
TOMORROW_SGT=$(TZ=Asia/Singapore date -v+1d '+%Y-%m-%d' 2>/dev/null)
if [[ -z "${TOMORROW_SGT:-}" ]]; then
  TOMORROW_SGT=$(date -v+1d '+%Y-%m-%d' 2>/dev/null)
fi
set -e

if [[ -z "${TOMORROW_SGT:-}" ]]; then
  echo "FATAL: could not compute tomorrow's date"
  exit 1
fi

STATE_FILE="$RUNS_DIR/wodup-dm-$TOMORROW_SGT.json"
echo "tomorrow (SGT): $TOMORROW_SGT"
echo "state file: $STATE_FILE"

if [[ -f "$STATE_FILE" ]]; then
  COMPLETED=$(jq -r '.completed // false' "$STATE_FILE" 2>/dev/null || echo false)
  if [[ "$COMPLETED" == "true" ]]; then
    echo "already sent for $TOMORROW_SGT, exiting clean"
    exit 0
  fi
fi

echo "fetching workouts..."
node "$REPO_DIR/wodup-daily-fetch.js" "$TOMORROW_SGT" 2>&1 || {
  echo "ERROR: wodup-daily-fetch.js failed"
  exit 1
}

echo "sending DMs..."
node "$REPO_DIR/wodup-daily-send.js" "$TOMORROW_SGT" "$STATE_FILE" 2>&1 || {
  echo "ERROR: wodup-daily-send.js failed"
  exit 1
}

echo "=== done $(date) ==="
