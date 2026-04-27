// One-shot status check: was the Wed 2026-04-29 6:30am FIT actually booked?
// Loads the schedule for the target date and dumps the row text + button label.
require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

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

  log('loading ragtag with saved auth');
  await page.goto('https://www.mindbodyonline.com/explore/locations/ragtag', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const cookieBtn = await page.$('button:has-text("AGREE AND PROCEED")');
  if (cookieBtn) { try { await cookieBtn.click(); } catch {} await page.waitForTimeout(800); }

  // Detect logged-out state
  const loggedOut = await page.locator('button[data-name="NavigationBar.Login.Button"]').count();
  log(`logged-out indicator count: ${loggedOut}`);

  const classesBtn = page.locator('button, a, [role="tab"]').filter({ hasText: /^(Classes|Schedule)$/i }).first();
  if (await classesBtn.count() > 0) {
    await classesBtn.scrollIntoViewIfNeeded();
    await classesBtn.click();
    await page.waitForTimeout(3000);
  }

  // Click Wed 29 tab via JS dispatch (Mindbody's day strip is in a virtualized carousel)
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[class*="Day_item"]'));
    const wed = items.find(el => /WED\s*29/i.test(el.innerText));
    if (wed) wed.click();
  });
  await page.waitForTimeout(2500);

  await page.screenshot({ path: path.join(__dirname, 'check-status.png'), fullPage: true });

  const leafRows = await page.locator('[class*="ClassTimeScheduleItemDesktop"]').all();
  log(`scanning ${leafRows.length} rows on Wed 29 Apr`);
  for (let i = 0; i < leafRows.length; i++) {
    const t = (await leafRows[i].innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    log(`row ${i}: ${t.slice(0, 200)}`);
  }

  log('\n--- checking Tue 28 Apr ---');
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[class*="Day_item"]'));
    const t = items.find(el => /TUE\s*28/i.test(el.innerText));
    if (t) t.click();
  });
  await page.waitForTimeout(2000);
  const tueRows = await page.locator('[class*="ClassTimeScheduleItemDesktop"]').all();
  log(`scanning ${tueRows.length} rows on Tue 28 Apr`);
  for (let i = 0; i < tueRows.length; i++) {
    const t = (await tueRows[i].innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    log(`row ${i}: ${t.slice(0, 200)}`);
  }

  log('\n--- checking today Mon 27 Apr ---');
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[class*="Day_item"]'));
    const t = items.find(el => /MON\s*27/i.test(el.innerText));
    if (t) t.click();
  });
  await page.waitForTimeout(2000);
  const monRows = await page.locator('[class*="ClassTimeScheduleItemDesktop"]').all();
  log(`scanning ${monRows.length} rows on Mon 27 Apr`);
  for (let i = 0; i < monRows.length; i++) {
    const t = (await monRows[i].innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    log(`row ${i}: ${t.slice(0, 200)}`);
  }

  await browser.close();
})();
