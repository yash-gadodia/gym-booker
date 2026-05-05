// List a user's past attended classes from /explore/account/schedule (COMPLETED tab).
// Used by Lawrence's gym-actions.py wrapper for "what did I attend last week".
//
// Usage: node history.js --user <id> [--days N]   (default N=14)
// Output: single-line JSON to stdout. Logs to stderr.

require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { parseBookingCard } = require('./lib');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const userId = opt('user');
const days = parseInt(opt('days') || '14', 10);

function fail(reason, detail) {
  process.stdout.write(JSON.stringify({ ok: false, reason, detail }) + '\n');
  process.exit(1);
}

if (!userId) fail('bad-args', 'missing --user <id>');
if (!Number.isFinite(days) || days < 1 || days > 90) fail('bad-args', '--days must be 1..90');

const log = (...a) => console.error(`[${new Date().toISOString()}]`, ...a);

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
    log('loading /account/schedule');
    await page.goto('https://www.mindbodyonline.com/explore/account/schedule', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);
    const cookieBtn = await page.$('button:has-text("AGREE AND PROCEED")');
    if (cookieBtn) { try { await cookieBtn.click(); } catch {} await page.waitForTimeout(800); }

    log('clicking COMPLETED tab');
    const tab = page.locator('button, a, [role="tab"]').filter({ hasText: /^COMPLETED$/i }).first();
    if (await tab.count() === 0) {
      out = { ok: false, reason: 'no-completed-tab', detail: 'COMPLETED tab not found on /account/schedule' };
      return;
    }
    await tab.click({ timeout: 8000 });
    await page.waitForTimeout(2500);

    // Completed cards have no "Cancel" button, so the UPCOMING walk algorithm
    // doesn't apply. Dump the body, split into chunks at the day/weekday marker
    // ("28 Tuesday"), and run each chunk through parseBookingCard.
    const body = (await page.locator('body').innerText().catch(() => '')).replace(/ /g, ' ');

    // Match "DD Weekday" markers as chunk anchors.
    const re = /\b(\d{1,2})\s+(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*\b/gi;
    const positions = [];
    let m;
    while ((m = re.exec(body)) !== null) positions.push(m.index);

    const chunks = [];
    for (let i = 0; i < positions.length; i++) {
      const start = positions[i];
      const end = positions[i + 1] || Math.min(positions[i] + 600, body.length);
      chunks.push(body.slice(start, end));
    }

    const cards = chunks.map(parseBookingCard).filter(Boolean);

    // Filter by lookback window. parseBookingCard returns ymd; keep entries
    // within `days` days of today and not in the future (defensive — COMPLETED
    // should be all past).
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cutoffMs = today.getTime() - days * 86400000;
    const sessions = cards
      .filter(c => {
        const t = new Date(`${c.ymd}T00:00:00+08:00`).getTime();
        return t >= cutoffMs && t <= today.getTime() + 86400000;
      })
      .map(c => ({ date: c.ymd, dow: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(`${c.ymd}T00:00:00+08:00`).getDay()], kind: c.kind, time: c.time }))
      .sort((a, b) => b.date.localeCompare(a.date) || a.time.localeCompare(b.time));

    // Dedupe (same date+kind+time appearing twice from overlapping chunks).
    const seen = new Set();
    const unique = [];
    for (const s of sessions) {
      const k = `${s.date}|${s.kind}|${s.time}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(s);
    }

    out = { ok: true, user: userId, windowDays: days, count: unique.length, sessions: unique };
  } catch (e) {
    out = { ok: false, reason: 'exception', detail: e.message };
  } finally {
    await browser.close();
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(out.ok ? 0 : 1);
  }
})();
