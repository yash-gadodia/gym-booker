// Cancel a single booking from /explore/account/schedule by matching kind+time+date.
// Usage: node cancel-booking.js --date 2026-04-28 --time 8:30am [--kind FIT] [--dry-run]
require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i+1] && !args[i+1].startsWith('--') ? args[i+1] : null; };
const dateArg = opt('date');
const timeArg = opt('time');
const kindArg = opt('kind') || 'FIT';
const dryRun = args.includes('--dry-run');

if (!dateArg || !timeArg) {
  console.error('Usage: node cancel-booking.js --date YYYY-MM-DD --time H:MMam [--kind FIT|Gymnastics] [--dry-run]');
  process.exit(2);
}

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-SG', timezoneId: 'Asia/Singapore',
    storageState: fs.existsSync(path.join(__dirname, 'auth.json')) ? path.join(__dirname, 'auth.json') : undefined,
  });
  const page = await ctx.newPage();

  log(`target: ${kindArg} @ ${timeArg} on ${dateArg} (dryRun=${dryRun})`);
  await page.goto('https://www.mindbodyonline.com/explore/account/schedule', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3500);

  const cookieBtn = await page.$('button:has-text("AGREE AND PROCEED")');
  if (cookieBtn) { try { await cookieBtn.click(); } catch {} await page.waitForTimeout(800); }

  // Day-of-month, used to pick the right card.
  const dayOfMonth = String(parseInt(dateArg.split('-')[2], 10));

  // Each booking is a card containing day, kind, time, and a "Cancel" button.
  // The on-page card walk often surfaces only a narrow snippet (e.g. "8:30am
  // (60 min) Cancel"), so walk further up and grab the LARGEST informative
  // ancestor block instead of the first match.
  const cancelBtns = await page.locator('button:has-text("Cancel"), a:has-text("Cancel")').all();
  log(`found ${cancelBtns.length} Cancel buttons on page`);

  const timeRe = new RegExp(timeArg.replace(':', '\\:'), 'i');
  let target = null;
  for (let i = 0; i < cancelBtns.length; i++) {
    // Walk up until we find the smallest ancestor that still contains exactly
    // ONE "Cancel" button — that's this booking's card boundary. Going further
    // up would merge in the next booking's card.
    const cardText = await cancelBtns[i].evaluate(btn => {
      let n = btn.parentElement;
      let best = (btn.innerText || '').trim();
      for (let j = 0; j < 15 && n; j++) {
        const cancelCount = n.querySelectorAll('button, a').length === 0
          ? 0
          : Array.from(n.querySelectorAll('button, a')).filter(e => /^Cancel$/i.test((e.innerText || '').trim())).length;
        if (cancelCount > 1) break;  // walked too far — into a multi-card container
        const t = (n.innerText || '').trim();
        if (t.length > best.length && t.length < 600) best = t;
        n = n.parentElement;
      }
      return best;
    }).catch(() => '');
    const flat = cardText.replace(/\s+/g, ' ');
    const dayMatch = new RegExp(`\\b${dayOfMonth}\\b`).test(flat);
    const kindMatch = new RegExp(kindArg, 'i').test(flat);
    const timeMatch = timeRe.test(flat);
    log(`  card ${i} (day=${dayMatch} kind=${kindMatch} time=${timeMatch}): ${flat.slice(0, 250)}`);
    if (timeMatch && (dayMatch || kindMatch)) {
      target = { btn: cancelBtns[i], card: flat };
      log(`  → MATCH`);
      break;
    }
  }

  if (!target) { log('no matching booking found — aborting'); await browser.close(); process.exit(1); }
  log(`MATCHED CARD: ${target.card.slice(0, 300)}`);

  if (dryRun) { log('DRY RUN — not clicking Cancel'); await browser.close(); return; }

  log('clicking Cancel');
  await target.btn.click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(__dirname, 'cancel-modal.png'), fullPage: true });

  // A confirmation modal usually appears. Look for the affirmative button.
  // Avoid clicking "Cancel" inside the modal (would dismiss without cancelling the booking).
  for (const sel of [
    'button:has-text("Yes, cancel")',
    'button:has-text("Cancel booking")',
    'button:has-text("Cancel Booking")',
    'button:has-text("Cancel reservation")',
    'button:has-text("Confirm")',
    'button:has-text("Yes")',
    '[role="dialog"] button:has-text("Cancel")',
  ]) {
    const m = await page.locator(sel).all();
    for (const b of m) {
      const txt = (await b.innerText().catch(() => '')).trim();
      // Skip the close ("X") and any plain "Cancel" outside a dialog.
      if (!txt) continue;
      try {
        await b.click({ timeout: 3000 });
        log(`  confirm clicked: "${txt}" (${sel})`);
        await page.waitForTimeout(2500);
        await page.screenshot({ path: path.join(__dirname, 'cancel-after.png'), fullPage: true });
        await browser.close();
        return;
      } catch {}
    }
  }

  log('no confirmation button found — booking may not have been cancelled. Check screenshot.');
  await browser.close();
})();
