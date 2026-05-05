// One-shot waitlist/cancellation watcher.
//
// Usage: node waitlist-watch.js <YYYY-MM-DD> <time> [--reset]
//   e.g. node waitlist-watch.js 2026-04-27 6:30am
//
// Polls the target row once. If the row's status has transitioned away from
// FULL (to BOOK_NOW or WAITLIST), sends a Telegram alert and writes the state
// file marking the watch as fired. Subsequent runs are no-ops once fired.
//
// Designed to be invoked every few minutes by a LaunchAgent.

require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const {
  DAY_SHORT, ymd, classPlan,
} = require('./lib');
const { captureBearerToken, fetchScheduleClasses, findClass } = require('./api-client');

const GYM_URL = 'https://www.mindbodyonline.com/explore/locations/ragtag';

function parseTimeToMinutes(t) {
  // "6:30am" → 6*60+30; "1:00pm" → 13*60
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

function fmtDmy(dateYmd) {
  const [y, m, d] = dateYmd.split('-');
  return `${d}-${m}-${y}`;
}

function timeToHHMM(timeArg) {
  const minutes = parseTimeToMinutes(timeArg);
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Authoritative class status via Mindbody marketplace API. The public web
// schedule shows "BOOK NOW" even when classes are at max capacity, so DOM
// scraping produces false positives. The API returns bookable + statusText
// (e.g. "Class is at Max Capacity") which the booker pipeline already trusts.
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

(async () => {
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
  const watchId = `${dateArg}_${timeArg.replace(':', '')}`;
  const stateFile = path.join(__dirname, 'runs', `waitlist-state-${watchId}.json`);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  if (reset && fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
    console.log(`[reset] removed ${stateFile}`);
  }

  let state = { lastStatus: null, alerted: false, firstSeen: null, lastChecked: null, polls: 0 };
  if (fs.existsSync(stateFile)) {
    try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch {}
  }

  // Auto-disarm: if class has already started, don't bother
  const classStartMs = targetClassStartMs(dateArg, timeArg);
  if (Date.now() >= classStartMs) {
    console.log(`class already started (${new Date(classStartMs).toISOString()}) — exiting`);
    process.exit(0);
  }
  // Already fired — idempotent silent exit
  if (state.alerted) {
    console.log(`already alerted on ${state.firedAt} — exiting`);
    process.exit(0);
  }

  const ts = new Date().toISOString();
  console.log(`[${ts}] poll #${state.polls + 1}: ${plan.kind} @ ${timeArg} on ${DAY_SHORT[target.getDay()]} ${dateArg}`);

  const authPath = path.join(__dirname, 'auth.json');
  const useAuth = !process.env.WAITLIST_NO_AUTH;
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }, locale: 'en-SG', timezoneId: 'Asia/Singapore',
    storageState: useAuth && fs.existsSync(authPath) ? authPath : undefined,
  });
  const page = await ctx.newPage();

  let observed = 'ERROR';
  let observedText = '';
  let didLogin = false;
  try {
    await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    for (const sel of ['button:has-text("AGREE AND PROCEED")', '#onetrust-accept-btn-handler']) {
      const el = await page.$(sel); if (el) try { await el.click({ timeout: 2000 }); } catch {}
    }

    // Reactive login — only if logged out. We don't need a fresh session for read-only polling.
    const loggedOut = await page.locator('button[data-name="NavigationBar.Login.Button"]').count() > 0;
    if (loggedOut && useAuth && process.env.MINDBODY_EMAIL && process.env.MINDBODY_PASSWORD) {
      console.log('logged out — re-login');
      didLogin = true;
      await page.click('button[data-name="NavigationBar.Login.Button"]');
      await page.waitForTimeout(2000);
      const emailInput = page.locator('input:visible').first();
      await emailInput.waitFor({ state: 'visible', timeout: 15000 });
      await emailInput.fill(process.env.MINDBODY_EMAIL);
      await page.click('button:has-text("Continue"), button:has-text("Next"), button[type="submit"]');
      await page.waitForSelector('input[type="password"]', { timeout: 20000 });
      await page.waitForTimeout(800);
      await page.fill('input[type="password"]', process.env.MINDBODY_PASSWORD);
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
        page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")'),
      ]);
      await page.waitForTimeout(3000);
      await ctx.storageState({ path: authPath });
      await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
    }

    const result = await checkApiStatus(page, plan, dateArg, timeArg);
    observed = result.observed;
    observedText = result.observedText;
  } catch (e) {
    observed = 'ERROR';
    observedText = e.message;
  } finally {
    if (useAuth) { try { await ctx.storageState({ path: authPath }); } catch {} }
    await browser.close();
  }

  console.log(`observed: ${observed} — ${observedText.slice(0, 160)}`);

  state.polls += 1;
  state.lastChecked = new Date().toISOString();
  state.lastStatus = observed;
  if (!state.firstSeen) state.firstSeen = { at: state.lastChecked, status: observed };

  // Alert condition: was-FULL/UNKNOWN, now anything actionable.
  // BOOK_NOW = direct slot opened. WAITLIST = waitlist became available.
  // Any other transition (DETAILS appearing, etc.) is also worth flagging once.
  const actionable = ['BOOK_NOW', 'WAITLIST'];
  const interesting = actionable.includes(observed);

  if (interesting && !state.alerted) {
    const dayLabel = DAY_SHORT[target.getDay()];
    const banner = observed === 'BOOK_NOW' ? '🟢 *SLOT OPEN*' : '🟡 *WAITLIST AVAILABLE*';
    const verb = observed === 'BOOK_NOW' ? 'book it' : 'join waitlist';
    const greeting = process.env.WAITLIST_NAME ? `Hey ${process.env.WAITLIST_NAME} — ` : '';
    const msg =
      `${greeting}${banner}\n` +
      `${plan.kind} @ ${timeArg} — ${dayLabel} ${fmtDmy(dateArg)}\n` +
      `→ open Mindbody and *${verb}* now\n` +
      `https://www.mindbodyonline.com/explore/locations/ragtag`;
    const ok = await tg(msg);
    state.alerted = ok;
    state.firedAt = new Date().toISOString();
    state.firedStatus = observed;
    console.log(`ALERT sent (tg=${ok}) — status=${observed}`);
  } else if (interesting && state.alerted) {
    console.log('already alerted — no re-send');
  } else {
    console.log(`no alert (status=${observed}, alerted=${state.alerted})`);
  }

  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
