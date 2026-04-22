# gym-booker

Auto-books Ragtag CrossFit classes at 09:00:00.000 SGT daily — 2 days in advance.

## Schedule

| Run day (09:00 SGT) | Target day | Class |
|---|---|---|
| Mon–Fri | today + 2 | 6:30am CROSSFIT® FIT (fallback 7:30am) |
| Sat | Mon | 6:30am FIT |
| Sun | Tue | 6:30am FIT |
| Thu | Sat | 12:30pm CROSSFIT® Gymnastics |
| Fri | Sun | 1:00pm CROSSFIT® Gymnastics |

## Stack

- Node + Playwright (headless Chromium, persisted session via `auth.json`)
- launchd LaunchAgent fires `run-daily.sh` at 08:57 SGT; script busy-waits to 09:00:00.000 exact
- Telegram Bot API (raw fetch) for ✅/❌ DMs via Lawrence bot
- Auth self-healing: if session expired, re-logs in using `MINDBODY_EMAIL` / `MINDBODY_PASSWORD` and saves fresh `auth.json`

## Files

- `book.js` — main booking flow
- `lib.js` — pure logic (classPlan, rowMatches, rowStatus, date helpers)
- `test.js` — `node --test` unit tests (23 cases)
- `run-daily.sh` — launchd wrapper
- `recon.js` — one-off login generator for `auth.json`
- `schedule_recon.js` — dumps live schedule state for debugging
- `~/Library/LaunchAgents/com.voltade.gym-booker.plist` — scheduler

## Setup (fresh machine)

```sh
npm install
npx playwright install chromium
cp .env.example .env   # fill in creds
node recon.js          # generates auth.json via live login
node book.js --dry-run --now   # smoke test
launchctl load ~/Library/LaunchAgents/com.voltade.gym-booker.plist
```

## Env vars

```
MINDBODY_EMAIL=...
MINDBODY_PASSWORD=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

## Operate

```sh
npm test                              # unit tests
node book.js --dry-run --now          # pre-stage only, no click
node book.js 2026-04-30               # target a specific date
launchctl kickstart -k gui/$(id -u)/com.voltade.gym-booker   # trigger now via launchd
```

Per-run logs + screenshots land in `runs/<ISO-timestamp>/`.
