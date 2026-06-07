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

# Use the watched user's auth so the API status reflects what *they* would see
# (Yash's auth would return "Booked" for this class, masking public capacity).
export WAITLIST_USER="${WAITLIST_USER:-dani}"

# Greeting name: derive from the watched user's label in users.json. An empty
# WAITLIST_NAME used to fall back to a hardcoded "Dani", mislabeling every other
# user's watch (Geraldine's 7:30 alert showed up addressed to "Dani").
if [ -z "${WAITLIST_NAME:-}" ]; then
  export WAITLIST_NAME="$(node -e "try{const u=require('$HOME/gym-booker/users.json').users;const m=u.find(x=>x.id===process.env.WAITLIST_USER);process.stdout.write((m&&m.label)?m.label:'');}catch(e){process.stdout.write('');}")"
fi

# Mirror waitlist-watch.js: per-user state id when WAITLIST_USER is set, so two
# users watching the same slot don't share (and clobber) one state file.
if [ -n "${WAITLIST_USER:-}" ]; then
  WATCH_ID="${WATCH_DATE}_${WATCH_TIME/:/}-${WAITLIST_USER}"
else
  WATCH_ID="${WATCH_DATE}_${WATCH_TIME/:/}"
fi
# Each instance self-unloads its OWN plist. Defaults to the original single-watcher
# label for back-compat; multi-slot plists pass WAITLIST_PLIST_LABEL.
PLIST_LABEL="${WAITLIST_PLIST_LABEL:-com.voltade.gym-waitlist}"
PLIST="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"
STATE_FILE="${HOME}/gym-booker/runs/waitlist-state-${WATCH_ID}.json"
LOG_FILE="${HOME}/gym-booker/runs/waitlist-launchd.log"

cd "${HOME}/gym-booker"

ts() { date '+%Y-%m-%d %H:%M:%S %Z'; }

echo "[$(ts)] === waitlist poll fire (${WATCH_DATE} ${WATCH_TIME}) ===" >> "$LOG_FILE"

# Run the watcher; capture exit
node waitlist-watch.js "$WATCH_DATE" "$WATCH_TIME" >> "$LOG_FILE" 2>&1 || true

# Self-unload when user is booked (manually or via Mindbody auto-promote).
# v3 (2026-05-20): no longer unloads on first alert. We DM every poll while
# the slot is open and only stop when the user takes action (or the class
# starts). State field is `userBooked`; legacy `promoted`/`alerted` honored.
if [ -f "$STATE_FILE" ]; then
  USER_BOOKED=$(node -e "try { const s = JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')); console.log((s.userBooked || s.promoted) ? '1' : '0'); } catch { console.log('0'); }")
  if [ "$USER_BOOKED" = "1" ]; then
    echo "[$(ts)] user booked . unloading LaunchAgent" >> "$LOG_FILE"
    launchctl unload "$PLIST" 2>>"$LOG_FILE" || true
    exit 0
  fi
fi

# Auto-unload after the class start time has passed (no point polling then)
NOW_EPOCH=$(date +%s)
TIME_HHMM=$(node -e "const t='${WATCH_TIME}';const m=/^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(t);let h=+m[1];const mins=+m[2];const ap=m[3].toLowerCase();if(ap==='pm'&&h!==12)h+=12;if(ap==='am'&&h===12)h=0;console.log(String(h).padStart(2,'0')+':'+String(mins).padStart(2,'0'));" 2>/dev/null || echo "06:30")
TARGET_EPOCH=$(TZ=Asia/Singapore date -j -f "%Y-%m-%d %H:%M" "${WATCH_DATE} ${TIME_HHMM}" +%s 2>/dev/null || echo "0")
if [ "$TARGET_EPOCH" != "0" ] && [ "$NOW_EPOCH" -ge "$TARGET_EPOCH" ]; then
  echo "[$(ts)] past class start — unloading LaunchAgent" >> "$LOG_FILE"
  launchctl unload "$PLIST" 2>>"$LOG_FILE" || true
fi
