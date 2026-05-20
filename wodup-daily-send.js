// Send Wodup workout DMs to users with a class scheduled on target date.
// Usage: node wodup-daily-send.js YYYY-MM-DD STATE_FILE
//
// Filter: a user gets DMs only if users.json `schedule[<DayOfWeek>]` has at
// least one entry on the target date. Each scheduled class kind produces its
// own DM (per-class format works better than bundling on a phone screen).
//
// DM layout: see wodup-formatter.js.
//
// Idempotent: STATE_FILE tracks `sentTo[userId][kind]`. Re-runs skip
// already-sent (user, kind) pairs.
//
// CC: every DM to a non-Yash user also goes to Yash (166637821) with
//     "[<Label>] " prefix, per feedback_always_dm_yash_on_broadcasts.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { loadUsers } = require('./users');
const {
  DOW_SHORT,
  reformatBodyViaClaude,
  assembleDM,
  sanitizeAssertions,
} = require('./wodup-formatter');

const YASH_CHAT_ID = 166637821;

function dayOfWeekFor(dateYmd) {
  const d = new Date(`${dateYmd}T00:00:00+08:00`);
  return DOW_SHORT[d.getDay()];
}

// Inspect users.json schedule. Returns array of {kind, primaryTime} the user
// has booked on dateYmd, or [] if none.
function scheduledClasses(user, dateYmd) {
  if (!user || !user.schedule) return [];
  const dow = dayOfWeekFor(dateYmd);
  const day = user.schedule[dow];
  if (!day) return [];
  if (!Array.isArray(day)) return [day];
  return day;
}

async function sendTg(chatId, text, token) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
  const j = await r.json().catch(() => null);
  return { ok: r.ok && j && j.ok, status: r.status, body: j };
}

async function main() {
  const dateYmd = process.argv[2];
  const stateFile = process.argv[3];

  if (!dateYmd || !/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
    console.error('Usage: node wodup-daily-send.js YYYY-MM-DD STATE_FILE');
    process.exit(1);
  }
  if (!stateFile) {
    console.error('STATE_FILE required');
    process.exit(1);
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN not set');
    process.exit(1);
  }

  const workoutsFile = path.join(__dirname, 'runs', `.wodup-workouts-${dateYmd}.json`);
  if (!fs.existsSync(workoutsFile)) {
    console.error(`Workouts file not found: ${workoutsFile}`);
    process.exit(1);
  }
  const { workouts } = JSON.parse(fs.readFileSync(workoutsFile, 'utf8'));

  let state = { date: dateYmd, sentTo: {}, completed: false };
  if (fs.existsSync(stateFile)) {
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
    if (!state.sentTo) state.sentTo = {};
  }

  console.log(`target date: ${dateYmd} (${dayOfWeekFor(dateYmd)})`);
  console.log(`workouts available: ${Object.keys(workouts).join(', ') || '(none)'}`);
  console.log(`state.sentTo currently: ${JSON.stringify(state.sentTo)}`);

  const users = loadUsers();
  const formattedByKind = {};

  for (const user of users) {
    if (!user.telegramChatId) {
      console.log(`skip ${user.id}: no telegramChatId`);
      continue;
    }
    const classes = scheduledClasses(user, dateYmd);
    if (classes.length === 0) {
      console.log(`skip ${user.id}: no class scheduled on ${dayOfWeekFor(dateYmd)}`);
      continue;
    }

    if (!state.sentTo[user.id]) state.sentTo[user.id] = {};
    if (typeof state.sentTo[user.id] !== 'object' || state.sentTo[user.id] === null) {
      state.sentTo[user.id] = {};
    }
    // Legacy state format (v1) stored `sentTo[user] = {timestamp, kind}` flat.
    // Migrate to `sentTo[user][kind] = {timestamp, ...}`.
    if (state.sentTo[user.id].timestamp && state.sentTo[user.id].kind) {
      const legacy = state.sentTo[user.id];
      state.sentTo[user.id] = {};
      state.sentTo[user.id][legacy.kind] = { timestamp: legacy.timestamp, legacy: true };
    }

    for (const cls of classes) {
      const kind = (cls.kind || '').toUpperCase();
      if (!kind) continue;

      if (state.sentTo[user.id][kind]) {
        console.log(`skip ${user.id}/${kind}: already sent at ${state.sentTo[user.id][kind].timestamp}`);
        continue;
      }

      const raw = workouts[kind];
      if (!raw) {
        console.log(`skip ${user.id}/${kind}: no Wodup workout for kind ${kind}`);
        continue;
      }

      if (!formattedByKind[kind]) {
        console.log(`reformatting ${kind} via claude-cli ...`);
        try {
          formattedByKind[kind] = reformatBodyViaClaude(raw, kind);
        } catch (e) {
          console.error(`claude reformat failed for ${kind}: ${e.message}`);
          continue;
        }
      }

      const dm = assembleDM({
        dateYmd,
        kind,
        formattedBody: formattedByKind[kind],
        rawWorkoutForPacking: raw,
      });

      const issues = sanitizeAssertions(dm);
      if (issues.length) {
        console.error(`DM for ${user.id}/${kind} has issues: ${issues.join(', ')}`);
      }

      console.log(`sending ${kind} (${dm.length} chars) to ${user.label} (${user.telegramChatId}) ...`);
      const userResp = await sendTg(user.telegramChatId, dm, token);
      if (!userResp.ok) {
        console.error(`TG send failed for ${user.id}/${kind}: status=${userResp.status} body=${JSON.stringify(userResp.body)}`);
        continue;
      }

      // No Yash CC on per-user workout DMs (Yash 2026-05-20: "too spammy").
      // Yash gets his own workout DM when he has a booked class.

      state.sentTo[user.id][kind] = {
        timestamp: new Date().toISOString(),
        time: cls.primaryTime || null,
        messageId: userResp.body && userResp.body.result && userResp.body.result.message_id,
      };
      console.log(`sent ${user.id}/${kind} message_id=${state.sentTo[user.id][kind].messageId}`);
    }
  }

  state.completed = true;
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.log(`state written: ${stateFile}`);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
