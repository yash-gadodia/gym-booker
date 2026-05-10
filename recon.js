require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { getUser, getCreds } = require('./users');

// Recon defaults to Yash (super-admin, only one allowed for ad-hoc debug).
// Override via RECON_USER=<id> for a different user.
const reconUser = getUser(process.env.RECON_USER || 'yash');
const reconCreds = getCreds(reconUser);

const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

async function snap(page, name) {
  const p = path.join(SHOTS, `${String(Date.now()).slice(-8)}-${name}.png`);
  try {
    await page.screenshot({ path: p, fullPage: true });
    log(`📸 ${name} → ${p}`);
  } catch (e) { log(`snap failed ${name}:`, e.message); }
  return p;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-SG',
    timezoneId: 'Asia/Singapore',
  });
  const page = await ctx.newPage();

  const netlog = [];
  page.on('request', r => {
    const u = r.url();
    if (r.method() !== 'GET' || /book|reserve|sign|auth|login|class/i.test(u)) {
      netlog.push({ m: r.method(), u, t: Date.now() });
    }
  });
  page.on('response', async r => {
    if (r.request().method() !== 'GET' && r.status() >= 400) {
      log(`⚠️  ${r.request().method()} ${r.url()} → ${r.status()}`);
    }
  });

  try {
    log('STEP 1: ragtag landing');
    await page.goto('https://www.mindbodyonline.com/explore/locations/ragtag', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    log('   URL:', page.url());
    log('   TITLE:', await page.title());
    await snap(page, '01-landing');

    // Dismiss cookie consent if present
    log('STEP 1a: dismiss cookie banner');
    const cookieSelectors = [
      'button:has-text("AGREE AND PROCEED")', 'button:has-text("Agree and proceed")',
      'button:has-text("Accept")', 'button:has-text("Agree")',
      '[id*="cookie" i] button', '[class*="cookie" i] button',
    ];
    for (const sel of cookieSelectors) {
      const el = await page.$(sel);
      if (el) { try { await el.click({ timeout: 5000 }); log(`   dismissed via: ${sel}`); await page.waitForTimeout(1500); break; } catch (e) {} }
    }
    await snap(page, '02-post-cookie');

    // Find any "Sign in" / login trigger - try visible-only (cookie now gone)
    log('STEP 2: find login trigger');
    const loginCandidates = [
      'button:has-text("Sign in")', 'a:has-text("Sign in")',
      'button:has-text("Log in")', 'a:has-text("Log in")',
      '[data-testid*="login" i]', '[data-testid*="sign-in" i]',
      'a[href*="signin" i]', 'a[href*="login" i]',
    ];
    let loginEl = null;
    for (const sel of loginCandidates) {
      const els = await page.$$(sel);
      for (const el of els) {
        if (await el.isVisible()) { loginEl = el; log(`   found visible login via: ${sel}`); break; }
      }
      if (loginEl) break;
    }
    if (!loginEl) {
      // Maybe login is behind a "SIGN UP"/account menu button
      const hamburger = await page.$('button[aria-label*="menu" i], button:has-text("SIGN UP"), button:has-text("Sign up"), [aria-label*="account" i]');
      if (hamburger) { log('   opening menu'); await hamburger.click(); await page.waitForTimeout(1500); await snap(page, '02b-menu-open'); }
      for (const sel of loginCandidates) {
        const els = await page.$$(sel);
        for (const el of els) if (await el.isVisible()) { loginEl = el; log(`   found after menu via: ${sel}`); break; }
        if (loginEl) break;
      }
    }
    if (!loginEl) {
      const allText = await page.$$eval('a, button', els => els.slice(0, 80).map(e => ({
        tag: e.tagName, text: (e.innerText || '').trim().slice(0, 50), href: (e.href || '').slice(0, 80),
        visible: !!(e.offsetWidth || e.offsetHeight),
      })).filter(x => x.text && x.visible));
      log('   visible links/buttons:');
      for (const t of allText) log('     ', t.tag, '|', t.text, '|', t.href);
      await snap(page, 'ERROR-nologin');
      throw new Error('login element not found');
    }
    await loginEl.click();
    await page.waitForTimeout(2500);
    log('   post-click URL:', page.url());
    await snap(page, '03-after-login-click');

    log('STEP 3: enter email');
    // Email input on this page has label "Email" but isn't type="email"; use first visible input
    const emailInput = page.locator('input:visible').first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await emailInput.fill(reconCreds.email);
    await snap(page, '04-email-filled');
    // Two-step: click Continue
    await page.click('button:has-text("Continue"), button:has-text("Next"), button[type="submit"]');
    log('   continue clicked, waiting for password page');
    await page.waitForSelector('input[type="password"]', { timeout: 20000 });
    await page.waitForTimeout(800);
    await snap(page, '05a-password-page');

    log('STEP 3b: enter password');
    await page.fill('input[type="password"]', reconCreds.password);
    await snap(page, '05b-password-filled');
    // Submit
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
      page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Continue")'),
    ]);
    await page.waitForTimeout(3000);
    log('   post-login URL:', page.url());
    await snap(page, '06-post-login');

    log('STEP 4: navigate to schedule');
    await page.goto('https://www.mindbodyonline.com/explore/locations/ragtag', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Dump top-level nav tabs to find Schedule tab
    log('STEP 4a: dump visible nav tabs');
    const tabs = await page.$$eval('a, button, [role="tab"]', els => {
      const out = [];
      for (const el of els) {
        if (!(el.offsetWidth || el.offsetHeight)) continue;
        const t = (el.innerText || '').trim();
        if (!t || t.length > 40) continue;
        if (/^(info|schedule|services|staff|reviews|classes|about)$/i.test(t)) {
          out.push({ tag: el.tagName, text: t, cls: (el.className || '').toString().slice(0, 40) });
        }
      }
      return out;
    });
    log(`   found ${tabs.length} nav tabs:`);
    for (const t of tabs) log('     ', t.tag, '|', t.text, '|', t.cls);

    log('STEP 4b: click CLASSES toggle');
    const schedTab = page.locator('button, a, [role="tab"]').filter({ hasText: /^(Classes|Schedule)$/i }).first();
    if (await schedTab.count() > 0) {
      await schedTab.scrollIntoViewIfNeeded();
      await schedTab.click();
      log('   clicked CLASSES toggle');
      await page.waitForTimeout(2500);
    } else {
      log('   no CLASSES toggle found');
    }
    await snap(page, '07-schedule-visible');

    log('STEP 5: click Thu23 tab');
    // Day tabs have class Day_item__XXX with text like "Thu23"
    const thuTab = page.locator('[class*="Day_item"]').filter({ hasText: /Thu\s*23/ }).first();
    await thuTab.waitFor({ state: 'visible', timeout: 10000 });
    await thuTab.click();
    await page.waitForTimeout(2500);
    await snap(page, '08-thursday-selected');

    log('STEP 6: find 5:30pm Open Gym row (leaf-level only)');
    // Target leaf class row — ClassTimeScheduleItemDesktop is the row with Book Now button per text dump
    const leafRows = await page.locator('[class*="ClassTimeScheduleItemDesktop"]').all();
    log(`   ${leafRows.length} leaf ClassTimeScheduleItemDesktop rows on page`);
    let targetRow = null;
    for (let i = 0; i < leafRows.length; i++) {
      const t = (await leafRows[i].innerText().catch(() => '')).replace(/\s+/g, ' ');
      const isTarget = /5:30\s*pm/i.test(t) && /Open Gym/i.test(t) && /Book Now/i.test(t);
      log(`   leaf ${i}${isTarget ? ' ← TARGET' : ''}: ${t.slice(0, 120)}`);
      if (isTarget && !targetRow) targetRow = leafRows[i];
    }
    if (!targetRow) throw new Error('5:30pm Open Gym row with Book Now not found on Thu 23-04-2026');
    await targetRow.scrollIntoViewIfNeeded();
    await snap(page, '09-target-row-in-view');

    log('STEP 7: click Book Now');
    const bookBtn = targetRow.locator('button:has-text("Book Now")').first();
    await bookBtn.waitFor({ state: 'visible', timeout: 5000 });
    const t0 = Date.now();
    await bookBtn.click();
    log(`   Book Now clicked at t=${t0}`);
    await page.waitForTimeout(1500);
    log('   post-click URL:', page.url());
    await snap(page, '10-after-book-click');

    log('STEP 8: wait for checkout to load past "Preparing Checkout..."');
    // Wait for any confirm/reserve/purchase button to appear
    try {
      await page.waitForSelector('button:has-text("Confirm"), button:has-text("Reserve"), button:has-text("Complete"), button:has-text("Pay"), button:has-text("Book"), button:has-text("Purchase")', { timeout: 30000 });
      log('   confirm-style button detected');
    } catch (e) {
      log('   no confirm button appeared within 30s');
    }
    await page.waitForTimeout(1500);
    await snap(page, '10b-checkout-loaded');

    // Dump visible checkout UI for inspection
    const coUi = await page.$$eval('button, h1, h2, h3, h4, [class*="price"], [class*="Price"], [class*="total"], [class*="Total"]', els => {
      const out = [];
      for (const el of els) {
        if (!(el.offsetWidth || el.offsetHeight)) continue;
        const t = (el.innerText || '').trim();
        if (!t || t.length > 200) continue;
        out.push({ tag: el.tagName, text: t.slice(0, 120), cls: (el.className || '').toString().slice(0, 40) });
        if (out.length > 40) break;
      }
      return out;
    });
    log('   checkout visible elements:');
    for (const t of coUi) log('     ', t.tag, '|', t.cls, '|', t.text);

    log('STEP 9: click BUY to complete booking');
    const confirmBtn = page.locator('button').filter({ hasText: /^(BUY|Confirm|Reserve|Complete|Complete Purchase|Place Order)$/i }).first();
    if (await confirmBtn.count() > 0) {
      const btnText = await confirmBtn.innerText();
      log(`   clicking: "${btnText}"`);
      await confirmBtn.click();
      // Wait for success indicator — URL change, "thank you" / "confirmed" text, or modal close
      try {
        await page.waitForFunction(() => {
          const txt = document.body.innerText;
          return /thank you|reserved|confirmed|booking confirmed|your order|you're in|see you/i.test(txt) ||
                 location.href.includes('confirmation') || location.href.includes('success');
        }, null, { timeout: 30000 });
        log('   ✅ success text detected');
      } catch (e) {
        log('   ⚠️  no success text in 30s, snapping anyway');
      }
      await page.waitForTimeout(1500);
      log('   final URL:', page.url());
      await snap(page, '11-after-buy');
      // Dump final visible text to confirm
      const finalState = await page.$$eval('h1, h2, h3, h4, p, button', els => {
        const out = [];
        for (const el of els) {
          if (!(el.offsetWidth || el.offsetHeight)) continue;
          const t = (el.innerText || '').trim();
          if (!t || t.length > 200) continue;
          if (/thank|confirm|reserved|booked|success|welcome|your|you|see you|added/i.test(t)) {
            out.push({ tag: el.tagName, text: t.slice(0, 160) });
            if (out.length > 20) break;
          }
        }
        return out;
      });
      log('   final-state text:');
      for (const t of finalState) log('     ', t.tag, '|', t.text);
    } else {
      log('   ⚠️  no BUY button found');
    }

    await snap(page, '99-final');
  } catch (e) {
    log('❌ ERROR:', e.message);
    await snap(page, 'ERROR');
  } finally {
    log('STEP 99: saving auth state + network log');
    try { await ctx.storageState({ path: path.join(__dirname, 'auth.json') }); log('   auth saved'); } catch (e) { log('   auth save failed:', e.message); }
    fs.writeFileSync(path.join(__dirname, 'netlog.json'), JSON.stringify(netlog, null, 2));
    log(`   netlog: ${netlog.length} entries → netlog.json`);
    await browser.close();
    log('DONE');
  }
})();
