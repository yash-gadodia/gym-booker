// READ-ONLY end-to-end per-user reliability probe. For each user: load cached
// auth → (re-login via shared mb-login if stale, refreshing their real auth) →
// capture Bearer → fetch a day's schedule. Proves the full booking READ pipeline
// works for everyone (the 09:00 commit is the only untestable-off-cycle bit).
require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const { loginAndSave } = require('./mb-login');
const { captureBearerToken, fetchScheduleClasses } = require('./api-client');
const { getUser, getCreds, getAuthPath } = require('./users');

const GYM_URL = 'https://www.mindbodyonline.com/explore/locations/ragtag';
const USERS = ['yash', 'dani', 'melissa', 'geraldine', 'cheryllee'];
const TARGET = process.argv[2] || '2026-06-12';

async function checkUser(id) {
  const out = { id, auth: '?', bearer: '?', schedule: '?', note: '', ms: 0 };
  const t0 = Date.now();
  let creds, authPath;
  try { const u = getUser(id); creds = getCreds(u); authPath = getAuthPath(u); }
  catch (e) { out.auth = 'CREDS-MISSING'; out.note = e.message.slice(0, 60); return out; }
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }, locale: 'en-SG', timezoneId: 'Asia/Singapore',
    storageState: fs.existsSync(authPath) ? authPath : undefined,
  });
  const page = await ctx.newPage();
  try {
    await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    const loggedOut = await page.locator('button[data-name="NavigationBar.Login.Button"]').count() > 0;
    if (loggedOut) {
      try {
        await loginAndSave(page, ctx, authPath, { creds, log: () => {} });
        await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);
        const still = await page.locator('button[data-name="NavigationBar.Login.Button"]').count() > 0;
        out.auth = still ? 'LOGIN-FAILED' : 're-logged-in';
      } catch (e) { out.auth = 'LOGIN-FAILED'; out.note = e.message.split('\n')[0].slice(0, 70); }
    } else out.auth = 'cached-valid';

    if (out.auth !== 'LOGIN-FAILED') {
      try {
        const b = await captureBearerToken(page, { timeoutMs: 20000 });
        out.bearer = b ? 'ok' : 'none';
        if (b) {
          const fromIso = new Date(`${TARGET}T00:00:00+08:00`).toISOString();
          const toIso = new Date(`${TARGET}T23:59:59+08:00`).toISOString();
          const cls = await fetchScheduleClasses(b, { fromIso, toIso });
          out.schedule = `${cls.length} classes`;
        }
      } catch (e) { if (out.bearer === '?') out.bearer = 'FAILED'; out.schedule = 'FAILED'; out.note = out.note || e.message.split('\n')[0].slice(0, 70); }
    }
  } catch (e) { out.note = e.message.split('\n')[0].slice(0, 70); }
  finally { try { await browser.close(); } catch {} }
  out.ms = Date.now() - t0;
  return out;
}

(async () => {
  console.log(`E2E per-user check (schedule day ${TARGET})\n`);
  for (const id of USERS) {
    const r = await checkUser(id);
    const ok = (r.auth === 'cached-valid' || r.auth === 're-logged-in') && r.bearer === 'ok' && /classes/.test(r.schedule);
    console.log(`${ok ? '✅' : '❌'} ${r.id.padEnd(11)} auth=${r.auth.padEnd(13)} bearer=${String(r.bearer).padEnd(6)} sched=${String(r.schedule).padEnd(12)} ${Math.round(r.ms/1000)}s ${r.note ? '· ' + r.note : ''}`);
  }
  console.log('\ndone');
})();
