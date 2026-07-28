// Proactive gym-booker auth health probe (added 2026-07-27).
//
// Why: on 27-07 Dani's Mindbody account silently became Google-SSO linked
// (MindBody-side; her password had worked the day before). The ONLY signal was
// the booker failing at 08:40 on booking day — ~20min before the 09:00 window,
// far too late to fix an account-side problem. This runs the read-only e2e
// probe the EVENING BEFORE and DMs Yash the moment any user's login is broken,
// with the specific reason + fix, so there are ~12h to act (disconnect Google,
// re-add creds, etc.) before a booking is actually missed.
//
// Runs `node e2e-check.js --all --json`, parses per-user status, and alerts on
// any not-ok user, plus a one-time "recovered" note when a previously-broken
// user goes green. Best-effort: probe/DM failure never throws.
//
// 2026-07-28 — why the dedup + routing were rebuilt. On 27-07 this probe did
// its job: it caught dani:SSO_GOOGLE at 11:19 SGT and DM'd Yash. Then the 21:00
// evening probe — the ONE run whose entire purpose is "warn ~12h before booking
// day" — found her still broken and stayed SILENT, because a 20h fixed re-alert
// window had already been spent 9.9h earlier. The dedup muted precisely the
// alert that mattered, and Dani missed FIT @ 6:30am Thu 30-07. Two changes:
//   1. Dedup is keyed on the BOOKING DAY being protected, not on wall-clock.
//      Each booking day gets at most one warning per (user, reason) — bounded,
//      not spammy, and structurally impossible to mute the eve-of-booking run.
//   2. The affected USER is DM'd too, not just Yash. It is their account and
//      only they can disconnect an SSO link; Yash cannot fix it for them.
//      (27-07: Dani was never told at all and found out by missing a class.)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadUsers } = require('./users');
const { resolveBookingsForDate, loadOverrides } = require('./lib');

const DIR = __dirname;
const STATE = path.join(DIR, 'runs', 'auth-health-state.json');
const SECRETS = path.join(os.homedir(), '.openclaw/credentials/secrets.json');
const YASH = '166637821';

const FIX = {
  SSO_GOOGLE: 'account is Google-linked — in Mindbody tap "Disconnect here" on the Continue-with-Google screen (password stays, no reset needed).',
  SSO_FACEBOOK: 'account is Facebook-linked — disconnect it in Mindbody to restore password login.',
  SSO_APPLE: 'account is Apple-linked — disconnect it in Mindbody to restore password login.',
  CREDS_MISSING: 'Mindbody creds missing from keychain — re-run migrate-creds-to-keychain.js / re-add.',
  LOGIN_FAILED: 'login failed (password rejected or page changed) — check the account manually.',
};

// What the affected user is told. Plain language, no system internals, and it
// always ends in a concrete action THEY can take (per the "users get the
// technical reason + what to do" rule). Yash's copy stays terse/ops-flavoured.
const USER_FIX = {
  SSO_GOOGLE:
    'Mindbody now only lets your account sign in with Google, so the booker (which signs in with your email + password) gets locked out.\n\n' +
    'One-time fix, ~30 seconds:\n' +
    '1. Go to mindbodyonline.com and hit Log in\n' +
    '2. Enter your email, tap Continue\n' +
    '3. On the "Google Account" screen, tap *Disconnect here* (under "Prefer not to sign-in with Google?")\n' +
    '4. Sign in with your normal password once to confirm\n\n' +
    'Your password does not change and nothing else about your account changes — it just stops forcing the Google-only route.',
  SSO_FACEBOOK: 'Mindbody now only lets your account sign in with Facebook. Log in at mindbodyonline.com, enter your email, then tap "Disconnect here" on the Facebook screen and sign in with your password once.',
  SSO_APPLE: 'Mindbody now only lets your account sign in with Apple. Log in at mindbodyonline.com, enter your email, then tap "Disconnect here" on the Apple screen and sign in with your password once.',
  CREDS_MISSING: "I don't have your Mindbody login saved any more, so I can't book for you. Send me your Mindbody email + password and I'll re-add them securely.",
  LOGIN_FAILED: "Mindbody is rejecting your saved password, so I can't sign in to book for you. If you changed it recently, send me the new one and I'll update it.",
};

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(path.join(DIR, 'runs', 'auth-health.log'), line); } catch {}
  process.stderr.write(line);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch {}
}

function dm(chatId, text, who) {
  let token;
  try { token = JSON.parse(fs.readFileSync(SECRETS, 'utf8')).telegram_botToken_happy; } catch {}
  if (!token) { log('DM skipped: happy token missing'); return false; }
  try {
    execFileSync('curl', ['-fsS', `https://api.telegram.org/bot${token}/sendMessage`,
      '-d', `chat_id=${chatId}`, '--data-urlencode', `text=${text}`], { timeout: 15000 });
    log(`DM sent to ${who || chatId}`);
    return true;
  } catch (e) { log(`DM to ${who || chatId} failed: ` + (e.message || e)); return false; }
}
const dmYash = (text) => dm(YASH, text, 'Yash');

