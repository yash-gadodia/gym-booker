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
  echo "args: ${BOOK_ARGS:-}"
  /opt/homebrew/bin/node "$HOME/gym-booker/book.js" ${BOOK_ARGS:-}
  echo "=== exit $? $(date) ==="
} >>"$LOG" 2>&1
