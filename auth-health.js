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
// any not-ok user. Deduped: one alert per (user, reason) per ~20h so it doesn't
// spam daily for a known-broken account, and a one-time "recovered" note when a
// previously-broken user goes green. Best-effort: probe/DM failure never throws.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = __dirname;
const STATE = path.join(DIR, 'runs', 'auth-health-state.json');
const REALERT_MS = 20 * 3600 * 1000; // ~once/day per broken user
const SECRETS = path.join(os.homedir(), '.openclaw/credentials/secrets.json');
const YASH = '166637821';

const FIX = {
  SSO_GOOGLE: 'account is Google-linked — in Mindbody tap "Disconnect here" on the Continue-with-Google screen (password stays, no reset needed).',
  SSO_FACEBOOK: 'account is Facebook-linked — disconnect it in Mindbody to restore password login.',
  SSO_APPLE: 'account is Apple-linked — disconnect it in Mindbody to restore password login.',
  CREDS_MISSING: 'Mindbody creds missing from keychain — re-run migrate-creds-to-keychain.js / re-add.',
  LOGIN_FAILED: 'login failed (password rejected or page changed) — check the account manually.',
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

function dmYash(text) {
  let token;
  try { token = JSON.parse(fs.readFileSync(SECRETS, 'utf8')).telegram_botToken_happy; } catch {}
  if (!token) { log('DM skipped: happy token missing'); return; }
  try {
    execFileSync('curl', ['-fsS', `https://api.telegram.org/bot${token}/sendMessage`,
      '-d', `chat_id=${YASH}`, '--data-urlencode', `text=${text}`], { timeout: 15000 });
    log('DM sent to Yash');
  } catch (e) { log('DM failed: ' + (e.message || e)); }
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
    const key = `${r.id}:${reason}`;
    const prev = state[r.id];
    const fresh = !prev || prev.key !== key || (now - (prev.lastAlert || 0)) > REALERT_MS;
    if (fresh) {
      alerts.push(`• ${r.id} (booking day ${parsed.target}): ${FIX[reason] || r.note || reason}`);
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
    dmYash(`🔐 Gym booker auth needs attention (probed ${parsed.target}, ~before the 08:40 run):\n\n${alerts.join('\n')}\n\nFix before tomorrow morning or that user misses their booking.`);
  }
  if (recovered.length) {
    dmYash(`✅ Gym booker auth recovered for: ${recovered.join(', ')}.`);
  }
  saveState(state);
  log(`probe done: ${parsed.results.length} users, ${broken.length} broken, ${alerts.length} alerted, ${recovered.length} recovered`);
  process.exit(0);
})();
