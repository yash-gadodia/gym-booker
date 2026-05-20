// List all classes at Ragtag for a given SGT date.
// Used by Lawrence's gym-actions.py wrapper so the agent stops hallucinating schedules.
//
// Usage:
//   node list-classes.js --user <id> --date YYYY-MM-DD
//
// Output: single-line JSON to stdout. Logs to stderr.
//   { ok: true, date, count, classes: [{ time, durationMin, kind, instructor, bookable, statusText }] }

require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { captureBearerToken, fetchScheduleClasses } = require('./api-client');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const userId = opt('user');
const dateArg = opt('date');

function fail(reason, detail) {
  process.stdout.write(JSON.stringify({ ok: false, reason, detail }) + '\n');
  process.exit(1);
}

if (!userId) fail('bad-args', 'missing --user <id>');
if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) fail('bad-args', 'missing/bad --date YYYY-MM-DD');

const log = (...a) => console.error(`[${new Date().toISOString()}]`, ...a);

function sgtHHMM(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false,
  });
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
    const raw = await fetchScheduleClasses(bearer, { fromIso, toIso });

    const classes = raw.map(c => {
      const start = c.startTime;
      const end = c.endTime;
      const durationMin = start && end ? Math.round((new Date(end) - new Date(start)) / 60000) : null;
      const staff = c.raw && c.raw.staff;
      const instructor = (staff && (staff.name || (staff.firstName && `${staff.firstName} ${staff.lastName || ''}`.trim()))) || null;
      return {
        time: sgtHHMM(start),
        startTime: start,
        endTime: end,
        durationMin,
        kind: c.courseName,
        instructor,
        bookable: !!c.bookable,
        statusText: c.statusText || null,
      };
    }).sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));

    out = { ok: true, date: dateArg, count: classes.length, classes };
  } catch (e) {
    out = { ok: false, reason: 'exception', detail: e.message };
  } finally {
    await browser.close();
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(out.ok ? 0 : 1);
  }
})();
