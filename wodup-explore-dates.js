const { chromium } = require('playwright');
const fs = require('fs');

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: '/Users/yash/gym-booker/wodup-auth.json'
  });
  const page = await context.newPage();
  
  console.log('Navigating to Wodup...');
  await page.goto('https://www.wodup.com/', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForTimeout(3000);
  
  console.log('Current URL:', page.url());
  
  // Get page info
  const pageInfo = await page.evaluate(() => {
    return {
      title: document.title,
      hasWorkouts: document.body.innerText.includes('FIT'),
      buttons: Array.from(document.querySelectorAll('button')).slice(0, 20).map(b => b.innerText.slice(0, 40)),
      links: Array.from(document.querySelectorAll('a[href]')).filter(a => !a.href.includes('apple') && !a.href.includes('facebook')).slice(0, 15).map(a => ({
        text: a.innerText.slice(0, 30),
        href: a.href
      }))
    };
  });
  
  console.log('Page info:', JSON.stringify(pageInfo, null, 2));
  
  // Look for 21 in the calendar
  const mayTwentyOne = await page.locator('[class*="calendar"] button, [class*="day"] button, button:has-text("21")');
  const count = await mayTwentyOne.count();
  console.log(`Found ${count} elements with "21" or in calendar`);
  
  if (count > 0) {
    console.log('Clicking first element with "21"...');
    await mayTwentyOne.first().click();
    await page.waitForTimeout(3000);
    console.log('URL after click:', page.url());
  }
  
  // Take screenshot
  await page.screenshot({ path: '/Users/yash/gym-booker/recon-wodup/current-view.png', fullPage: true });
  
  // Get full text
  const text = await page.evaluate(() => document.body.innerText);
  fs.writeFileSync('/Users/yash/gym-booker/recon-wodup/current-view.txt', text);
  
  // Look at network activity for clues
  const requests = [];
  page.on('response', r => {
    if (r.url().includes('wodup') && (r.url().includes('graphql') || r.url().includes('api'))) {
      requests.push(r.url());
    }
  });
  
  // Click around to trigger requests
  console.log('\nLooking for API calls...');
  const dateButtons = await page.$$('[class*="calendar"] button');
  if (dateButtons.length > 0) {
    console.log(`Found ${dateButtons.length} calendar buttons`);
    await dateButtons[3]?.click?.().catch(() => {});
    await page.waitForTimeout(2000);
  }
  
  console.log('Sample API requests:',requests.slice(0, 5));
  
  await page.screenshot({ path: '/Users/yash/gym-booker/recon-wodup/explore-screenshot.png', fullPage: true });
  
  await browser.close();
  console.log('Done');
}

main().catch(e => { console.error(e); process.exit(1); });
