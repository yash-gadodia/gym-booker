// On-demand booking: book any specific class right now (not the day+2 cron).
// Used by Lawrence's gym-actions.py wrapper for chat-driven booking.
//
// Usage:
//   node book-now.js --user <id> --date YYYY-MM-DD --time H:MMam --kind FIT [--dry-run]
//
// Output: single-line JSON to stdout. Logs to stderr.
//   --dry-run: fetches class status + payment pass, does NOT fire pipeline.
//   No --dry-run: fires pipeline + verifies via /account/schedule.

require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { ymd, parseBookingCard } = require('./lib');
const {
  captureBearerToken, fetchScheduleClasses, findClass,
  fetchPaymentPassUuid, bookViaApi, generateRecaptchaToken,
} = require('./api-client');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const userId = opt('user');
const dateArg = opt('date');
const timeArg = opt('time');
const kindArg = opt('kind') || 'FIT';
const dryRun = args.includes('--dry-run');

function fail(reason, detail) {
  process.stdout.write(JSON.stringify({ ok: false, reason, detail }) + '\n');
  process.exit(1);
}

if (!userId) fail('bad-args', 'missing --user <id>');
if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) fail('bad-args', 'missing/bad --date YYYY-MM-DD');
if (!timeArg || !/^\d{1,2}:\d{2}(am|pm)$/i.test(timeArg)) fail('bad-args', 'missing/bad --time H:MMam');

const log = (...a) => console.error(`[${new Date().toISOString()}]`, ...a);

function timeToHHMM(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(t);
  let h = parseInt(m[1], 10); const mins = parseInt(m[2], 10); const ap = m[3].toLowerCase();
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

async function fetchUpcoming(page) {
  await page.goto('https://www.mindbodyonline.com/explore/account/schedule', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  const cookieBtn = await page.$('button:has-text("AGREE AND PROCEED")');
  if (cookieBtn) { try { await cookieBtn.click(); } catch {} await page.waitForTimeout(800); }
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

(async () => {
  const authPath = path.join(__dirname, 'users-auth', `${userId}.json`);
  if (!fs.existsSync(authPath)) fail('no-auth', `no users-auth/${userId}.json — run the daily booker once for ${userId} first`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }, locale: 'en-SG', timezoneId: 'Asia/Singapore',
    storageState: authPath,
  });
  const page = await ctx.newPage();

  let out = { ok: false };
  try {
    log('capturing bearer');
    const bearer = await captureBearerToken(page, { timeoutMs: 20000 });

    log(`fetching schedule for ${dateArg}`);
    const fromIso = new Date(`${dateArg}T00:00:00+08:00`).toISOString();
    const toIso = new Date(`${dateArg}T23:59:59+08:00`).toISOString();
    const classes = await fetchScheduleClasses(bearer, { fromIso, toIso });
    const sgtHHMM = timeToHHMM(timeArg);
    const cls = findClass(classes, { kindNeedle: kindArg, sgtDate: dateArg, sgtHHMM });
    if (!cls) {
      out = { ok: false, reason: 'class-not-found', detail: `${kindArg} ${timeArg} not on ${dateArg} (${classes.length} classes that day)` };
      return;
    }

    const target = { date: dateArg, time: timeArg, kind: kindArg };
    const classStatus = cls.statusText || null;
    const bookable = !!cls.bookable;
    log(`class ${cls.mb_class_id}/${cls.mb_class_schedule_id}: bookable=${bookable} status="${classStatus}"`);

    // Confirm user isn't already booked.
    const upcoming = await fetchUpcoming(page).catch(() => []);
    const already = upcoming.some(b => b.ymd === dateArg && b.kind === kindArg && b.time === timeArg.toLowerCase());
    if (already) {
      out = { ok: true, reason: 'already-booked', target, classStatus, bookable, alreadyBooked: true };
      return;
    }

    if (dryRun) {
      out = { ok: true, reason: 'dry-run', target, classStatus, bookable, alreadyBooked: false };
      return;
    }

    if (!bookable) {
      out = { ok: false, reason: 'class-not-bookable', detail: `Mindbody status: ${classStatus}`, target, classStatus, bookable };
      return;
    }

    log('fetching payment pass');
    const paymentMethodUuid = await fetchPaymentPassUuid(bearer, cls);

    log('firing booking pipeline');
    let result = await bookViaApi(bearer, { classMeta: cls, paymentMethodUuid, recaptchaToken: '' });
    if (!result.ok && result.step === 'process' && /recaptcha|captcha/i.test(result.body || '')) {
      log('process needs recaptcha — minting');
      const tok = await generateRecaptchaToken(page).catch(e => { log(`recaptcha mint failed: ${e.message}`); return null; });
      if (tok) result = await bookViaApi(bearer, { classMeta: cls, paymentMethodUuid, recaptchaToken: tok });
    }

    // Verify processing_requested actually committed.
    let verified = null;
    if (result.ok && result.statusTitle === 'processing_requested') {
      for (const waitMs of [3500, 3500]) {
        await new Promise(r => setTimeout(r, waitMs));
        let post = [];
        try { post = await fetchUpcoming(page); }
        catch (e) { log(`verify fetch failed: ${e.message}`); verified = 'fetch-error'; break; }
        if (post.some(b => b.ymd === dateArg && b.kind === kindArg && b.time === timeArg.toLowerCase())) {
          verified = true;
          break;
        }
        log(`not yet on /account/schedule (${post.length} upcoming)`);
        verified = false;
      }
    } else {
      verified = !!result.ok;
    }

    out = {
      ok: result.ok && verified !== false,
      reason: result.ok
        ? (verified === true ? 'booked' : verified === false ? 'silently-dropped' : 'committed-unverified')
        : `api-${result.step}-failed`,
      target, classStatus, bookable, verified,
      orderId: result.orderId, statusTitle: result.statusTitle, httpStatus: result.httpStatus,
      detail: result.ok ? undefined : `HTTP ${result.status}: ${(result.body || '').slice(0, 300)}`,
    };
  } catch (e) {
    out = { ok: false, reason: 'exception', detail: e.message };
  } finally {
    await browser.close();
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(out.ok ? 0 : 1);
  }
})();
