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

- `book.js` — main booking flow (single-user; accepts `--user <id>` for non-default profiles)
- `book-all.js` — fan-out: spawns Yash's legacy run + one parallel child per `users.json` entry
- `users.js` — loads `users.json`, resolves per-user creds / auth path / runs dir / TG target
- `users.json` — gitignored: per-user creds, schedules, telegram chat_ids
- `capture-chat-id.js` — onboarding: capture a new user's TG chat_id from `getUpdates`
- `lib.js` — pure logic (classPlan, resolveSchedule, rowMatches, rowStatus, date helpers)
- `test.js` — `node --test` unit tests
- `run-daily.sh` — launchd wrapper (calls `book-all.js`)
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

Per-run logs + screenshots land in `runs/<ISO-timestamp>/` (default user) or `runs/<id>/<ISO-timestamp>/` (per-user).

## Multi-user

The default flow (no flags) books for one person via `.env` + `auth.json` (Yash). Additional users live in a gitignored `users.json` and are picked up automatically by `book-all.js` (the LaunchAgent's entrypoint).

`users.json` shape:

```json
{
  "users": [
    {
      "id": "dani",
      "label": "Dani",
      "email": "dani@example.com",
      "password": "...",
      "telegramChatId": null,
      "telegramHandle": "danielleee",
      "schedule": null
    }
  ]
}
```

- `schedule: null` → use the same defaults as the legacy flow (Mon-Fri 6:30am FIT + 7:30am fallback, Sat 12:30pm Gym, Sun 1pm Gym).
- `schedule: { "Mon": { "kind": "FIT", "primaryTime": "7:30am", "fallback": null }, "Tue": null, ... }` → per-day override. `null` (or missing key) for a day = opt out, no booking attempted.
- `telegramChatId: null` → outcome alerts route to `TELEGRAM_CHAT_ID` (your env) with `[Label]` prefix until the user's chat_id is captured.

### Onboarding a new user

1. Have them open `https://t.me/Lawrence_sg_bot` and tap **Start** (or send any message).
2. `node capture-chat-id.js --username <their-handle>` (or `--watch` to poll until they DM).
3. Paste the printed `chat_id` into their `users.json` entry under `telegramChatId`.
4. Smoke test: `node book.js --user <id> --dry-run --now`. Confirms login works and a payment pass exists.
5. They're now part of the daily 09:00 fire — no further action needed.

### Operate (multi-user)

```sh
node book-all.js --dry-run --now              # parallel dry-run, all users
node book-all.js --only dani --dry-run --now  # dry-run one user
node book-all.js --skip yash                  # everyone except Yash (production-y)
node book.js --user dani --dry-run --now      # one user directly
```
