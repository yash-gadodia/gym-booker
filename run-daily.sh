#!/bin/bash
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export TZ="Asia/Singapore"
cd "$HOME/gym-booker" || exit 1

LOG_DIR="$HOME/gym-booker/runs"
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
LOG="$LOG_DIR/launchd-$STAMP.log"

{
  echo "=== launchd fire $(date) ==="
  echo "PATH=$PATH"
  echo "HOME=$HOME  TZ=$TZ  PWD=$(pwd)  node=$(command -v node)"
  echo "host: $(uptime) | disk: $(df -h /System/Volumes/Data | tail -1 | awk '{print $5" used, "$4" free"}')"
  echo "args: ${BOOK_ARGS:-}"
  # Self-heal missing deps — node_modules is gitignored and has been wiped from
  # under the cron (2026-06-20), which would silently miss everyone's bookings.
  if [ ! -d "$HOME/gym-booker/node_modules/playwright" ]; then
    echo "node_modules/playwright missing — running npm ci + playwright install"
    ( cd "$HOME/gym-booker" && npm ci && npx playwright install chromium )
  fi
  # caffeinate -i: keep host awake so macOS doesn't nap/throttle timers and push
  # the 09:00 fire late (see book.js spinWaitTo). Holds across the child node tree.
  /usr/bin/caffeinate -i /opt/homebrew/bin/node "$HOME/gym-booker/book-all.js" ${BOOK_ARGS:-}
  echo "=== exit $? $(date) ==="
} >>"$LOG" 2>&1
