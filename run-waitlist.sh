#!/bin/bash
# LaunchAgent wrapper for waitlist watcher.
# Polls a target class every 5 min. Auto-unloads when alert fires or class starts.

set -e

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export TZ="Asia/Singapore"
export HOME="/Users/yash"

WATCH_DATE="${WAITLIST_DATE:-2026-05-07}"
WATCH_TIME="${WAITLIST_TIME:-6:30am}"

# Recipient(s) for the alert: Dani (80151943). Override TELEGRAM_CHAT_ID
# so the alert routes to her instead of Yash. Comma-separated supported.
export TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-80151943}"
export WAITLIST_NAME="${WAITLIST_NAME:-Dani}"

# Use Dani's auth so the API status reflects what *she* would see (Yash's
# auth would return "Booked" for this class, masking the public capacity).
export WAITLIST_USER="${WAITLIST_USER:-dani}"

WATCH_ID="${WATCH_DATE}_${WATCH_TIME/:/}"
PLIST="${HOME}/Library/LaunchAgents/com.voltade.gym-waitlist.plist"
STATE_FILE="${HOME}/gym-booker/runs/waitlist-state-${WATCH_ID}.json"
LOG_FILE="${HOME}/gym-booker/runs/waitlist-launchd.log"

cd "${HOME}/gym-booker"

ts() { date '+%Y-%m-%d %H:%M:%S %Z'; }

echo "[$(ts)] === waitlist poll fire (${WATCH_DATE} ${WATCH_TIME}) ===" >> "$LOG_FILE"

# Run the watcher; capture exit
node waitlist-watch.js "$WATCH_DATE" "$WATCH_TIME" >> "$LOG_FILE" 2>&1 || true

# Self-unload if alert fired OR class start time has passed
if [ -f "$STATE_FILE" ]; then
  ALERTED=$(node -e "try { console.log(JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')).alerted ? '1' : '0'); } catch { console.log('0'); }")
  if [ "$ALERTED" = "1" ]; then
    echo "[$(ts)] alert fired — unloading LaunchAgent" >> "$LOG_FILE"
    launchctl unload "$PLIST" 2>>"$LOG_FILE" || true
    exit 0
  fi
fi

# Auto-unload after the class start time has passed (no point polling then)
NOW_EPOCH=$(date +%s)
TARGET_EPOCH=$(TZ=Asia/Singapore date -j -f "%Y-%m-%d %H:%M" "${WATCH_DATE} 06:30" +%s 2>/dev/null || echo "0")
if [ "$TARGET_EPOCH" != "0" ] && [ "$NOW_EPOCH" -ge "$TARGET_EPOCH" ]; then
  echo "[$(ts)] past class start — unloading LaunchAgent" >> "$LOG_FILE"
  launchctl unload "$PLIST" 2>>"$LOG_FILE" || true
fi
