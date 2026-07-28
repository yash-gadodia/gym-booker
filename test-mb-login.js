// Regression test for the 2026-06-22 missed booking: the proactive re-login
// (decideAuthAction, headroom > 180s) ran while the cached session was still
// logged IN, so the page had NO Login button and loginAndSave threw
// "auth expired and no visible Login button found" — Yash + Chew Yien missed FIT.
// The fix: when no Login button is present, clearSessionAndReload (cookies +
// web storage) so the button reappears, then log in fresh.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const { clearSessionAndReload, loginAndSave } = require('./mb-login');

// Minimal Playwright-shaped fakes. probeStates drives what the in-page Login
// button probe "sees" on successive ensureLoginUnblocked polls.
// ssoText: what document.body.innerText "contains" after the email step. The
// 27-07 SSO guard races waitForSelector(password) against waitForFunction(body
// text), so the fakes must model BOTH — when this was added the fakes only had
// waitForSelector and every loginAndSave test blew up on
// `page.waitForFunction is not a function` (caught 28-07, one day of red).
function makeFakes({ probeStates, ssoText = null, passwordAppears = true }) {
  const calls = { clearCookies: 0, gotos: [], storageCleared: 0, filled: [], clicks: [] };
  let probeIdx = 0;
  const el = {
    evaluate: async () => ({ width: 80, height: 56 }), // visible rect
    click: async () => { calls.clicks.push('login-button'); },
    waitFor: async () => {},
    fill: async (v) => { calls.filled.push(v); },
  };
  const page = {
    url: () => 'https://www.ragtagfitness.com/explore',
    evaluate: async (fn, arg) => {
      if (arg !== undefined) {                 // probeLoginButtonInBrowser(selector)
        const s = probeStates[Math.min(probeIdx++, probeStates.length - 1)];
        return { state: s, blocker: 'x' };
      }
      calls.storageCleared++;                   // local/sessionStorage clear
      return undefined;
    },
    $: async () => null,                        // no overlays
    locator: () => ({ all: async () => [el], first: () => el }),
    waitForTimeout: async () => {},
    goto: async (url) => { calls.gotos.push(url); },
    click: async (sel) => { calls.clicks.push(sel); },
    fill: async (sel, v) => { calls.filled.push(v); },
    // Resolves only if the password field is expected to appear; otherwise it
    // never settles, exactly like the real 20s timeout on an SSO-only page.
    waitForSelector: async () => { if (!passwordAppears) return new Promise(() => {}); },
    // Mirrors Playwright: resolves with the predicate's truthy value, never
    // settles while the predicate is falsy.
    waitForFunction: async (fn) => {
      const doc = { body: { innerText: ssoText || '' } };
      const prev = global.document;
      global.document = doc;
      try {
        const v = fn();
        return v ? v : new Promise(() => {});
      } finally { global.document = prev; }
    },
    waitForLoadState: async () => {},
  };
  const ctx = {
    clearCookies: async () => { calls.clearCookies++; },
    storageState: async () => ({ cookies: [], origins: [] }),
  };
  return { page, ctx, calls };
}

test('clearSessionAndReload clears cookies + web storage and reloads current url', async () => {
  const { page, ctx, calls } = makeFakes({ probeStates: ['clear'] });
  await clearSessionAndReload(page, ctx, { log: () => {} });
  assert.strictEqual(calls.clearCookies, 1, 'cookies cleared');
  assert.strictEqual(calls.storageCleared, 1, 'web storage cleared');
  assert.deepStrictEqual(calls.gotos, ['https://www.ragtagfitness.com/explore'], 'reloaded same url');
});

test('loginAndSave: still logged-in (no Login button) -> clears session then logs in fresh', async () => {
  // First probe: no-button (we are still logged in). After clearSessionAndReload,
  // second probe: clear (the Login button is now present).
  const { page, ctx, calls } = makeFakes({ probeStates: ['no-button', 'clear'] });
  const authPath = path.join(os.tmpdir(), `mb-login-test-${process.pid}.json`);
  await loginAndSave(page, ctx, authPath, {
    creds: { email: 'a@b.com', password: 'pw' },
    log: () => {},
  });
  assert.strictEqual(calls.clearCookies, 1, 'session was torn down before re-login');
  assert.ok(calls.clicks.includes('login-button'), 'clicked the Login button after reload');
  assert.ok(calls.filled.includes('a@b.com'), 'filled email');
  assert.ok(calls.filled.includes('pw'), 'filled password');
});

test('loginAndSave: already logged-out (Login button present) -> no session teardown', async () => {
  const { page, ctx, calls } = makeFakes({ probeStates: ['clear'] });
  const authPath = path.join(os.tmpdir(), `mb-login-test2-${process.pid}.json`);
  await loginAndSave(page, ctx, authPath, {
    creds: { email: 'a@b.com', password: 'pw' },
    log: () => {},
  });
  assert.strictEqual(calls.clearCookies, 0, 'no teardown when Login button already present');
  assert.ok(calls.clicks.includes('login-button'), 'clicked the Login button');
});

test('loginAndSave: throws clear error when creds missing', async () => {
  const { page, ctx } = makeFakes({ probeStates: ['clear'] });
  await assert.rejects(
    () => loginAndSave(page, ctx, '/tmp/x.json', { creds: {}, log: () => {} }),
    /creds not available/,
  );
});

// --- Google-SSO detection (2026-07-28: Dani missed FIT @ 6:30am Thu 30-07) ---
//
// Mindbody identity provider 2.100.0 started routing accounts that were
// ORIGINALLY created via Google to /signin/external — a page offering only
// "Continue with Google", with no password field anywhere in the flow. Dani's
// stored password had worked every day through 26-07 and became unreachable on
// 27-07 with nothing changed on her side. loginAndSave must recognise this
// instantly and throw a typed, actionable error rather than burning 6 × 20s
// selector timeouts and reporting a generic failure.

test('SSO-linked account throws a typed SSO_LINKED error, not a selector timeout', async () => {
  const { page, ctx } = makeFakes({
    probeStates: ['clear'],
    passwordAppears: false,
    ssoText: 'You originally used Google to login to this account under x@gmail.com.\nContinue with Google',
  });
  await assert.rejects(
    () => loginAndSave(page, ctx, '/tmp/x.json', { creds: { email: 'a@b.com', password: 'pw' }, log: () => {} }),
    (e) => {
      assert.strictEqual(e.code, 'SSO_LINKED', 'typed so book.js can abort without retrying 6x');
      assert.strictEqual(e.provider, 'google');
      assert.match(e.message, /GOOGLE-SSO linked/);
      return true;
    },
  );
});

test('SSO detection distinguishes provider', async () => {
  const { page, ctx } = makeFakes({
    probeStates: ['clear'], passwordAppears: false, ssoText: 'Continue with Apple',
  });
  await assert.rejects(
    () => loginAndSave(page, ctx, '/tmp/x.json', { creds: { email: 'a@b.com', password: 'pw' }, log: () => {} }),
    (e) => e.code === 'SSO_LINKED' && e.provider === 'apple',
  );
});

test('a normal password account is NOT misread as SSO', async () => {
  // The password field wins the race; no SSO text present. Must log in cleanly.
  const { page, ctx, calls } = makeFakes({ probeStates: ['clear'], passwordAppears: true, ssoText: null });
  await loginAndSave(page, ctx, `${require('node:os').tmpdir()}/mb-sso-neg-${process.pid}.json`, {
    creds: { email: 'a@b.com', password: 'pw' }, log: () => {},
  });
  assert.ok(calls.filled.includes('pw'), 'password was filled — no false SSO abort');
});
