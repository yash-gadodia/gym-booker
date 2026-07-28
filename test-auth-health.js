// Regression tests for the 2026-07-28 missed booking (Dani, FIT @ 6:30am Thu 30-07).
//
// The auth-health probe DID detect dani:SSO_GOOGLE on 27-07 at 11:19 SGT and
// DM'd Yash. The 21:00 evening probe then found her still broken and said
// NOTHING, because the old dedup was a 20h wall-clock window that had been
// spent 9.9h earlier. The one run whose whole job is "warn ~12h before booking
// day" muted itself. Dani was also never told at all — and for an SSO-linked
// account she is the ONLY person who can fix it.
//
// These tests pin both behaviours by driving the real state/dedup logic.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Run auth-health.js against a stubbed e2e-check + stubbed curl, in a scratch
// dir, and return { dms: [{chatId, text}], state }.
function runProbe({ probeJson, priorState }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-health-test-'));
  const runs = path.join(tmp, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const repo = __dirname;

  for (const f of ['auth-health.js', 'users.js', 'lib.js', 'keychain.js', 'users.json', 'overrides.json']) {
    fs.copyFileSync(path.join(repo, f), path.join(tmp, f));
  }
  if (priorState) fs.writeFileSync(path.join(runs, 'auth-health-state.json'), JSON.stringify(priorState));

  // Stub e2e-check.js: emit the canned probe result.
  fs.writeFileSync(path.join(tmp, 'e2e-check.js'),
    `process.stdout.write(${JSON.stringify(JSON.stringify(probeJson))} + '\\n'); process.exit(1);`);

  // Stub curl: append every send to dms.jsonl instead of hitting Telegram.
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const dmLog = path.join(tmp, 'dms.jsonl');
  fs.writeFileSync(path.join(bin, 'curl'),
    `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
let chatId = null, text = null;
for (let i = 0; i < a.length; i++) {
  if (a[i] === '-d' && /^chat_id=/.test(a[i + 1] || '')) chatId = a[i + 1].slice(8);
  if (a[i] === '--data-urlencode' && /^text=/.test(a[i + 1] || '')) text = a[i + 1].slice(5);
}
fs.appendFileSync(${JSON.stringify(dmLog)}, JSON.stringify({ chatId, text }) + '\\n');
`);
  fs.chmodSync(path.join(bin, 'curl'), 0o755);

  // A secrets file so the token lookup succeeds and DMs are actually attempted.
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.openclaw/credentials'), { recursive: true });
  fs.writeFileSync(path.join(home, '.openclaw/credentials/secrets.json'),
    JSON.stringify({ telegram_botToken_happy: 'TEST-TOKEN' }));

  try {
    execFileSync(process.execPath, ['auth-health.js'], {
      cwd: tmp,
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      timeout: 60000,
    });
  } catch { /* exit code is not what we assert on */ }

  const dms = fs.existsSync(dmLog)
    ? fs.readFileSync(dmLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  let state = {};
  try { state = JSON.parse(fs.readFileSync(path.join(runs, 'auth-health-state.json'), 'utf8')); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
  return { dms, state };
}

const BROKEN_DANI = (target) => ({
  target,
  ts: new Date().toISOString(),
  results: [
    { id: 'yash', ok: true, auth: 'cached-valid', bearer: 'ok', schedule: '16 classes' },
    { id: 'dani', ok: false, auth: 'LOGIN-FAILED', reason: 'SSO_GOOGLE', bearer: '?', schedule: '?', note: 'Mindbody account is GOOGLE-SSO linked' },
  ],
});

test('THE 27-07 BUG: a second probe for a NEW booking day still alerts', () => {
  // Prior state = "we already alerted for dani:SSO_GOOGLE", written minutes ago.
  // Under the old 20h wall-clock window this run went silent. It must not.
  const prior = { dani: { key: 'dani:SSO_GOOGLE:2026-07-29', reason: 'SSO_GOOGLE', lastAlert: Date.now() - 60 * 1000 } };
  const { dms } = runProbe({ probeJson: BROKEN_DANI('2026-07-30'), priorState: prior });
  assert.ok(dms.length > 0, 'evening probe for the next booking day must alert, not dedup into silence');
  assert.ok(dms.some(d => /auth needs attention/i.test(d.text || '')), 'Yash got the ops alert');
});

test('the affected USER is DM\'d directly with an actionable fix', () => {
  const { dms } = runProbe({ probeJson: BROKEN_DANI('2026-07-30'), priorState: null });
  const dani = dms.find(d => d.chatId === '80151943');
  assert.ok(dani, 'Dani herself was DM\'d — she is the only one who can unlink SSO');
  assert.match(dani.text, /Disconnect here/i, 'the DM names the exact control to tap');
  assert.match(dani.text, /mindbodyonline\.com/i, 'the DM says where to go');
  assert.ok(!/SSO_GOOGLE|e2e-check|LOGIN-FAILED/.test(dani.text), 'no system internals leaked to the user');
});

test('same booking day + same reason does NOT re-alert (no spam)', () => {
  const prior = { dani: { key: 'dani:SSO_GOOGLE:2026-07-30', reason: 'SSO_GOOGLE', lastAlert: Date.now() - 60 * 1000 } };
  const { dms } = runProbe({ probeJson: BROKEN_DANI('2026-07-30'), priorState: prior });
  assert.strictEqual(dms.length, 0, 'already warned for this booking day — stay quiet');
});

test('recovery is reported once and clears state', () => {
  const prior = { dani: { key: 'dani:SSO_GOOGLE:2026-07-30', reason: 'SSO_GOOGLE', lastAlert: Date.now() } };
  const allGood = {
    target: '2026-07-31', ts: new Date().toISOString(),
    results: [{ id: 'dani', ok: true, auth: 're-logged-in', bearer: 'ok', schedule: '16 classes' }],
  };
  const { dms, state } = runProbe({ probeJson: allGood, priorState: prior });
  assert.ok(dms.some(d => /recovered/i.test(d.text || '')), 'recovery announced');
  assert.ok(!state.dani, 'state cleared so the next break alerts fresh');
});

// --- dead-watch escalation (the 637 silent ERROR polls) -----------------

const { decideWatchErrorEscalation } = require('./lib');

test('a single transient ERROR poll stays silent', () => {
  assert.strictEqual(decideWatchErrorEscalation({ errorStreak: 1 }).alert, false);
  assert.strictEqual(decideWatchErrorEscalation({ errorStreak: 4 }).alert, false);
});

test('an established ERROR streak escalates once', () => {
  const d = decideWatchErrorEscalation({ errorStreak: 5 });
  assert.strictEqual(d.alert, true);
  assert.strictEqual(d.reason, 'first-escalation');
});

test('THE 637-POLL BUG: a long-dead watch never stays silent forever', () => {
  // 637 consecutive errors with no prior alert must page, not shrug.
  assert.strictEqual(decideWatchErrorEscalation({ errorStreak: 637 }).alert, true);
});

test('re-alerts back off exponentially and never spam at fixed interval', () => {
  const now = Date.now();
  const at = (minsAgo) => new Date(now - minsAgo * 60000).toISOString();
  // 1st backoff = 1h: 30min later is too soon, 61min is due.
  assert.strictEqual(decideWatchErrorEscalation({ errorStreak: 9, lastErrorAlertAt: at(30), errorAlertCount: 1, nowMs: now }).alert, false);
  assert.strictEqual(decideWatchErrorEscalation({ errorStreak: 9, lastErrorAlertAt: at(61), errorAlertCount: 1, nowMs: now }).alert, true);
  // 2nd backoff = 2h: 61min is now too soon.
  assert.strictEqual(decideWatchErrorEscalation({ errorStreak: 9, lastErrorAlertAt: at(61), errorAlertCount: 2, nowMs: now }).alert, false);
  assert.strictEqual(decideWatchErrorEscalation({ errorStreak: 9, lastErrorAlertAt: at(121), errorAlertCount: 2, nowMs: now }).alert, true);
});

test('backoff caps at 24h', () => {
  const now = Date.now();
  const d = decideWatchErrorEscalation({ errorStreak: 99, lastErrorAlertAt: new Date(now - 25 * 3600000).toISOString(), errorAlertCount: 20, nowMs: now });
  assert.strictEqual(d.backoffMs, 24 * 3600000, 'never backs off beyond a day');
  assert.strictEqual(d.alert, true);
});

// --- the probed day must be the day the NEXT booker run fills ---------------
//
// Found 28-07 while stress-testing durability. The booker runs 08:40 SGT and
// targets day+2. auth-health runs 21:00 SGT, and e2e-check's own default is
// "day+2 from now" — at 21:00 that is the day BEFORE what tomorrow morning's
// run books. Gating the eve-of-booking warning on that off-by-one day would
// silently skip any user with no class on D+2 but a class on D+3: the exact
// miss this alerting path exists to prevent.

const { nextBookingTargetYmd } = require('./lib');
const sgt = (iso) => new Date(iso).getTime(); // iso carries +08:00

test('THE OFF-BY-ONE: 21:00 evening probe targets what TOMORROW morning books', () => {
  // 21:00 SGT Tue 28-07 → next run is Wed 29-07 08:40 → it books Fri 31-07.
  assert.strictEqual(nextBookingTargetYmd(sgt('2026-07-28T21:00:00+08:00')), '2026-07-31');
});

test('before the 08:40 run, the target is TODAY\'s run (+2)', () => {
  // 07:00 SGT Wed 29-07 → today's 08:40 run has not fired yet → books 31-07.
  assert.strictEqual(nextBookingTargetYmd(sgt('2026-07-29T07:00:00+08:00')), '2026-07-31');
});

test('after the 08:40 run, the target rolls to tomorrow\'s run', () => {
  // 09:00 SGT Wed 29-07 → today's run is done → next is 30-07, booking 01-08.
  assert.strictEqual(nextBookingTargetYmd(sgt('2026-07-29T09:00:00+08:00')), '2026-08-01');
});

test('boundary: 08:39 is still today\'s run, 08:41 is tomorrow\'s', () => {
  assert.strictEqual(nextBookingTargetYmd(sgt('2026-07-29T08:39:00+08:00')), '2026-07-31');
  assert.strictEqual(nextBookingTargetYmd(sgt('2026-07-29T08:41:00+08:00')), '2026-08-01');
});

test('rolls across month and year boundaries', () => {
  assert.strictEqual(nextBookingTargetYmd(sgt('2026-07-30T21:00:00+08:00')), '2026-08-02');
  assert.strictEqual(nextBookingTargetYmd(sgt('2026-12-30T21:00:00+08:00')), '2027-01-02');
});

test('a user with NO class on D+2 but a class on D+3 still gets warned', () => {
  // Dani is off on 2026-08-05 (per overrides) but books on 2026-08-06. The old
  // code probed D+2 and would have gone quiet; the target must be D+3.
  const evening = sgt('2026-08-03T21:00:00+08:00');
  assert.strictEqual(nextBookingTargetYmd(evening), '2026-08-06', 'gates on the real at-risk day');
});
