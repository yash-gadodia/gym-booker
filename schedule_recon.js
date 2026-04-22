require('dotenv').config({ path: '/Users/yash/gym-booker/.env' });
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }, locale: 'en-SG', timezoneId: 'Asia/Singapore',
    storageState: '/Users/yash/gym-booker/auth.json',
  });
  const page = await ctx.newPage();
  await page.goto('https://www.mindbodyonline.com/explore/locations/ragtag', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  const cookieBtn = await page.$('button:has-text("AGREE AND PROCEED")');
  if (cookieBtn) { try { await cookieBtn.click(); } catch {} await page.waitForTimeout(1000); }
  const classesBtn = page.locator('button, a, [role="tab"]').filter({ hasText: /^(Classes|Schedule)$/i }).first();
  if (await classesBtn.count() > 0) { await classesBtn.click(); await page.waitForTimeout(2000); }
  // Dump day tabs
  const dayTabs = await page.$$eval('[class*="Day_item"]', els => els.filter(e => e.offsetWidth || e.offsetHeight).map(e => (e.innerText || '').replace(/\s+/g,' ').trim()));
  console.log('DAY TABS:', JSON.stringify(dayTabs, null, 2));
  // Walk each day tab and log FIT + Gymnastics classes
  for (let i = 0; i < dayTabs.length; i++) {
    try {
      const tab = page.locator('[class*="Day_item"]').nth(i);
      await tab.click();
      await page.waitForTimeout(1500);
      const rows = await page.locator('[class*="ClassTimeScheduleItemDesktop"]').all();
      const matches = [];
      for (const r of rows) {
        const t = (await r.innerText().catch(() => '')).replace(/\s+/g,' ');
        if (/fit|gymnastic/i.test(t)) matches.push(t.slice(0, 140));
      }
      console.log(`\n=== ${dayTabs[i]} ===`);
      if (matches.length === 0) console.log('  (no FIT / Gymnastics classes)');
      for (const m of matches) console.log('  -', m);
    } catch (e) { console.log(`day ${i}: err ${e.message}`); }
  }
  await browser.close();
})();
