// The single hardened Mindbody login path, shared by the booker (book.js) and
// the waitlist watcher (waitlist-watch.js). Before 2026-06-09 the watcher had
// its own fragile copy that did a bare `page.click` on the Login button — when
// Mindbody's consent overlay sat invisibly on top, that click hung the full
// 30s and threw (page.click: Timeout 30000ms), erroring EVERY watch poll for
// every user. This module is the booker's battle-tested flow: dismiss any
// overlay (ensureLoginUnblocked) and click the *visible* Login button
// (clickVisible, 5s/element) instead. One path, fixed once.
//
// Parameterized by { creds, log } so both callers inject their own creds source
// (keychain) and logger. Logic is otherwise verbatim from book.js's original.
const { LOGIN_BUTTON_SEL, OVERLAY_DISMISS_SELS, probeLoginButtonInBrowser } = require('./lib');

async function clickVisible(page, selector) {
  const els = await page.locator(selector).all();
  for (const el of els) {
    const r = await el.evaluate(n => n.getBoundingClientRect()).catch(() => null);
    if (!r || r.width === 0 || r.height === 0) continue;
    try { await el.click({ timeout: 5000 }); return { ok: true, rect: r }; } catch {}
  }
  return { ok: false };
}

// Generic z-stack guard: poll until the Login button is at the top of the click
// surface (not covered by any overlay). Asks "is the button clickable?" instead
// of "is the cookie banner here?", so it handles ANY overlay (cookie banner,
// newsletter modal, GDPR variant). Adding a dismiss pattern is one line in lib.js.
async function ensureLoginUnblocked(page, { maxWaitMs = 8000, log = () => {} } = {}) {
  const start = Date.now();
  let attempts = 0;
  let lastBlocker = null;
  while (Date.now() - start < maxWaitMs) {
    attempts++;
    const probe = await page.evaluate(probeLoginButtonInBrowser, LOGIN_BUTTON_SEL);

    if (probe.state === 'clear') {
      if (attempts > 1) log(`AUTH: Login unblocked after ${attempts} probes (${Date.now() - start}ms)`);
      return { ok: true };
    }
    if (probe.state === 'no-button') return { ok: true, reason: 'no-login-button' };
    lastBlocker = probe.state === 'covered' ? probe.blocker : probe.state;

    let dismissed = false;
    for (const sel of OVERLAY_DISMISS_SELS) {
      const el = await page.$(sel);
      if (!el) continue;
      try {
        await el.click({ timeout: 1500 });
        log(`AUTH: dismissed overlay via ${sel} (was blocked by: ${lastBlocker})`);
        await page.waitForTimeout(400);
        dismissed = true;
        break;
      } catch {}
    }
    await page.waitForTimeout(dismissed ? 200 : 400);
  }
  log(`AUTH: ensureLoginUnblocked TIMEOUT after ${attempts} probes — last blocker: ${lastBlocker}`);
  return { ok: false, blocker: lastBlocker, attempts };
}

async function loginAndSave(page, ctx, authPath, { creds, log = () => {} } = {}) {
  log('AUTH: re-login starting');
  if (!creds || !creds.email || !creds.password) {
    throw new Error('auth expired but Mindbody creds not available (keychain miss?) — check users.json + keychain');
  }
  // Confirm the Login button is on top of the z-stack before clicking. Handles
  // cookie banner, modals, or any other late-arriving overlay generically.
  const unblock = await ensureLoginUnblocked(page, { maxWaitMs: 8000, log });
  if (!unblock.ok) log(`AUTH: proceeding to click despite blocker (${unblock.blocker}) — Playwright may still recover`);
  let clicked = await clickVisible(page, 'button[data-name="NavigationBar.Login.Button"]');
  if (clicked.ok) log(`AUTH: clicked Login button (${clicked.rect.width}x${clicked.rect.height}) via data-name`);
  if (!clicked.ok) {
    for (const sel of [
      'button:has-text("Sign in")', 'a:has-text("Sign in")',
      'button:has-text("Log in")', 'a:has-text("Log in")',
    ]) {
      clicked = await clickVisible(page, sel);
      if (clicked.ok) { log(`AUTH: clicked ${sel} (text fallback)`); break; }
    }
  }
  if (!clicked.ok) throw new Error('auth expired and no visible Login button found');
  await page.waitForTimeout(2500);
  const emailInput = page.locator('input:visible').first();
  await emailInput.waitFor({ state: 'visible', timeout: 15000 });
  await emailInput.fill(creds.email);
  await page.click('button:has-text("Continue"), button:has-text("Next"), button[type="submit"]');
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.fill('input[type="password"]', creds.password);
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
    page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Continue")'),
  ]);
  await page.waitForTimeout(3000);
  await ctx.storageState({ path: authPath });
  log('AUTH: login complete, auth.json refreshed');
}

module.exports = { clickVisible, ensureLoginUnblocked, loginAndSave };
