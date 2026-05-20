const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const authPath = path.join('/Users/yash/gym-booker', 'users-auth/melissa.json');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-SG',
    timezoneId: 'Asia/Singapore',
    storageState: fs.existsSync(authPath) ? authPath : undefined,
  });
  const page = await ctx.newPage();

  let capturedRequests = [];
  page.on('request', (req) => {
    if (req.url().includes('mindbody.io') || req.url().includes('/api/')) {
      const entry = {
        method: req.method(),
        url: req.url(),
        headers: req.headers(),
        postData: req.postData(),
        timestamp: new Date().toISOString(),
      };
      capturedRequests.push(entry);
      console.log(`[REQ] ${req.method()} ${req.url()}`);
    }
  });

  page.on('response', (res) => {
    if (res.url().includes('mindbody.io') || res.url().includes('/api/')) {
      res.text().then(text => {
        const matchingReq = capturedRequests.find(r => r.url === res.url());
        if (matchingReq) {
          matchingReq.responseStatus = res.status();
          matchingReq.responseBody = text.slice(0, 1000);
          console.log(`[RES] ${res.status()} ${res.url()}`);
        }
      }).catch(() => {});
    }
  });

  console.log('navigating to ragtag schedule...');
  await page.goto('https://www.mindbodyonline.com/explore/locations/ragtag', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Accept privacy
  for (const sel of ['button:has-text("AGREE")', '#onetrust-accept-btn-handler']) {
    try {
      const el = await page.$(sel);
      if (el) await el.click({ timeout: 2000 });
    } catch {}
  }
  await page.waitForTimeout(1000);

  console.log('searching for 7:30am FIT class...');
  // Use the existing API call to find the class
  const bodyText = await page.innerText('body');
  console.log(`page has ${bodyText.length} chars`);

  // Look for any button with "JOIN" text
  const joinBtns = await page.locator('button:has-text("JOIN")').count();
  console.log(`found ${joinBtns} buttons with JOIN text`);

  if (joinBtns > 0) {
    console.log('clicking first JOIN button...');
    const btn = await page.locator('button:has-text("JOIN")').first();
    const btnText = await btn.textContent();
    console.log(`button text: "${btnText}"`);
    
    await btn.click();
    await page.waitForTimeout(3000);
  }

  console.log('\n=== CAPTURED REQUESTS ===');
  capturedRequests.forEach((req, i) => {
    console.log(`\n[${i}] ${req.method} ${req.url}`);
    console.log(`    headers.authorization: ${(req.headers.authorization || 'none').slice(0, 50)}...`);
    if (req.postData) {
      console.log(`    postData: ${req.postData.slice(0, 200)}`);
    }
    console.log(`    response status: ${req.responseStatus || '?'}`);
  });

  fs.writeFileSync('/tmp/waitlist-recon.json', JSON.stringify(capturedRequests, null, 2));
  console.log('\nsaved to /tmp/waitlist-recon.json');

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
