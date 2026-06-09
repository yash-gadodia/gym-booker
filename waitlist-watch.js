// One-shot waitlist watcher . DM-every-poll variant.
//
// Usage: node waitlist-watch.js <YYYY-MM-DD> <time> [--reset]
//   e.g. node waitlist-watch.js 2026-05-22 7:30am
//
// Behavior (designed for 60s LaunchAgent polling):
//   1. If class already started . exit (LaunchAgent script unloads us).
//   2. Fetch /account/schedule . if target booking IS there (Mindbody promoted
//      the user, or they manually booked) . DM "you're in" once, mark booked,
//      exit (LaunchAgent script unloads us).
//   3. Probe class status via Mindbody marketplace API.
//   4. If status is FULL / NOT_FOUND . quiet update, no DM.
//   5. If status is actionable (BOOK_NOW or WAITLIST):
//        . DM user + Yash with manual-join instructions, EVERY POLL it stays
//          actionable. Rationale (Yash 2026-05-20): "DM the user on telegram
//          every 1min that a waitlist spot has opened". Mindbody marketplace
//          API doesn't expose a join-waitlist endpoint (403); user clicks
//          JOIN WAITLIST or BOOK NOW manually in the app.
//
// State file (runs/waitlist-state-<watchId>.json):
//   { lastStatus, lastChecked, polls, firstSeen,
//     userBooked, userBookedAt, alertCount, lastAlertedAt }
//
// Env:
//   WAITLIST_USER       . user.id key in users.json (auth + creds)
//   WAITLIST_NAME       . display name in DM greeting
//   TELEGRAM_CHAT_ID    . comma-separated chat ids to DM
//   WAITLIST_NO_AUTH    . skip auth (read-only public probe)

require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const {
  DAY_SHORT, ymd, classPlan, parseBookingCard, isBookingInUpcoming, findBookingInUpcoming,
} = require('./lib');
const { loginAndSave } = require('./mb-login');
const { captureBearerToken, fetchScheduleClasses, findClass } = require('./api-client');

const GYM_URL = 'https://www.mindbodyonline.com/explore/locations/ragtag';
// "Join the waitlist" is a one-time, stable ask — nudge at most this many times
// then go quiet (overridable via env). BOOK_NOW (a real freed slot) is exempt:
// it's urgent and self-limiting (the slot vanishes once taken).
const MAX_WAITLIST_NUDGES = parseInt(process.env.WAITLIST_MAX_NUDGES || '3', 10);

function parseTimeToMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(t);
  if (!m) throw new Error(`bad time: ${t}`);
  let h = parseInt(m[1], 10); const mins = parseInt(m[2], 10); const ap = m[3].toLowerCase();
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h * 60 + mins;
}

function targetClassStartMs(dateYmd, timeStr) {
  const d = new Date(`${dateYmd}T00:00:00+08:00`);
  const minutes = parseTimeToMinutes(timeStr);
  d.setHours(0, minutes, 0, 0);
  return d.getTime();
}

function timeToHHMM(timeArg) {
  const minutes = parseTimeToMinutes(timeArg);
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fmtDmy(dateYmd) {
  const [y, m, d] = dateYmd.split('-');
  return `${d}-${m}-${y}`;
}

async function tg(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return false;
  const ids = String(process.env.TELEGRAM_CHAT_ID).split(',').map(s => s.trim()).filter(Boolean);
  let allOk = ids.length > 0;
  for (const chatId of ids) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId, text,
          parse_mode: 'Markdown', disable_web_page_preview: true,
        }),
      });
      if (!r.ok) allOk = false;
    } catch { allOk = false; }
  }
  return allOk;
}

