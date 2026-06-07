#!/bin/bash
# LaunchAgent wrapper for the multi-watch registry runner.
# Polls every active entry in runs/waitlist-registry.json (auto-enrolled by
# book-all on failed bookings). Persistent: it does NOT self-unload — entries
# retire themselves as classes start or users get in. Additive to, and
# independent of, the single-target run-waitlist.sh.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export TZ="Asia/Singapore"
export HOME="/Users/yash"

cd "${HOME}/gym-booker"
LOG_FILE="${HOME}/gym-booker/runs/waitlist-registry-launchd.log"

ts() { date '+%Y-%m-%d %H:%M:%S %Z'; }
echo "[$(ts)] === registry poll fire ===" >> "$LOG_FILE"

node waitlist-registry.js >> "$LOG_FILE" 2>&1 || echo "[$(ts)] runner exited non-zero" >> "$LOG_FILE"
