require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');

const WODUP_EMAIL = process.env.WODUP_EMAIL || 'pirsquare.yash@gmail.com';
const WODUP_PASSWORD = process.env.WODUP_PASSWORD;
if (!WODUP_PASSWORD) {
  console.error('WODUP_PASSWORD missing — set in .env (this file used to hardcode it, was leaked, scrubbed via filter-repo on 2026-05-22)');
  process.exit(1);
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  console.log('Navigating to login page...');
  await page.goto('https://www.wodup.com/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  
  // Fill and submit
  try {
    console.log('Filling username...');
    await page.fill('input[name="username"]', WODUP_EMAIL);
    
    console.log('Filling password...');
    const pwInput = await page.$('input[type="password"]');
    await pwInput.fill(WODUP_PASSWORD);
    
    // Find submit button
    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      console.log('Clicking submit...');
      await submitBtn.click();
      
      // Wait for navigation (might go to /account or /dashboard)
      try {
        await page.waitForURL('**', { timeout: 10000 });
        await page.waitForTimeout(3000);
      } catch (e) {
        console.log('Navigation wait timed out, checking current state...');
      }
    }
  } catch (e) {
    console.log('Error during login:', e.message);
  }
  
  console.log('Final URL:', page.url());
  
  // Save screenshot
  await page.screenshot({ path: '/Users/yash/gym-booker/recon-wodup/screenshot.png', fullPage: true });
  
  // Get page text
  const text = await page.evaluate(() => document.body.innerText);
  fs.writeFileSync('/Users/yash/gym-booker/recon-wodup/page-text.txt', text);
  console.log('First 1000 chars of page:\n', text.slice(0, 1000));
  
  // Save auth state
  const storageState = await context.storageState();
  fs.writeFileSync('/Users/yash/gym-booker/wodup-auth.json', JSON.stringify(storageState, null, 2), { mode: 0o600 });
  
  console.log('Recon complete. Keeping browser open for 30s for manual inspection...');
  await page.waitForTimeout(30000);
  
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
