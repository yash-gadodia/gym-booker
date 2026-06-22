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
function makeFakes({ probeStates }) {
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
    waitForSelector: async () => {},
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