async function fetchMyUpcomingBookings(page) {
  const acctUrl = 'https://www.mindbodyonline.com/explore/account/schedule';
  await page.goto(acctUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  const cards = await page.evaluate(() => {
    const cancelBtns = Array.from(document.querySelectorAll('button, a'))
      .filter(e => /^Cancel$/i.test((e.innerText || '').trim()));
    const out = [];
    for (const btn of cancelBtns) {
      let n = btn.parentElement;
      let best = (btn.innerText || '').trim();
      for (let j = 0; j < 15 && n; j++) {
        const cancelCount = Array.from(n.querySelectorAll('button, a'))
          .filter(e => /^Cancel$/i.test((e.innerText || '').trim())).length;
        if (cancelCount > 1) break;
        const t = (n.innerText || '').trim();
        if (t.length > best.length && t.length < 600) best = t;
        n = n.parentElement;
      }
      out.push(best.replace(/\s+/g, ' '));
    }
    return out;
  });
  return cards.map(parseBookingCard).filter(Boolean);
}

async function checkApiStatus(page, plan, dateArg, timeArg) {
  const bearer = await captureBearerToken(page, { timeoutMs: 20000 });
  const fromIso = new Date(`${dateArg}T00:00:00+08:00`).toISOString();
  const toIso = new Date(`${dateArg}T23:59:59+08:00`).toISOString();
  const classes = await fetchScheduleClasses(bearer, { fromIso, toIso });
  const cls = findClass(classes, {
    kindNeedle: plan.kind, sgtDate: dateArg, sgtHHMM: timeToHHMM(timeArg),
  });
  if (!cls) return { observed: 'NOT_FOUND', observedText: '(class not in API schedule)' };
  const txt = cls.statusText || '';
  let observed;
  if (cls.bookable) observed = 'BOOK_NOW';
  else if (/wait[- ]?list/i.test(txt)) observed = 'WAITLIST';
  else if (/max capacity|full/i.test(txt)) observed = 'FULL';
  else observed = 'UNKNOWN';
  return {
    observed,
    observedText: `bookable=${cls.bookable} status="${txt}" id=${cls.mb_class_id}/${cls.mb_class_schedule_id}`,
  };
}

// Build the alert text. Wording depends on whether the opening is a direct
// slot (BOOK_NOW: someone canceled) or a waitlist queue (WAITLIST: Mindbody
// is offering join-queue). Keep persona-clean (Lawrence British gym bro) and
// em-dash-free per Yash voice rule.
function buildAlertMessage({ observed, plan, timeArg, dateArg, target, name, alertCount }) {
  const dayLabel = DAY_SHORT[target.getDay()];
  const heading = observed === 'BOOK_NOW'
    ? '🟢 *SLOT OPEN*'
    : '🟡 *WAITLIST AVAILABLE*';
  const action = observed === 'BOOK_NOW'
    ? 'Someone just canceled. Open Mindbody and *BOOK NOW* before the next person grabs it.'
    : 'Mindbody is letting you join the waitlist. Open the app and *JOIN WAITLIST*. You\'ll be auto-promoted when a slot opens.';
  const greeting = name ? `${name}, ` : '';
  const repeatHint = alertCount > 1 ? `_(reminder ${alertCount}, every minute while it stays open)_\n` : '';
  return (
    `${heading}\n` +
    `${greeting}${plan.kind} @ ${timeArg} on ${dayLabel} ${fmtDmy(dateArg)}.\n` +
    `${action}\n` +
    `${repeatHint}` +
    `https://www.mindbodyonline.com/explore/locations/ragtag`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const timeArg = args.find(a => /^\d{1,2}:\d{2}(am|pm)$/i.test(a));
  const reset = args.includes('--reset');
  if (!dateArg || !timeArg) {
    console.error('usage: waitlist-watch.js <YYYY-MM-DD> <time> [--reset]');
    process.exit(2);
  }

  const target = new Date(`${dateArg}T00:00:00`);
  const plan = classPlan(target);
  // Allow caller to override the class kind (e.g. Sat 9:30am FIT, not default Sat Gymnastics).
  if (process.env.WAITLIST_KIND) {
    plan.kind = process.env.WAITLIST_KIND;
  }
  // Per-user state: two users can watch the same date+time slot without
  // clobbering each other's userBooked/alert state. Falls back to the legacy
  // slot-only id when WAITLIST_USER is unset (back-compat).
  const watchUserId = (process.env.WAITLIST_USER || '').trim();
  const watchId = watchUserId
    ? `${dateArg}_${timeArg.replace(':', '')}-${watchUserId}`
    : `${dateArg}_${timeArg.replace(':', '')}`;
  const stateFile = path.join(__dirname, 'runs', `waitlist-state-${watchId}.json`);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  if (reset && fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
    console.log(`[reset] removed ${stateFile}`);
  }

  let state = {
    lastStatus: null,
    lastChecked: null,
    polls: 0,
    firstSeen: null,
    userBooked: false,
    userBookedAt: null,
    userWaitlisted: false,
    alertCount: 0,
    lastAlertedAt: null,
  };
  if (fs.existsSync(stateFile)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      state = { ...state, ...loaded };
      // Legacy migration: prior versions used joined/promoted/alerted fields.
      // Treat any "promoted" state as terminal (userBooked).
      if (loaded.promoted) {
        state.userBooked = true;
        state.userBookedAt = loaded.promotedAt || state.lastChecked || new Date().toISOString();
      }
    } catch {}
  }

  const classStartMs = targetClassStartMs(dateArg, timeArg);
  if (Date.now() >= classStartMs) {
    console.log(`class already started (${new Date(classStartMs).toISOString()}) . exiting`);
    process.exit(0);
  }
  if (state.userBooked) {
    console.log(`user already booked on ${state.userBookedAt} . exiting`);
    process.exit(0);
  }

  const ts = new Date().toISOString();
  console.log(`[${ts}] poll #${state.polls + 1}: ${plan.kind} @ ${timeArg} on ${DAY_SHORT[target.getDay()]} ${dateArg}`);

  const watchUser = process.env.WAITLIST_USER || null;
  const authPath = watchUser
    ? path.join(__dirname, 'users-auth', `${watchUser}.json`)
    : path.join(__dirname, 'auth.json');
  const useAuth = !process.env.WAITLIST_NO_AUTH;

  let mbEmail, mbPassword;
  try {
    const { getUser, getCreds } = require('./users');
    const u = getUser(watchUser || 'yash');
    const c = getCreds(u);
    mbEmail = c.email;
    mbPassword = c.password;
  } catch (e) {
    console.error(`[waitlist-watch] cred lookup for user "${watchUser || 'yash'}" failed: ${e.message}`);
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }, locale: 'en-SG', timezoneId: 'Asia/Singapore',
    storageState: useAuth && fs.existsSync(authPath) ? authPath : undefined,
  });
  const page = await ctx.newPage();

  let observed = 'ERROR';
  let observedText = '';
  let bookingDetected = false;
  let userOnWaitlist = false;   // user has already joined the Mindbody waitlist

  try {
    await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    for (const sel of ['button:has-text("AGREE AND PROCEED")', '#onetrust-accept-btn-handler']) {
      const el = await page.$(sel); if (el) try { await el.click({ timeout: 2000 }); } catch {}
    }

    const loggedOut = await page.locator('button[data-name="NavigationBar.Login.Button"]').count() > 0;
    if (loggedOut && useAuth && mbEmail && mbPassword) {
      console.log(`logged out . re-login as ${mbEmail}`);
      // Shared hardened login (mb-login.js): dismisses the consent overlay and
      // clicks the VISIBLE Login button. The old bare page.click hung the full
      // 30s on the invisible overlay and errored every poll for every user
      // (2026-06-09 watcher outage that made Lawrence blame users' passwords).
      await loginAndSave(page, ctx, authPath, { creds: { email: mbEmail, password: mbPassword }, log: (m) => console.log(m) });
      await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
    }

    // 1. Did the user (manually or via Mindbody auto-promote) end up booked?
    //    A WAITLISTED entry also appears here — it must NOT count as booked, or
    //    the watcher would falsely DM "you're in!" and self-unload on its first
    //    poll, exactly when the user most needs it to keep watching.
    try {
      const upcoming = await fetchMyUpcomingBookings(page);
      const match = findBookingInUpcoming(upcoming, { targetYmd: dateArg, kind: plan.kind, time: timeArg });
      if (match && !match.waitlisted) {
        bookingDetected = true;
      } else if (match && match.waitlisted) {
        userOnWaitlist = true;   // she's already in the queue → stop nagging her to join
      }
    } catch (e) {
      console.log(`schedule fetch failed (${e.message.slice(0, 140)})`);
    }

    if (bookingDetected) {
      // Restore gym URL so the API probe below works
      try { await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
    }

    // 2. Public class status (only matters if user not yet booked)
    if (!bookingDetected) {
      const result = await checkApiStatus(page, plan, dateArg, timeArg);
      observed = result.observed;
      observedText = result.observedText;
    }
  } catch (e) {
    observed = 'ERROR';
    observedText = e.message;
  } finally {
    if (useAuth) { try { await ctx.storageState({ path: authPath }); } catch {} }
  }

  state.polls += 1;
  state.lastChecked = new Date().toISOString();
  state.lastStatus = bookingDetected ? 'BOOKED' : observed;
  if (!state.firstSeen) state.firstSeen = { at: state.lastChecked, status: state.lastStatus };

  const dayLabel = DAY_SHORT[target.getDay()];
  const name = process.env.WAITLIST_NAME || 'You';
  if (bookingDetected) {
    state.userBooked = true;
    state.userBookedAt = state.lastChecked;
    const msg =
      `🎉 *${name}, you.re in!*\n` +
      `${plan.kind} @ ${timeArg} on ${dayLabel} ${fmtDmy(dateArg)}.\n` +
      `See you there.`;
    await tg(msg);
    console.log('USER BOOKED . sent confirmation DM');
  } else if (userOnWaitlist) {
    // She has ALREADY joined the Mindbody waitlist — joining is a one-time
    // action, so STOP nagging her to do it (2026-06-09: Melissa joined and got
    // pinged "JOIN WAITLIST" every 2 min, reminder 7+). Send ONE warm sign-off
    // the first time we see her in the queue, then stay silent until she's
    // actually promoted (bookingDetected → "you're in!").
    if (!state.userWaitlisted) {
      state.userWaitlisted = true;
      await tg(
        `✅ *${name}, you're on the waitlist* for ${plan.kind} @ ${timeArg} on ${dayLabel} ${fmtDmy(dateArg)}.\n` +
        `Sit tight . Mindbody auto-promotes you when a spot frees, and I'll shout the second you're in. ` +
        `No need to keep the app open . I'll stop pinging now. 💪`);
      console.log('USER ON WAITLIST . sent one sign-off, going silent');
    } else {
      console.log('user already on waitlist . staying silent (no spam)');
    }
  } else if (observed === 'BOOK_NOW') {
    // A real spot freed (someone cancelled) — time-critical, keep nudging. This
    // is self-limiting: the slot vanishes (back to FULL/WAITLIST) once taken.
    state.alertCount += 1;
    state.lastAlertedAt = state.lastChecked;
    await tg(buildAlertMessage({
      observed, plan, timeArg, dateArg, target,
      name: process.env.WAITLIST_NAME || null, alertCount: state.alertCount,
    }));
    console.log(`ALERTED BOOK_NOW (count=${state.alertCount})`);
  } else if (observed === 'WAITLIST') {
    // Class full, waitlist open, user hasn't joined yet. Nudge a FEW times then
    // stop — "join the waitlist" is a stable, one-time ask, not a per-minute one.
    if (state.alertCount < MAX_WAITLIST_NUDGES) {
      state.alertCount += 1;
      state.lastAlertedAt = state.lastChecked;
      await tg(buildAlertMessage({
        observed, plan, timeArg, dateArg, target,
        name: process.env.WAITLIST_NAME || null, alertCount: state.alertCount,
      }));
      console.log(`ALERTED WAITLIST (count=${state.alertCount}/${MAX_WAITLIST_NUDGES})`);
    } else {
      console.log(`WAITLIST nudge cap reached (${state.alertCount}/${MAX_WAITLIST_NUDGES}) . staying silent`);
    }
  } else {
    console.log(`no alert (status=${observed}, userBooked=${state.userBooked})`);
  }

  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  try { await browser.close(); } catch {}
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
}

module.exports = { buildAlertMessage };
