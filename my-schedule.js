// Dumps the user's actual upcoming bookings from /explore/account/schedule.
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

  log('loading /explore/account/schedule');
  await page.goto('https://www.mindbodyonline.com/explore/account/schedule', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);
  log(`  url: ${page.url()}`);
  log(`  title: ${await page.title()}`);

  const cookieBtn = await page.$('button:has-text("AGREE AND PROCEED")');
  if (cookieBtn) { try { await cookieBtn.click(); } catch {} await page.waitForTimeout(800); }

  await page.screenshot({ path: path.join(__dirname, 'my-schedule.png'), fullPage: true });

  // Dump everything that looks like a booked class
  const bodyText = (await page.locator('body').innerText().catch(() => '')).replace(/\n+/g, '\n').trim();
  log('\n--- account schedule body text (first 4000 chars) ---');
  log(bodyText.slice(0, 4000));
  log('---');

  await browser.close();
})();
