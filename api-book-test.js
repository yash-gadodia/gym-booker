// End-to-end live test of api-client. Books an open slot via the direct API
// pipeline (bypassing the React UI), then immediately cancels via cancel-booking.js.
// Reports timing breakdown so we can compare against the 12s UI flow.
//
// Usage: node api-book-test.js --date 2026-04-28 --time 8:30am [--kind FIT]
require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const {
  captureBearerToken, fetchScheduleClasses, findClass,
  fetchPaymentPassUuid, bookViaApi, generateRecaptchaToken,
} = require('./api-client');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i+1] && !args[i+1].startsWith('--') ? args[i+1] : null; };
const dateArg = opt('date');
const timeArg = opt('time');
const kindArg = opt('kind') || 'FIT';
const skipCancel = args.includes('--no-cancel');
if (!dateArg || !timeArg) { console.error('Usage: node api-book-test.js --date YYYY-MM-DD --time H:MMam [--kind FIT|Gymnastics|Lift]'); process.exit(2); }

const log = (...a) => console.log(`[${new Date().toISOString()}] ${a.join(' ')}`);

// Convert "8:30am" / "12:30pm" / "1:00pm" to "HH:MM" 24h.
function parseTime(t) {
  const m = t.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) throw new Error(`bad time: ${t}`);
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ap = m[3].toLowerCase();
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}`;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-SG', timezoneId: 'Asia/Singapore',
    storageState: fs.existsSync(path.join(__dirname, 'auth.json')) ? path.join(__dirname, 'auth.json') : undefined,
  });
  const page = await ctx.newPage();

  let result = null;
  try {
    log('STEP 1: capture Bearer token from any Mindbody API call');
    const tBearer0 = Date.now();
    const bearer = await captureBearerToken(page, { timeoutMs: 20000 });
    log(`  captured (${Date.now() - tBearer0}ms): ${bearer.slice(0, 40)}...${bearer.slice(-12)}`);

    log('STEP 2: fetch schedule for target date');
    const sgtHHMM = parseTime(timeArg);
    const fromIso = new Date(`${dateArg}T00:00:00+08:00`).toISOString();
    const toIso = new Date(`${dateArg}T23:59:59+08:00`).toISOString();
    const tSch0 = Date.now();
    const classes = await fetchScheduleClasses(bearer, { fromIso, toIso });
    log(`  fetched ${classes.length} classes (${Date.now() - tSch0}ms)`);

    log('STEP 3: find target class');
    const target = findClass(classes, { kindNeedle: kindArg, sgtDate: dateArg, sgtHHMM });
    if (!target) {
      const candidates = classes.filter(c => c.courseName && c.courseName.toLowerCase().includes(kindArg.toLowerCase()));
      log(`  no exact match; ${kindArg} candidates: ${candidates.map(c => `${c.courseName}@${c.startTime}(${c.statusText})`).join(', ').slice(0, 400)}`);
      throw new Error(`no ${kindArg} ${timeArg} class found on ${dateArg}`);
    }
    log(`  target: ${target.courseName} @ ${target.startTime} mb_class_id=${target.mb_class_id} schedule_id=${target.mb_class_schedule_id} status=${target.statusText}`);

    log('STEP 4: fetch payment pass UUID');
    const tPay0 = Date.now();
    const paymentMethodUuid = await fetchPaymentPassUuid(bearer, target);
    log(`  pass UUID: ${paymentMethodUuid} (${Date.now() - tPay0}ms)`);

    log('STEP 5: fire booking pipeline (orders → booking_items → payments → process)');
    const tBook0 = Date.now();
    result = await bookViaApi(bearer, { classMeta: target, paymentMethodUuid, recaptchaToken: '' });
    log(`  result: ${JSON.stringify(result)}`);
    log(`  e2e ${Date.now() - tBook0}ms; per-step: ${JSON.stringify(result.timing || {})}`);

    // If process step rejected with recaptcha-related error, retry with a real token.
    if (!result.ok && result.step === 'process' && /recaptcha|captcha/i.test(result.body || '')) {
      log('  → process needs real recaptcha; generating via page.evaluate');
      try {
        const tok = await generateRecaptchaToken(page);
        log(`  recaptcha token: ${tok.slice(0, 40)}...`);
        result = await bookViaApi(bearer, { classMeta: target, paymentMethodUuid, recaptchaToken: tok });
        log(`  retry result: ${JSON.stringify(result)}`);
      } catch (e) {
        log(`  recaptcha generation failed: ${e.message}`);
      }
    }
  } catch (e) {
    log(`ERROR: ${e.message}`);
  } finally {
    await browser.close();
    if (result && result.ok && !skipCancel) {
      log('AUTO-CANCEL: undoing test booking');
      const r = spawnSync('node', ['cancel-booking.js', '--date', dateArg, '--time', timeArg, '--kind', kindArg], { cwd: __dirname, encoding: 'utf8' });
      log(`  cancel exit=${r.status}\n${r.stdout}\n${r.stderr}`);
    } else if (result && result.ok) {
      log('AUTO-CANCEL skipped (--no-cancel)');
    }
  }
})();
