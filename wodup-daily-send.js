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
  formatBody,
  assembleDM,
  sanitizeAssertions,
} = require('./wodup-formatter');
const { buildTip, dateSeed } = require('./wodup-tips');

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

// Read the daily bookings manifest written by book-all.js (runs/bookings-<date>.json)
// and return {kind, primaryTime} entries for `user` on `dateYmd`. Empty if no
// manifest or no entry for this user. Source-of-truth for users with
// schedule:null whose classes are booked dynamically.
function manifestClasses(user, dateYmd) {
  if (!user) return [];
  const file = path.join(__dirname, 'runs', `bookings-${dateYmd}.json`);
  if (!fs.existsSync(file)) return [];
  let m;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const entries = (m && m.bookings && m.bookings[user.id]) || [];
  return entries.map(e => ({ kind: e.kind, primaryTime: e.time }));
}

// Read the waitlist registry (runs/waitlist-registry.json) and return
// {kind, primaryTime} entries where `user` is actively waitlisted on dateYmd.
// Waitlisted users haven't secured a booking, but they still train if a slot
// opens — so they get the WOD too (Yash 2026-06-23).
function waitlistClasses(user, dateYmd) {
  if (!user) return [];
  const file = path.join(__dirname, 'runs', 'waitlist-registry.json');
  if (!fs.existsSync(file)) return [];
  let reg;
  try { reg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const watches = (reg && reg.watches) || [];
  return watches
    .filter(w => w && w.user === user.id && w.date === dateYmd && w.kind)
    .map(w => ({ kind: w.kind, primaryTime: w.time }));
}

// Merge static schedule + manifest + waitlist. Manifest wins on conflicts (it
// reflects reality). De-dupe on `${kind}|${time}`.
function classesFor(user, dateYmd) {
  const fromManifest = manifestClasses(user, dateYmd);
  const fromSchedule = scheduledClasses(user, dateYmd);
  const fromWaitlist = waitlistClasses(user, dateYmd);
  const seen = new Set();
  const out = [];
  for (const c of [...fromManifest, ...fromSchedule, ...fromWaitlist]) {
    if (!c || !c.kind) continue;
    const key = `${String(c.kind).toUpperCase()}|${c.primaryTime || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

async function sendTg(chatId, text, token, opts = {}) {
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (!opts.plain) body.parse_mode = 'Markdown';
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  const ok = r.ok && j && j.ok;
  // LLM-generated bodies/tips can contain unbalanced Markdown (`_ * [ ` `),
  // which legacy Markdown rejects with 400 "can't parse entities". Rather than
  // drop the night-before DM, resend once as plain text so the WOD still lands.
  if (!ok && !opts.plain && j && /can't parse entities/i.test(j.description || '')) {
    console.log(`  markdown parse failed, retrying plain text for ${chatId}`);
    return sendTg(chatId, text, token, { plain: true });
  }
  return { ok, status: r.status, body: j };
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
  const tipByKind = {};

  for (const user of users) {
    if (!user.telegramChatId) {
      console.log(`skip ${user.id}: no telegramChatId`);
      continue;
    }
    const classes = classesFor(user, dateYmd);
    if (classes.length === 0) {
      console.log(`skip ${user.id}: no class on ${dayOfWeekFor(dateYmd)} (no users.json schedule and no manifest entry)`);
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
        // Never skip on reformat failure: formatBody falls back to the cleaned
        // raw workout when claude-cli is down, so the DM still goes out.
        const { body, source } = formatBody(raw, kind);
        formattedByKind[kind] = body;
        console.log(`formatted ${kind} via ${source}`);
      }

      if (!tipByKind[kind]) {
        // Movement-specific daily coaching cue. LLM when available, curated
        // library fallback — never blocks the send.
        const { tip, source: tipSource } = buildTip(raw, kind, { genericIndex: dateSeed(dateYmd) });
        tipByKind[kind] = tip;
        console.log(`tip ${kind} via ${tipSource}: ${tip.slice(0, 80)}`);
      }

      const dm = assembleDM({
        dateYmd,
        kind,
        formattedBody: formattedByKind[kind],
        rawWorkoutForPacking: raw,
      }) + `\n\n💡 *Coach's cue:* _${tipByKind[kind]}_`;

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

  // Only mark completed when every booked (user, kind) pair has been sent.
  // If the gym hasn't posted a workout for kind X yet (e.g. FIT after 19:00),
  // we keep completed=false so the next launchd retry slot re-fetches and
  // sends the missing DM as soon as the workout is published. Pinned by
  // test-wodup.js: "isAllExpectedSent" suite.
  state.completed = isAllExpectedSent(state, users, dateYmd);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  if (state.completed) {
    console.log(`state written: ${stateFile} (completed=true)`);
  } else {
    console.log(`state written: ${stateFile} (completed=false — missing workout(s), later cron will retry)`);
  }
}

// True only if every booked user has a sentTo entry for every kind they're
// booked for on dateYmd. Used to gate state.completed so launchd retries
// keep running until all DMs land.
function isAllExpectedSent(state, users, dateYmd) {
  for (const user of users) {
    if (!user || !user.telegramChatId) continue;
    const classes = classesFor(user, dateYmd);
    if (classes.length === 0) continue;
    for (const cls of classes) {
      const kind = (cls.kind || '').toUpperCase();
      if (!kind) continue;
      const sent = state && state.sentTo && state.sentTo[user.id] && state.sentTo[user.id][kind];
      if (!sent) return false;
    }
  }
  return true;
}

// Export the resolution helpers so the test suite can exercise the
// schedule-vs-manifest precedence without spawning the full sender.
module.exports = { scheduledClasses, manifestClasses, waitlistClasses, classesFor, dayOfWeekFor, isAllExpectedSent };

if (require.main === module) {
  main().catch(e => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}