// Does this user actually have a class booked-for on the probed day? Drives the
// urgency wording — "you lose a class tomorrow" reads very differently from
// "your login is stale". Never throws; unknown → treated as "has a class" so we
// over-warn rather than under-warn.
function classesOn(userId, targetYmd) {
  try {
    const u = loadUsers().find(x => x.id === userId);
    if (!u) return null;
    const overrides = loadOverrides(path.join(DIR, 'overrides.json'));
    // Returns { plans: [...] } or { skip: 'paused'|'date_skip'|'opt_out_day' }.
    const res = resolveBookingsForDate(new Date(`${targetYmd}T12:00:00+08:00`), userId, u.schedule, overrides);
    if (!res || res.skip || !Array.isArray(res.plans)) return [];
    return res.plans.map(p => `${p.kind} @ ${p.primaryTime}`);
  } catch (e) { log(`classesOn(${userId}) failed: ${e.message}`); return null; }
}

function runProbe() {
  // e2e-check exits 1 when any user is not-ok; execFileSync throws on non-zero
  // but still gives us stdout, so read it either way.
  try {
    return execFileSync('node', ['e2e-check.js', '--all', '--json'], { cwd: DIR, timeout: 300000 }).toString();
  } catch (e) {
    if (e.stdout) return e.stdout.toString();
    throw e;
  }
}

(function main() {
  let parsed;
  try {
    const out = runProbe();
    const line = out.trim().split('\n').filter(Boolean).pop();
    parsed = JSON.parse(line);
  } catch (e) {
    log('probe failed to produce JSON: ' + (e.message || e));
    dmYash(`⚠️ gym auth-health probe itself failed to run (${String(e.message || e).slice(0, 120)}). Booker auth is UNVERIFIED for tomorrow — check manually.`);
    process.exit(1);
  }

  const state = loadState();
  const now = Date.now();
  const broken = parsed.results.filter(r => !r.ok);
  const brokenIds = new Set(broken.map(r => r.id));
  const alerts = [];

  for (const r of broken) {
    const reason = r.reason || 'LOGIN_FAILED';
    // Dedup key includes the booking day this probe is protecting. A new
    // booking day is always a new key, so every day's eve-of-booking run gets
    // through exactly once no matter when earlier alerts fired. This is what
    // the old wall-clock REALERT_MS window got wrong (see header).
    const key = `${r.id}:${reason}:${parsed.target}`;
    const prev = state[r.id];
    const fresh = !prev || prev.key !== key;
    const classes = classesOn(r.id, parsed.target);
    const hasClass = classes === null || classes.length > 0;

    if (fresh) {
      const clsLabel = classes && classes.length ? classes.join(' + ')
        : classes === null ? 'schedule unknown' : 'no class scheduled';
      alerts.push(`• ${r.id} — ${clsLabel} on ${parsed.target}${hasClass ? '' : ' (no booking at risk)'}\n  ${FIX[reason] || r.note || reason}`);

      // Tell the user directly — it is their account, and for SSO_* only they
      // can fix it. Silence here is what turned a caught problem into a missed
      // class on 27-07.
      const u = loadUsers().find(x => x.id === r.id);
      const chatId = u && u.telegramChatId;
      if (!chatId) {
        log(`user ${r.id} has no telegramChatId — cannot warn them directly`);
      } else if (!hasClass) {
        log(`user ${r.id} broken but no class on ${parsed.target} — Yash-only, not DMing user`);
      } else {
        const sent = dm(chatId,
          `Heads up ${u.label || r.id} 🙏\n\n` +
          `I can't sign in to Mindbody as you right now, so I won't be able to book ` +
          `${classes && classes.length ? classes.join(' + ') : 'your class'} on ${parsed.target} tomorrow morning.\n\n` +
          `${USER_FIX[reason] || FIX[reason] || reason}\n\n` +
          `Do that before tonight and tomorrow's 9am booking runs as normal. Shout if you want me to walk you through it.`,
          r.id);
        if (!sent) alerts.push(`  ⚠️ could not DM ${r.id} — tell them manually`);
      }
    }
    state[r.id] = { key, reason, lastAlert: fresh ? now : (prev ? prev.lastAlert : now) };
  }

  // Recovery notes: a user that was broken and is now ok.
  const recovered = [];
  for (const id of Object.keys(state)) {
    if (!brokenIds.has(id) && state[id] && state[id].reason) {
      recovered.push(id);
      delete state[id];
    }
  }

  if (alerts.length) {
    dmYash(`🔐 Gym booker auth needs attention (booking day ${parsed.target}):\n\n${alerts.join('\n')}\n\nThe affected user has been DM'd the fix directly. Fix before tomorrow morning or that user misses their booking.`);
  }
  if (recovered.length) {
    dmYash(`✅ Gym booker auth recovered for: ${recovered.join(', ')}.`);
  }
  saveState(state);
  log(`probe done: ${parsed.results.length} users, ${broken.length} broken, ${alerts.length} alerted, ${recovered.length} recovered`);
  process.exit(0);
})();
