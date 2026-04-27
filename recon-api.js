// Capture full request + response bodies for every prod-mkt-gateway.mindbody.io
// call during a live booking flow. Saves to ./recon-api/<RUN_ID>/. Auto-cancels
// the test booking after capture (best-effort). Used as one-time recon to
// design api-book.js.
//
// Usage: node recon-api.js --date 2026-04-28 --time 8:30am [--kind FIT]
require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i+1] && !args[i+1].startsWith('--') ? args[i+1] : null; };
const dateArg = opt('date');
const timeArg = opt('time');
const kindArg = opt('kind') || 'FIT';
if (!dateArg || !timeArg) {
  console.error('Usage: node recon-api.js --date YYYY-MM-DD --time H:MMam [--kind FIT|Gymnastics]');
  process.exit(2);
}

const RUN_ID = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
const RUN_DIR = path.join(__dirname, 'recon-api', RUN_ID);
fs.mkdirSync(RUN_DIR, { recursive: true });

const log = (...a) => { const line = `[${new Date().toISOString()}] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}`; console.log(line); fs.appendFileSync(path.join(RUN_DIR, 'recon.log'), line + '\n'); };

const GYM_URL = 'https://www.mindbodyonline.com/explore/locations/ragtag';
const MB_HOST = 'prod-mkt-gateway.mindbody.io';
const captured = [];   // ordered list of {req, res} for MB API calls

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-SG', timezoneId: 'Asia/Singapore',
    storageState: fs.existsSync(path.join(__dirname, 'auth.json')) ? path.join(__dirname, 'auth.json') : undefined,
  });
  const page = await ctx.newPage();

  // Intercept all requests + responses against the Mindbody marketplace gateway.
  page.on('request', req => {
    const url = req.url();
    if (!url.includes(MB_HOST)) return;
    captured.push({
      ts: Date.now(),
      kind: 'request',
      method: req.method(),
      url,
      headers: req.headers(),
      body: req.postData(),
    });
  });
  page.on('response', async res => {
    const url = res.url();
    if (!url.includes(MB_HOST)) return;
    let body = null;
    try { body = await res.text(); } catch {}
    captured.push({
      ts: Date.now(),
      kind: 'response',
      method: res.request().method(),
      url,
      status: res.status(),
      headers: res.headers(),
      body,
    });
  });

  try {
    log(`recon target: ${kindArg} @ ${timeArg} on ${dateArg}`);
    log('navigating to ragtag');
    await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);

    const cookieBtn = await page.$('button:has-text("AGREE AND PROCEED")');
    if (cookieBtn) { try { await cookieBtn.click(); } catch {} await page.waitForTimeout(800); }

    const classesBtn = page.locator('button, a, [role="tab"]').filter({ hasText: /^(Classes|Schedule)$/i }).first();
    if (await classesBtn.count() > 0) { await classesBtn.click(); await page.waitForTimeout(2500); }

    // Click target day via JS dispatch (carousel may scroll item out of view).
    const dayOfMonth = String(parseInt(dateArg.split('-')[2], 10));
    const weekday = ['SUN','MON','TUE','WED','THU','FRI','SAT'][new Date(`${dateArg}T00:00:00`).getDay()];
    log(`selecting day ${weekday} ${dayOfMonth}`);
    await page.evaluate(({ wk, dom }) => {
      const items = Array.from(document.querySelectorAll('[class*="Day_item"]'));
      const t = items.find(el => new RegExp(`^${wk}\\s*${dom}$`, 'i').test(el.innerText.trim()));
      if (t) t.click();
    }, { wk: weekday, dom: dayOfMonth });
    await page.waitForTimeout(2500);

    // Find row + click BOOK NOW. Reuse rowMatches logic from lib.
    const { rowMatches } = require('./lib');
    const rows = await page.locator('[class*="ClassTimeScheduleItemDesktop"]').all();
    let target = null;
    for (const r of rows) {
      const t = (await r.innerText().catch(() => '')).replace(/\s+/g, ' ');
      if (rowMatches(t, { kind: kindArg, time: timeArg }) && /BOOK NOW/i.test(t)) {
        target = { row: r, text: t };
        break;
      }
    }
    if (!target) throw new Error(`no ${kindArg} ${timeArg} BOOK NOW row found on ${dateArg}`);
    log(`found row: ${target.text.slice(0,140)}`);

    log('clicking BOOK NOW (recon mark)');
    captured.push({ ts: Date.now(), kind: 'mark', label: 'BOOK_NOW_CLICK' });
    await target.row.locator('button, a').filter({ hasText: /BOOK NOW/i }).first().click({ timeout: 10000 });

    log('waiting for checkout BUY button');
    await page.waitForSelector('button:has-text("BUY"), button:has-text("Buy")', { timeout: 30000 });
    await page.waitForTimeout(1500);

    captured.push({ ts: Date.now(), kind: 'mark', label: 'BUY_CLICK' });
    log('clicking BUY (recon mark)');
    await page.locator('button').filter({ hasText: /^BUY$/i }).first().click();

    // Let the order/process sequence complete. Wait until either a confirmation
    // text appears, the BUY button text changes back to "BUY" (false-positive
    // error), or 25s pass (fallback timeout).
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const body = await page.locator('body').innerText({ timeout: 500 }).catch(() => '');
      if (/booking confirmed|thank you|your booking|order complete|confirmation/i.test(body)) { log('  → success text seen'); break; }
      const btnTexts = await page.locator('button').evaluateAll(b => b.map(x => (x.innerText||'').trim())).catch(() => []);
      if (btnTexts.includes('BUY') && Date.now() > deadline - 10000) { log('  → BUY back (probable success per 2026-04-26)'); break; }
      await page.waitForTimeout(400);
    }
    captured.push({ ts: Date.now(), kind: 'mark', label: 'POST_PROCESS_WAIT_DONE' });
    log('waiting 3s for tail-end calls');
    await page.waitForTimeout(3000);
  } catch (e) {
    log(`ERROR during capture: ${e.message}`);
  } finally {
    // Persist captured network calls + a summary index.
    const calls = captured.filter(c => c.kind !== 'mark');
    const marks = captured.filter(c => c.kind === 'mark');
    fs.writeFileSync(path.join(RUN_DIR, 'capture.json'), JSON.stringify(captured, null, 2));
    // Per-call file: easier to read individual payloads.
    const byCall = {};
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const m = c.url.replace('https://prod-mkt-gateway.mindbody.io', '').slice(0, 60).replace(/[^a-zA-Z0-9_-]/g, '_');
      const fname = `${String(i).padStart(3, '0')}_${c.kind}_${c.method}_${m}.json`;
      fs.writeFileSync(path.join(RUN_DIR, fname), JSON.stringify(c, null, 2));
    }
    fs.writeFileSync(path.join(RUN_DIR, 'marks.json'), JSON.stringify(marks, null, 2));
    log(`captured ${calls.length} request/response events + ${marks.length} marks → ${RUN_DIR}`);
    await page.screenshot({ path: path.join(RUN_DIR, 'final.png'), fullPage: true });
    await browser.close();

    // Auto-cancel best-effort. Do this even on capture error — if the booking
    // was created, we need to undo it.
    log('AUTO-CANCEL: invoking cancel-booking.js');
    const r = spawnSync('node', ['cancel-booking.js', '--date', dateArg, '--time', timeArg, '--kind', kindArg], { cwd: __dirname, encoding: 'utf8' });
    log(`  cancel exit=${r.status}; stdout:\n${r.stdout}\n  stderr:\n${r.stderr}`);
  }
})();
