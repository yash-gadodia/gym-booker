const { chromium } = require('playwright');
const fs = require('fs');

const WODUP_EMAIL = 'pirsquare.yash@gmail.com';
const WODUP_PASSWORD = '***REMOVED-SEE-COMMIT-MSG***';

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  // Read existing auth state from previous login
  const authPath = '/Users/yash/gym-booker/wodup-auth.json';
  if (fs.existsSync(authPath)) {
    console.log('Loading auth state...');
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    await context.addCookies(auth.cookies);
    auth.origins.forEach(o => {
      Object.entries(o.localStorage || {}).forEach(([k, v]) => {
        page.evaluate(([key, val]) => localStorage.setItem(key, val), [k, v]);
      });
    });
  }
  
  console.log('Navigating to Wodup...');
  await page.goto('https://www.wodup.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  
  // Check if we're logged in by looking for workout content
  const pageText = await page.evaluate(() => document.body.innerText);
  if (!pageText.includes('FIT')) {
    console.log('Not logged in, attempting login...');
    await page.goto('https://www.wodup.com/login', { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="username"]', WODUP_EMAIL);
    const pwInput = await page.$('input[type="password"]');
    await pwInput.fill(WODUP_PASSWORD);
    const submitBtn = await page.$('button[type="submit"]');
    await submitBtn.click();
    await page.waitForTimeout(5000);
  }
  
  console.log('Current URL:', page.url());
  
  // Explore calendar navigation
  console.log('\nLooking for date/calendar navigation...');
  const navElements = await page.evaluate(() => {
    const elements = [];
    
    // Look for date selectors
    document.querySelectorAll('[data-testid*="calendar"], [data-testid*="date"], [class*="calendar"], [class*="date"]').forEach(el => {
      elements.push({
        tag: el.tagName,
        class: el.className,
        id: el.id,
        testid: el.getAttribute('data-testid'),
        innerText: el.innerText?.slice(0, 100)
      });
    });
    
    return elements.slice(0, 10);
  });
  console.log('Calendar elements:', JSON.stringify(navElements, null, 2));
  
  // Try clicking on future date in the calendar
  console.log('\nLooking for May 21 (tomorrow) in calendar...');
  const dateLinks = await page.$$eval('a, button, div', els =>
    els.filter(e => /21|tomorrow/.test(e.innerText || '')).map(e => ({
      tag: e.tagName,
      text: e.innerText?.slice(0, 50),
      href: e.href,
      onclick: e.getAttribute('onclick')
    }))
  );
  console.log('Date-like elements:', JSON.stringify(dateLinks, null, 2));
  
  // Check URL structure by looking at links
  const allLinks = await page.$$eval('a[href]', links => 
    links.map(a => a.href).filter(h => h.includes('wodup')).slice(0, 10)
  );
  console.log('Sample links:', allLinks);
  
  // Look for day tabs (calendar view shows individual days)
  const dayTabs = await page.locator('button:has-text("21")');
  const count = await dayTabs.count();
  console.log(`Found ${count} elements with "21"`);
  
  if (count > 0) {
    console.log('Clicking on 21...');
    await dayTabs.first().click();
    await page.waitForTimeout(2000);
    console.log('URL after clicking 21:', page.url());
    
    // Get the workouts for that day
    const workoutText = await page.evaluate(() => document.body.innerText);
    fs.writeFileSync('/Users/yash/gym-booker/recon-wodup/may-21-workouts.txt', workoutText);
    console.log('May 21 workouts saved');
  }
  
  // Try navigating by URL pattern
  console.log('\nTrying direct URLs...');
  const testUrls = [
    'https://www.wodup.com/?date=2026-05-21',
    'https://www.wodup.com/calendar/2026-05-21',
    'https://www.wodup.com/workouts/2026-05-21',
    'https://www.wodup.com/date/2026-05-21',
  ];
  
  for (const url of testUrls) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => null);
      const text = await page.evaluate(() => document.body.innerText);
      if (text.includes('FIT') || text.includes('LIFT') || text.includes('20')) {
        console.log(`SUCCESS - URL pattern works: ${url}`);
        fs.writeFileSync('/Users/yash/gym-booker/recon-wodup/found-url-pattern.txt', url);
        await page.screenshot({ path: '/Users/yash/gym-booker/recon-wodup/date-nav-screenshot.png' });
        break;
      }
    } catch (e) {
      // Ignore
    }
  }
  
  await browser.close();
  console.log('Done');
}

main().catch(e => { console.error(e); process.exit(1); });
