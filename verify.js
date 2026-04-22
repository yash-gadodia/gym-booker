require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const SHOTS = path.join(__dirname, 'screenshots');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-SG', timezoneId: 'Asia/Singapore',
    storageState: fs.existsSync(path.join(__dirname, 'auth.json')) ? path.join(__dirname, 'auth.json') : undefined,
  });
  const page = await ctx.newPage();

  log('loading ragtag page with saved auth');
  await page.goto('https://www.mindbodyonline.com/explore/locations/ragtag', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Dismiss cookies (may re-appear in a fresh context)
  const cookieBtn = await page.$('button:has-text("AGREE AND PROCEED")');
  if (cookieBtn) { try { await cookieBtn.click(); } catch {} await page.waitForTimeout(1000); }

  // Click CLASSES
  const classesBtn = page.locator('button, a, [role="tab"]').filter({ hasText: /^(Classes|Schedule)$/i }).first();
  if (await classesBtn.count() > 0) { await classesBtn.click(); await page.waitForTimeout(2000); }

  // Click Thu23 tab
  const thuTab = page.locator('[class*="Day_item"]').filter({ hasText: /Thu\s*23/ }).first();
  await thuTab.click();
  await page.waitForTimeout(2500);

  // Find 5:30pm Open Gym leaf
  const leafRows = await page.locator('[class*="ClassTimeScheduleItemDesktop"]').all();
  log(`scanning ${leafRows.length} leaf rows for 5:30pm Open Gym...`);
  let status = 'NOT FOUND';
  for (let i = 0; i < leafRows.length; i++) {
    const t = (await leafRows[i].innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (/5:30\s*pm/i.test(t) && /Open Gym/i.test(t)) {
      if (/\bBOOKED\b/i.test(t) || /DETAILS/i.test(t)) status = '✅ BOOKED';
      else if (/BOOK NOW/i.test(t)) status = '❌ NOT BOOKED (still shows Book Now)';
      else status = `unknown: ${t}`;
      log(`  row ${i}: ${t.slice(0, 120)}`);
      break;
    }
  }
  log(`\nSTATUS: ${status}\n`);

  await page.screenshot({ path: path.join(SHOTS, 'verify.png'), fullPage: true });
  await browser.close();
})();
