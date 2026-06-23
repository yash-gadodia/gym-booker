require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const {
  DAY_SHORT, addDays, ymd, classPlan, normalize, rowMatches, rowStatus,
  decideNextAction, isBookingWindowErrorText, isLoginRedirectUrl,
  classifyButtonStates, parseBookingCard, timeToHHMM, resolveSchedule,
  loadOverrides, resolveBookingForDate, resolveBookingsForDate,
  isBookingInUpcoming, findBookingInUpcoming, isInventoryRowRace,
  navRetryPlan, canRetrySetup, storageStatePathIfValid, saveStorageStateAtomic,
  SETUP_COMPLETE_MARKER, resolveSprintTarget,
  decideAuthAction, shouldRetryPassFetchPreWindow,
  LOGIN_BUTTON_SEL, OVERLAY_DISMISS_SELS, YASH_ALERT_CHAT_ID,
  probeLoginButtonInBrowser, buildSetupFailureAlert, sendYashAlert,
} = require('./lib');
const {
  captureBearerToken, fetchScheduleClasses, findClass,
  fetchPaymentPassUuid, createOrder, warmConnection, bookViaApi, generateRecaptchaToken,
} = require('./api-client');
const usersLib = require('./users');
const personality = require('./personality');
const { loginAndSave } = require('./mb-login');

const GYM_URL = 'https://www.mindbodyonline.com/explore/locations/ragtag';
const SGT_TZ = 'Asia/Singapore';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noWait = args.includes('--now') || args.includes('--no-wait');
const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
// --time / --kind / --no-fallback: ad-hoc overrides for testing without changing classPlan defaults.
// Example: node book.js 2026-04-28 --now --time 8:30am --kind FIT --no-fallback
function getOpt(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}
const timeOverride = getOpt('time');
const kindOverride = getOpt('kind');
const noFallback = args.includes('--no-fallback');
// Synthetic failure flag: short-circuit inside the setup try-block so the
// alert path (tgYashAlert) can be verified end-to-end without breaking a real
// booking. Safe to run alongside --now to skip the 9am wait.
const simulateSetupFail = args.includes('--simulate-setup-fail');
// --user <id>: book on behalf of a non-default user from users.json. When unset,
// every code path below uses Yash's legacy .env / auth.json / runs/<ts>/ flow.
const userId = getOpt('user');
const user = userId ? usersLib.getUser(userId) : null;
// Safety guard: refuse to book if /account/schedule already has a same-kind
// booking on the target date. Override with --allow-duplicate (only for tests).
const allowDuplicate = args.includes('--allow-duplicate');
// API-direct mode: skip the React UI entirely (~2s vs ~12s). Default ON;
// disable with --no-api-direct to force the legacy UI flow.
const apiDirect = !args.includes('--no-api-direct');

const RUN_ID = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
const RUN_DIR = user
  ? usersLib.getRunsDir(user, RUN_ID)
  : path.join(__dirname, 'runs', RUN_ID);
fs.mkdirSync(RUN_DIR, { recursive: true });
const LOG_LINES = [];
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}`;
  console.log(line); LOG_LINES.push(line);
}
function flushLog() { try { fs.writeFileSync(path.join(RUN_DIR, 'run.log'), LOG_LINES.join('\n')); } catch {} }
async function snap(page, name) {
  const p = path.join(RUN_DIR, `${String(Date.now()).slice(-8)}-${name}.png`);
  try { await page.screenshot({ path: p, fullPage: true }); log(`snap ${name}`); } catch (e) { log('snap err', name, e.message); }
  return p;
}

// Navigate with bounded retries instead of one monolithic 30s goto. The
// 2026-06-06 wipeout: all 5 users died on the first page.goto when a load spike
// (5 Chromium cold-starts at once) made the nav time out at 30s, and the run
// had no budget left to recover. navRetryPlan sizes the attempts to the time
// left before the 9am sprint, so a transient blip is absorbed in a couple
// seconds while a genuinely-dead network still fails fast enough to alert.
async function gotoWithRetry(page, url, msRemaining = null, label = 'nav') {
  const { attempts, perAttemptMs, backoffMs } = navRetryPlan(msRemaining, { noWait });
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: perAttemptMs });
      if (i > 1) log(`${label}: goto recovered on attempt ${i}/${attempts}`);
      return;
    } catch (e) {
      lastErr = e;
      log(`${label}: goto attempt ${i}/${attempts} failed (${String(e.message).split('\n')[0].slice(0, 90)})`);
      if (i < attempts) {
        // A timed-out goto can leave its navigation in flight; a bare retry
        // then dies with "interrupted by another navigation" (2026-06-10, all
        // users' final attempt). Parking on about:blank cancels the stale nav.
        await page.goto('about:blank', { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(backoffMs);
      }
    }
  }
  throw lastErr;
}

// Interactive test modes (--dry-run / --now) skip telegram — otherwise every
// smoke-test spams the user's DMs. The real launchd run uses neither flag.
const suppressTg = dryRun || noWait;
// Resolve the Telegram destination once. For Yash (no --user): env TELEGRAM_CHAT_ID,
// no prefix. For other users: their own chat_id (or env fallback with [Label] prefix
// while their chat_id hasn't been captured yet).
const tgTarget = user
  ? usersLib.getTelegramTarget(user)
  : { chatId: process.env.TELEGRAM_CHAT_ID, prefix: '' };
async function tg(text) {
  if (suppressTg) { log(`tg: suppressed (dry/now mode): ${text.split('\n')[0]}`); return; }
  if (!process.env.TELEGRAM_BOT_TOKEN || !tgTarget.chatId) { log('tg: missing creds'); return; }
  const body = tgTarget.prefix ? `${tgTarget.prefix}${text}` : text;
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const post = async (b) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  try {
    let r = await post({ chat_id: tgTarget.chatId, text: body, parse_mode: 'Markdown', disable_web_page_preview: true });
    if (!r.ok) {
      const errText = await r.text();
      // Markdown is brittle — any unbalanced `_*[]` in dynamic content (e.g.
      // statusTitle="processing_requested") triggers a 400 "can't parse entities".
      // Fall back to plain text so the user always gets the booking outcome.
      if (r.status === 400 && /parse|entit/i.test(errText)) {
        log('tg FAIL (parse) — retrying as plain text');
        r = await post({ chat_id: tgTarget.chatId, text: `[parse fallback]\n${body}`, disable_web_page_preview: true });
        if (r.ok) { log('tg sent (plain fallback)'); return; }
        log('tg FAIL (plain retry)', r.status, await r.text());
        return;
      }
      log('tg FAIL', r.status, errText);
    } else { log('tg sent'); }
  } catch (e) { log('tg ERR', e.message); }
}

// Setup-failure alert wrapper — routes through lib.sendYashAlert so the HTTP
// path lives in one place. Always fires regardless of suppressTg (dry-run/now
// tests still page Yash by design).
async function tgYashAlert(text) {
  const ok = await sendYashAlert(text, { logger: (m) => log('alert:', m) });
  log(ok ? 'alert: sent to Yash' : 'alert: FAILED (see prior line)');
}

async function isLoggedOut(page) {
  const byDataName = await page.locator('button[data-name="NavigationBar.Login.Button"]').count();
  if (byDataName > 0) return true;
  const sel = 'button:has-text("Sign in"), a:has-text("Sign in"), button:has-text("Log in"), a:has-text("Log in")';
  const els = await page.locator(sel).all();
  for (const el of els) {
    const r = await el.evaluate(n => n.getBoundingClientRect()).catch(() => null);
    if (r && r.width > 0 && r.height > 0) return true;
  }
  return false;
}

// Resolve creds once. As of 2026-05-10, every user (including Yash) lives in
// users.json with creds in the keychain — pass `--user <id>` to look up.
// A bare `node book.js` (no --user) used to read MINDBODY_* from .env, but
// those were scrubbed in the keychain migration, which silently broke every
// ad-hoc/recovery invocation that needed a re-login (2026-06-10 09:07 run
// died exactly there). Fall back to Yash's keychain entry; the empty-creds
// guard in mb-login still catches the truly-unresolvable case.
const creds = user
  ? usersLib.getCreds(user)
  : (() => {
      if (process.env.MINDBODY_EMAIL && process.env.MINDBODY_PASSWORD) {
        return { email: process.env.MINDBODY_EMAIL, password: process.env.MINDBODY_PASSWORD };
      }
      try { return usersLib.getCreds(usersLib.getUser('yash')); }
      catch { return { email: undefined, password: undefined }; }
    })();

// Cookie banner appears asynchronously via OneTrust JS. On slow page loads it
// can arrive AFTER the initial 2.5s settle, then overlay the navbar and block
// Login clicks (caused the 2026-05-12 incident where 4/5 bookings failed). Pass
// maxWaitMs to poll until the banner shows up or the budget expires.
async function dismissCookieBanner(page, { maxWaitMs = 0 } = {}) {
  const selectors = [
    'button:has-text("AGREE AND PROCEED")',
    'button:has-text("Accept")',
    'button:has-text("I Agree")',
    '#onetrust-accept-btn-handler',
  ];
  const start = Date.now();
  do {
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) {
        try {
          await el.click({ timeout: 3000 });
          log(`cookie dismissed: ${sel}${maxWaitMs ? ` (after ${Date.now() - start}ms)` : ''}`);
          await page.waitForTimeout(600);
          return true;
        } catch {}
      }
    }
    if (maxWaitMs > 0) await page.waitForTimeout(250);
  } while (Date.now() - start < maxWaitMs);
  return false;
}

async function clickClassesTab(page) {
  for (let i = 0; i < 4; i++) {
    // The current Mindbody explore page renders the schedule directly — there
    // is no Classes/Schedule tab at all (2026-06-10: every UI-fallback run died
    // here hunting for one). If the day chips are already visible, the schedule
    // is on screen and there is nothing to click.
    const dayChip = page.locator('[class*="Day_item"]').first();
    if (await dayChip.count() > 0 && await dayChip.isVisible().catch(() => false)) {
      log('classes tab: schedule already visible, no tab to click');
      return;
    }
    const btn = page.locator('button, a, [role="tab"]').filter({ hasText: /^(Classes|Schedule)$/i }).first();
    if (await btn.count() === 0) { await page.waitForTimeout(1500); continue; }
    try { await btn.scrollIntoViewIfNeeded({ timeout: 3000 }); } catch {}
    try { await btn.click({ timeout: 5000 }); log(`clicked Classes/Schedule (attempt ${i+1})`); await page.waitForTimeout(2000); return; }
    catch (e) { log(`clickClassesTab attempt ${i+1} failed: ${e.message.slice(0,80)}`); await page.waitForTimeout(1200); }
  }
  throw new Error('could not click Classes/Schedule tab after 4 attempts');
}

async function waitForScheduleView(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const anyDayTab = page.locator('[class*="Day_item"]').first();
    if (await anyDayTab.count() > 0 && await anyDayTab.isVisible().catch(() => false)) return;
    await page.waitForTimeout(500);
  }
  throw new Error('schedule view (Day_item tabs) never became visible');
}

async function clickDayTab(page, target) {
  const dayShort = DAY_SHORT[target.getDay()].toUpperCase();
  const dom = String(target.getDate());
  const re = new RegExp(`^${dayShort}\\s*${dom}$`, 'i');
  const tab = page.locator('[class*="Day_item"]').filter({ hasText: re }).first();
  if (await tab.count() === 0) throw new Error(`day tab ${dayShort} ${dom} not found in schedule`);
  await tab.waitFor({ state: 'visible', timeout: 15000 });
  try { await tab.scrollIntoViewIfNeeded({ timeout: 5000 }); } catch {}
  await tab.click();
  await page.waitForTimeout(1500);
  return { dayShort, dom };
}

async function findRow(page, plan, time) {
  const rows = await page.locator('[class*="ClassTimeScheduleItemDesktop"]').all();
  for (const r of rows) {
    const t = normalize(await r.innerText().catch(() => ''));
    if (rowMatches(t, { kind: plan.kind, time })) return { row: r, text: t };
  }
  return null;
}

// Resolve the click target on a row. Only BOOK NOW is a real booking trigger —
// DETAILS opens a class-info modal ("You missed the booking window") and never
// leads to checkout. Returning null here is intentional: callers must decide
// whether to poll (pre-9am) or fail (post-9am).
async function resolveBookButton(rowLoc) {
  const b = rowLoc.locator('button, a').filter({ hasText: /BOOK NOW/i }).first();
  if (await b.count() > 0) return { btn: b, label: 'BOOK NOW' };
  return null;
}

async function attemptRow(page, plan, time) {
  const hit = await findRow(page, plan, time);
  if (!hit) return { notFound: true, time, status: 'NOT_FOUND' };
  const status = rowStatus(hit.text);
  return { ...hit, status, time };
}

// Precise wait to targetMs. macOS App Nap / timer coalescing can delay a single
// long setTimeout by 1-3s; the old 400ms busy-wait cushion couldn't absorb that,
// so the 9am fire landed up to 3.5s late (drift logs, 06-17..06-20). Fix: re-arm
// in <=1s chunks (short timers aren't heavily coalesced), then busy-wait the final
// 3s for sub-ms precision. Paired with caffeinate in run-daily.sh.
async function spinWaitTo(targetMs) {
  const SPIN_MS = 3000;
  while (targetMs - Date.now() > SPIN_MS) {
    await new Promise(r => setTimeout(r, Math.min(targetMs - Date.now() - SPIN_MS, 1000)));
  }
  while (Date.now() < targetMs) {}
}

async function busyWaitUntil(targetMs) {
  const delta = targetMs - Date.now();
  if (delta <= 0) return;
  log(`sleeping ${delta}ms to target`);
  await spinWaitTo(targetMs);
}

// Light refresh: re-click the day tab. Cheap (~1.5s). Used at T-10s to sanity-
// check the row before the 9am click. May not force a server refetch, so the
// DOM may stay stale — but that's fine at T-10s because the window isn't open.
async function softRefreshSchedule(page, target) {
  await clickDayTab(page, target);
}

// Hard refresh: full page.reload() + re-navigate to schedule view. Guarantees
// MindBody re-hits the schedule API (cookies/session survive). Costs ~4-8s.
// Used exactly once at T+0 to pick up the DETAILS→BOOK_NOW transition that the
// React app won't auto-refresh on its own.
async function hardRefreshSchedule(page, target) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  await dismissCookieBanner(page);
  await clickClassesTab(page);
  await waitForScheduleView(page, 15000);
  await clickDayTab(page, target);
}

// Poll for the target row until it's BOOK_NOW (then caller clicks) or a terminal
// state. Returns { action, row?, text?, reason? } where action ∈ click/done/fail.
async function pollUntilBookable(page, plan, time, { timeoutMs = 20000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'UNKNOWN';
  let polls = 0;
  while (Date.now() < deadline) {
    polls++;
    const a = await attemptRow(page, plan, time);
    if (a.status !== lastStatus) {
      log(`poll #${polls}: ${a.status}${a.text ? ` — ${a.text.slice(0,100)}` : ''}`);
      lastStatus = a.status;
    }
    const d = decideNextAction(a.status);
    if (d.action === 'click') return { action: 'click', row: a.row, text: a.text };
    if (d.action === 'done')  return { action: 'done', text: a.text, detail: d.detail };
    if (d.action === 'fail')  return { action: 'fail', reason: d.reason, text: a.text };
    // action === 'poll' — keep waiting
    await page.waitForTimeout(intervalMs);
  }
  return { action: 'fail', reason: `BOOK NOW never appeared within ${timeoutMs}ms (last status: ${lastStatus})`, timedOut: true };
}

// Progressive refresh at T+0: try the cheapest thing first, escalate only if
// the DOM genuinely hasn't flipped to BOOK_NOW. Replaces the previous
// mandatory 6.5s page.reload() — happy path now clicks at ~T+2s instead of T+6.5s.
async function progressivePollForBookNow(page, plan, time, target) {
  // Stage A: soft refresh (re-click day tab, ~1.5s) + poll 2.5s
  const tA = Date.now();
  try {
    await softRefreshSchedule(page, target);
    log(`T+0 stage A (soft refresh) done in ${Date.now() - tA}ms — polling`);
    const rA = await pollUntilBookable(page, plan, time, { timeoutMs: 2500, intervalMs: 150 });
    if (!rA.timedOut) return rA;
    log('T+0 stage A did not surface BOOK NOW — escalating to hard refresh');
  } catch (e) {
    log(`T+0 stage A errored (${e.message.slice(0,100)}) — escalating to hard refresh`);
  }

  // Stage B: hard refresh (page.reload, ~6.5s) + poll 10s. Reserved for the
  // case where React really won't repaint without a full navigation — the
  // original fix path, kept as a safety net.
  const tB = Date.now();
  await hardRefreshSchedule(page, target);
  log(`T+0 stage B (hard refresh) done in ${Date.now() - tB}ms — polling`);
  return await pollUntilBookable(page, plan, time, { timeoutMs: 10000, intervalMs: 250 });
}

// After clicking BOOK NOW, MindBody routes to a checkout page with a BUY button.
// Detect error states early: booking-window modal or login redirect.
async function waitForCheckout(page, { timeoutMs = 45000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Login-redirect = session died. Fail fast.
    if (isLoginRedirectUrl(page.url())) {
      return { ok: false, reason: 'redirected to login', url: page.url() };
    }
    // "You missed the booking window" modal. Fail fast.
    const modalText = await page.locator('[role="dialog"], [class*="Modal"], [class*="modal"]').first()
      .innerText({ timeout: 500 }).catch(() => '');
    if (isBookingWindowErrorText(modalText)) {
      return { ok: false, reason: `booking window modal: ${modalText.slice(0,160)}` };
    }
    // BUY button present = checkout loaded.
    const buy = await page.locator('button:has-text("BUY"), button:has-text("Buy")').count();
    if (buy > 0) return { ok: true };
    await page.waitForTimeout(300);
  }
  return { ok: false, reason: `no BUY button within ${timeoutMs}ms` };
}

// After clicking BUY we need to know within ~30s whether it worked.
//
// Mindbody's UI is unreliable here — observed behaviors:
//   - Day-1 (2026-04-25): clean — BUY → modal vanishes → schedule shows BOOKED.
//   - Day-2 (2026-04-26): BUY → red error toast "We're unable to complete your
//     order at this time. Please try again." but schedule STILL showed BOOKED.
//     Error modals can be false negatives.
//   - Day-3 (2026-04-27): BUY → button text changes to "PURCHASING" (greyed
//     out, click registered, transaction in-flight) for ~5-10s before resolving.
//     Old code's "BUY missing → success" heuristic fired in 4.6s while
//     PURCHASING was still rendering, then we navigated away mid-transaction.
//     Class went FULL — booking aborted. False positive.
//
// New rules (in priority order):
//   1. Explicit success signal (URL change, success text) → ok=true.
//   2. PURCHASING/PROCESSING button visible → still in-flight, keep waiting.
//   3. Error modal text → record but DON'T return early — schedule is ground truth.
//   4. Both BUY and PURCHASING gone for 1.5s → checkout settled → return.
//   5. Timeout → return ambiguous result; verify step decides.
async function waitForBuyOutcome(page, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const errorSelectors = '[role="dialog"], [role="alertdialog"], [class*="Modal"], [class*="modal"], [class*="Error"], [class*="error"], [class*="Toast"]';
  const errorPatterns = /(something went wrong|checkout failed|unable to complete|different payment method|try again|declined|insufficient|expired|invalid)/i;
  const successPatterns = /(booking confirmed|thank you|your booking|order complete|confirmation|you'?re booked|reserved)/i;
  let lastError = null;
  let pendingSeenAt = null;
  let allButtonsGoneSince = null;

  while (Date.now() < deadline) {
    // 1. Explicit URL success.
    if (/thank|confirm|success|receipt/i.test(page.url())) {
      return { ok: true, reason: 'url', detail: page.url() };
    }
    // 2. Explicit body success copy (modal/page text).
    const bodyText = await page.locator('body').innerText({ timeout: 500 }).catch(() => '');
    if (successPatterns.test(bodyText)) {
      return { ok: true, reason: 'confirmation text', detail: (bodyText.match(successPatterns) || [''])[0] };
    }
    // 3. Inspect button state via the lib helper (testable).
    const buttonStates = await page.locator('button').evaluateAll(btns =>
      btns.map(b => (b.innerText || '').trim()).filter(Boolean)
    ).catch(() => []);
    const buttonState = classifyButtonStates(buttonStates);
    if (buttonState === 'pending') {
      if (!pendingSeenAt) pendingSeenAt = Date.now();
      allButtonsGoneSince = null;  // restart the "settled" timer
    } else if (buttonState === 'settled') {
      // Both BUY and PURCHASING are gone — could be settled (checkout closed)
      // OR transient render. Require sustained absence of 1.5s to call it done.
      if (!allButtonsGoneSince) allButtonsGoneSince = Date.now();
      const stableMs = Date.now() - allButtonsGoneSince;
      // We need enough elapsed time since BUY click that the in-flight XHR has had a chance to resolve.
      const elapsedSinceStart = timeoutMs - (deadline - Date.now());
      if (stableMs >= 1500 && elapsedSinceStart >= 4000) {
        return {
          ok: true,
          reason: 'checkout closed',
          detail: `BUY/PURCHASING gone for ${stableMs}ms after ${elapsedSinceStart}ms; pending seen=${pendingSeenAt ? 'yes' : 'no'}`,
        };
      }
    } else {
      // 'buy' — still visible. Could be (a) we never clicked, (b) Mindbody re-rendered BUY after
      // error, (c) Mindbody re-rendered BUY after success (yesterday's case). Keep waiting.
      allButtonsGoneSince = null;
    }
    // 4. Capture error modal text but don't return — schedule is ground truth.
    if (!lastError) {
      const modals = await page.locator(errorSelectors).all().catch(() => []);
      for (const m of modals) {
        const t = await m.innerText({ timeout: 300 }).catch(() => '');
        if (t && errorPatterns.test(t)) {
          lastError = t.replace(/\s+/g, ' ').trim().slice(0, 400);
          break;
        }
      }
    }
    await page.waitForTimeout(250);
  }
  // Timeout — return what we have. ambiguous=true tells caller to lean harder on verify.
  return {
    ok: false,
    ambiguous: true,
    reason: lastError ? 'error modal (unconfirmed)' : 'timeout',
    detail: lastError || `no settled signal within ${timeoutMs}ms; pendingSeen=${pendingSeenAt ? 'yes' : 'no'}`,
  };
}

// Re-check the schedule page for our row, retrying since Mindbody commits
// the booking asynchronously (server may take 2-5s to update the row).
// Returns the BEST status seen across retries — BOOKED beats DETAILS beats FULL.
async function verifyOnSchedule(page, plan, target, time, { tries = 4, delayMs = 1500 } = {}) {
  const seen = [];
  let bestStatus = 'NOT_FOUND';
  let bestText = null;
  const rank = { BOOKED: 5, BOOK_NOW: 4, DETAILS: 3, FULL: 2, WAITLIST: 2, UNKNOWN: 1, NOT_FOUND: 0 };
  for (let i = 0; i < tries; i++) {
    if (i > 0) {
      await page.waitForTimeout(delayMs);
      // Re-render the day to force a refetch.
      try { await softRefreshSchedule(page, target); } catch {}
    }
    const hit = await findRow(page, plan, time);
    const s = hit ? rowStatus(hit.text) : 'NOT_FOUND';
    seen.push(s);
    if ((rank[s] || 0) > (rank[bestStatus] || 0)) {
      bestStatus = s;
      bestText = hit ? hit.text : null;
    }
    log(`verify try ${i + 1}/${tries}: ${s}${hit ? ` — ${hit.text.slice(0,120)}` : ''}`);
    // Short-circuit on definitive states.
    if (s === 'BOOKED' || s === 'FULL' || s === 'BOOK_NOW') break;
  }
  return { status: bestStatus, text: bestText, seen };
}

function nineAmToday() { const d = new Date(); d.setHours(9,0,0,0); return d; }

// API-direct booking: capture Bearer, prefetch class metadata + payment pass,
// busy-wait to 09:00:00.000, then fire the 6-call pipeline. Returns the same
// status shape as the UI flow so the caller can treat it uniformly.
async function executeApiDirect(page, plan, target, t9, noWait) {
  const sgtDate = ymd(target);
  const sgtHHMM = timeToHHMM(plan.primaryTime);
  log(`api-direct: target ${plan.kind} @ ${plan.primaryTime} (SGT ${sgtHHMM}) on ${sgtDate}`);

  // 1. Capture Bearer (~2s).
  log('api-direct: capturing Bearer token');
  let bearer;
  try { bearer = await captureBearerToken(page, { timeoutMs: 20000 }); }
  catch (e) { return { ok: false, reason: 'bearer-capture-failed', detail: e.message, time: plan.primaryTime }; }

  // 2. Pre-fetch schedule + find target class.
  log('api-direct: fetching schedule for target date');
  const fromIso = new Date(`${sgtDate}T00:00:00+08:00`).toISOString();
  const toIso = new Date(`${sgtDate}T23:59:59+08:00`).toISOString();
  let classes;
  try { classes = await fetchScheduleClasses(bearer, { fromIso, toIso }); }
  catch (e) { return { ok: false, reason: 'schedule-fetch-failed', detail: e.message, time: plan.primaryTime }; }
  let classMeta = findClass(classes, { kindNeedle: plan.kind, sgtDate, sgtHHMM });
  if (!classMeta) {
    // Try fallback time before giving up.
    if (plan.fallback) {
      const fbHHMM = timeToHHMM(plan.fallback);
      classMeta = findClass(classes, { kindNeedle: plan.kind, sgtDate, sgtHHMM: fbHHMM });
      if (classMeta) log(`api-direct: primary ${plan.primaryTime} not in schedule; using fallback ${plan.fallback}`);
    }
    if (!classMeta) return { ok: false, reason: 'class-not-found', detail: `${plan.kind} ${sgtHHMM} not in schedule (${classes.length} classes)`, time: plan.primaryTime };
  }
  log(`api-direct: class mb_class_id=${classMeta.mb_class_id} schedule_id=${classMeta.mb_class_schedule_id} status=${classMeta.statusText}`);

  // 3. Pre-fetch payment pass. If the eligible-pass list misses BEFORE the
  //    booking window opens (Geraldine, 2026-06-07: empty list at 08:59 while
  //    Dani's populated, status "Outside booking window"), do NOT bail to the
  //    fragile pre-window UI fallback — wait for 09:00 and retry the fetch once.
  //    The list typically populates when the window opens; if it still misses
  //    we return pass-fetch-failed AFTER 9am so any fallback sees an open window.
  log('api-direct: fetching payment pass UUID');
  let paymentMethodUuid;
  let passErr = null;
  try { paymentMethodUuid = await fetchPaymentPassUuid(bearer, classMeta); }
  catch (e) { passErr = e; }

  if (passErr && shouldRetryPassFetchPreWindow({ reason: 'pass-fetch-failed' }, t9.getTime() - Date.now(), !noWait)) {
    const ms = t9.getTime() - Date.now();
    log(`api-direct: pass-fetch missed pre-window (${passErr.message.slice(0, 80)}); waiting ${ms}ms to 09:00 then retrying`);
    try { await tg(personality.standby(user, { planLine: `${plan.kind} @ ${plan.primaryTime}`, secs: Math.round(ms / 1000), mode: 'api' })); } catch {}
    await spinWaitTo(t9.getTime());
    log(`api-direct: drift ${Date.now() - t9.getTime()}ms (window now open, retrying pass-fetch)`);
    try {
      const fresh = await fetchScheduleClasses(bearer, { fromIso, toIso });
      const freshMeta = findClass(fresh, { kindNeedle: plan.kind, sgtDate, sgtHHMM })
        || (plan.fallback ? findClass(fresh, { kindNeedle: plan.kind, sgtDate, sgtHHMM: timeToHHMM(plan.fallback) }) : null);
      if (freshMeta) { classMeta = freshMeta; log(`api-direct: refreshed class status=${classMeta.statusText}`); }
      paymentMethodUuid = await fetchPaymentPassUuid(bearer, classMeta);
      passErr = null;
    } catch (e2) {
      passErr = e2;
      log(`api-direct: pass-fetch still failing after window open (${e2.message.slice(0, 80)})`);
    }
  }
  if (passErr) return { ok: false, reason: 'pass-fetch-failed', detail: passErr.message, time: plan.primaryTime };
  log(`api-direct: pass ${paymentMethodUuid}`);

  // 4. Wait to 09:00:00.000 SGT — pre-creating the order and warming the socket
  //    on the way down so the 9am sprint starts at booking_items (the seat-grab),
  //    not a cold /orders POST. On 2026-06-23 that POST spiked to 6.4s and pushed
  //    Dani's pipeline to 10.6s — the 6:30am class filled in ~6s and she missed.
  const usedTime = classMeta.startTime
    ? (() => { const d = new Date(classMeta.startTime); return `${(d.getHours()%12||12)}:${String(d.getMinutes()).padStart(2,'0')}${d.getHours()<12?'am':'pm'}`; })()
    : plan.primaryTime;
  let preOrderId = null;
  if (!noWait) {
    const ms = t9.getTime() - Date.now();
    if (ms > 0) {
      const secs = Math.round(ms/1000);
      await tg(personality.standby(user, {
        planLine: `${plan.kind} @ ${plan.primaryTime}`,
        secs,
        mode: 'api',
      }));
      log(`api-direct: waiting ${ms}ms to 09:00:00.000 SGT`);
      // T-15s: pre-create the order off the critical path (15s buffer absorbs
      // even a 6s spike). Skipped on near-9am recovery runs (<16s headroom).
      if (ms > 16000) {
        await spinWaitTo(t9.getTime() - 15000);
        try { preOrderId = await createOrder(bearer); log(`api-direct: pre-created order ${preOrderId} (off critical path)`); }
        catch (e) { log(`api-direct: pre-create order failed (${e.message.slice(0,100)}) — pipeline will create it inline`); }
      }
      // T-1.2s: warm the TCP/TLS socket so booking_items hits a hot connection.
      await spinWaitTo(t9.getTime() - 1200);
      await warmConnection(bearer, preOrderId);
      log(`api-direct: socket warmed${preOrderId ? ' (via pre-created order)' : ''}`);
      await spinWaitTo(t9.getTime());
      log(`api-direct: drift ${Date.now() - t9.getTime()}ms`);
    }
  }

  // 5. Fire the booking pipeline (starts at booking_items when preOrderId is set).
  log(`api-direct: firing booking pipeline${preOrderId ? ' (order pre-created)' : ''}`);
  let result;
  try { result = await bookViaApi(bearer, { classMeta, paymentMethodUuid, recaptchaToken: '', orderId: preOrderId }); }
  catch (e) { return { ok: false, reason: 'pipeline-exception', detail: e.message, time: plan.primaryTime }; }
  log(`api-direct: result ${JSON.stringify(result)}`);

  // 5b. If /process needed a real recaptcha, mint one and retry.
  if (!result.ok && result.step === 'process' && /recaptcha|captcha/i.test(result.body || '')) {
    log('api-direct: process needs real recaptcha — minting via browser');
    try {
      const tok = await generateRecaptchaToken(page);
      result = await bookViaApi(bearer, { classMeta, paymentMethodUuid, recaptchaToken: tok });
      log(`api-direct: retry result ${JSON.stringify(result)}`);
    } catch (e) {
      log(`api-direct: recaptcha mint failed (${e.message.slice(0,120)})`);
    }
  }

  // 5b'. Inventory-row INSERT race retry.
  //
  // Observed 2026-05-22 (Dani vs Yash, both targeting Sun 1pm Gymnastics):
  // booking_items returned HTTP 400 with `PG::UniqueViolation` on
  // `index_inventory_item_references_on_source_reference`. The Ragtag/Mindbody
  // backend INSERTs a single inventory_item_references row keyed by class
  // (mb_class_id + mb_location_id + ...), not per-user. When N parallel
  // requests target the same class at 9am, only one INSERT wins; the rest get
  // RecordNotUnique. On the loser's RETRY the row already exists, so the
  // INSERT path is skipped and the booking proceeds normally (so long as the
  // class still has a free spot, which it usually does for non-cap classes).
  //
  // Retry up to 2 times with brief backoff. Costs ~600ms in the worst case,
  // way cheaper than falling through to the 30+s UI flow.
  let inventoryRetries = 0;
  while (isInventoryRowRace(result) && inventoryRetries < 2) {
    inventoryRetries += 1;
    const backoff = 150 + inventoryRetries * 100;
    log(`api-direct: booking_items RecordNotUnique (inventory row INSERT race) — retry ${inventoryRetries}/2 after ${backoff}ms`);
    await new Promise(r => setTimeout(r, backoff));
    try { result = await bookViaApi(bearer, { classMeta, paymentMethodUuid, recaptchaToken: '' }); }
    catch (e) { log(`api-direct: retry ${inventoryRetries} exception (${e.message.slice(0,140)})`); break; }
    log(`api-direct: retry ${inventoryRetries} result ${JSON.stringify(result)}`);
  }

  if (!result.ok) {
    // 5b1. VERIFY-DON'T-TRUST.
    //
    // 2026-05-20 incident (Mer's Fri 7:30am FIT booking): the booking_items
    // leg returned HTTP 400 with `PG::UniqueViolation on
    // index_inventory_item_references_on_source_reference for mb_class_id=...`.
    // This is a Mindbody backend DB race: their unique index trips when
    // multiple users hit the same class inside a tight window, but the row
    // they refuse to insert duplicates one that actually IS there. In short:
    // the booking often succeeded on the server, the response is lying.
    //
    // Before falling back to the UI flow (which costs 45s of BUY-button
    // waiting and burns the slot by the time it loads), fetch
    // /account/schedule and check whether the target booking is in fact on
    // the user's upcoming list. If yes, claim success; if no, fall through
    // to the existing failure path.
    log(`api-direct: ${result.step} returned HTTP ${result.status} . verifying on /account/schedule before failing`);
    const targetYmd = ymd(target);
    try {
      await new Promise(r => setTimeout(r, 1500));
      const upcoming = await fetchMyUpcomingBookings(page);
      const match = findBookingInUpcoming(upcoming, { targetYmd, kind: plan.kind, time: usedTime });
      if (match && match.waitlisted) {
        log(`api-direct: WAITLISTED (NOT booked) on /account/schedule after HTTP ${result.status} at ${result.step} — reporting honestly`);
        try { await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
        return {
          ok: false,
          reason: 'class-full-waitlisted',
          detail: `${plan.kind} @ ${usedTime} on ${DAY_SHORT[target.getDay()]} ${targetYmd} was FULL — you're on the waitlist now (Mindbody auto-promotes if a spot frees). Class status: ${classMeta.statusText || 'waitlist'}.`,
          time: usedTime,
          timing: result.timing,
          via: 'api',
          waitlisted: true,
        };
      }
      if (match) {
        log(`api-direct: BOOKED on /account/schedule despite HTTP ${result.status} at ${result.step} . claiming success (response was bogus)`);
        try { await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
        return {
          ok: true,
          reason: 'booked (api-direct, verified after error)',
          detail: `${plan.kind} @ ${usedTime} on ${DAY_SHORT[target.getDay()]} ${targetYmd} confirmed via /account/schedule (api returned HTTP ${result.status} at ${result.step} but booking went through)`,
          time: usedTime,
          timing: result.timing,
          via: 'api',
          verifiedAfterError: true,
          apiErrorStep: result.step,
          apiErrorStatus: result.status,
        };
      }
      log(`api-direct: not on /account/schedule . falling through to UI fallback`);
      try { await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
    } catch (e) {
      log(`api-direct: schedule verify failed (${e.message.slice(0, 140)}) . falling through to UI fallback`);
    }

    return {
      ok: false,
      reason: `api-${result.step}-failed`,
      detail: `HTTP ${result.status}: ${(result.body || '').slice(0,300)}`,
      time: usedTime,
      timing: result.timing,
    };
  }

  // 5c. Post-flight verification. statusTitle "processing_requested" (status.code 10)
  // is an async-commit acknowledgement, not confirmation — Mindbody silently drops
  // the request if the class hits max capacity between schedule fetch and process
  // commit. Confirm the booking actually appears on /account/schedule before
  // claiming success; otherwise return ok=false so the caller can fall back.
  if (result.statusTitle === 'processing_requested') {
    const targetYmd = ymd(target);
    let match = null;       // matched /account/schedule card (has .waitlisted), or null
    let fetched = false;    // did at least one schedule fetch succeed?
    // 3 tries (~10s): the async commit can land just after 7s (Yash, 2026-06-23,
    // whose booking succeeded but was wrongly flagged "silently dropped" and
    // bounced to the UI flow because the 2-try/7s window expired a beat early).
    for (const waitMs of [3500, 3500, 3000]) {
      await new Promise(r => setTimeout(r, waitMs));
      let upcoming;
      try { upcoming = await fetchMyUpcomingBookings(page); fetched = true; }
      catch (e) { log(`api-direct: confirm fetch failed (${e.message.slice(0,140)})`); break; }
      match = findBookingInUpcoming(upcoming, { targetYmd, kind: plan.kind, time: usedTime });
      if (match) {
        log(`api-direct: ${match.waitlisted ? 'WAITLISTED (NOT booked)' : 'confirmed'} ${plan.kind} @ ${usedTime} on ${targetYmd} in /account/schedule`);
        break;
      }
      log(`api-direct: not yet confirmed (${upcoming.length} upcoming, none matched ${plan.kind} @ ${usedTime} on ${targetYmd}) — re-checking`);
    }
    // fetchMyUpcomingBookings navigated to /account/schedule. Restore the gym URL
    // so any UI-flow fallback (clickClassesTab) finds its anchors.
    if (match && match.waitlisted) {
      // The class was FULL: the booking landed on the WAITLIST, not a reservation.
      // Never report this as a booking. ok:false + "full"/"waitlist" routes to the
      // honest message AND arms the waitlist watcher (classifyBookingFailure).
      try { await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
      return {
        ok: false,
        reason: 'class-full-waitlisted',
        detail: `${plan.kind} @ ${usedTime} on ${DAY_SHORT[target.getDay()]} ${targetYmd} was FULL at 09:00 — you're on the waitlist now (Mindbody auto-promotes if a spot frees). Class status: ${classMeta.statusText || 'waitlist'}.`,
        time: usedTime,
        timing: result.timing,
        via: 'api',
        waitlisted: true,
      };
    }
    if (!match && fetched) {
      try { await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
      return {
        ok: false,
        reason: 'api-process-silently-dropped',
        detail: `Mindbody returned processing_requested (orderId=${result.orderId}) but ${plan.kind} @ ${usedTime} on ${targetYmd} did not appear on /account/schedule after 10s — class likely at max capacity, async commit was rejected. Class status at fetch was: ${classMeta.statusText || 'unknown'}.`,
        time: usedTime,
        timing: result.timing,
      };
    }
    // match && !waitlisted → real booking; or fetch never succeeded → trust the
    // 202 (can't verify), both fall through to ok:true below.
  }

  return {
    ok: true,
    reason: 'booked (api-direct)',
    detail: `${plan.kind} @ ${usedTime} on ${DAY_SHORT[target.getDay()]} ${ymd(target)} via API in ${result.timing.total}ms (\`${result.statusTitle}\`)`,
    time: usedTime,
    timing: result.timing,
    via: 'api',
  };
}

// Pre-flight guard: fetch /account/schedule and return upcoming bookings.
// The 2026-04-27 incident: my test run booked Tue 8:30am FIT while user
// already had Tue 6:30am FIT — Mindbody's explore page row showed BOOK NOW
// (not DETAILS/BOOKED), so the row-status check missed the duplicate. The
// authoritative list lives at /account/schedule, which we should consult
// before clicking anything.
async function fetchMyUpcomingBookings(page) {
  const acctUrl = 'https://www.mindbodyonline.com/explore/account/schedule';
  await page.goto(acctUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await dismissCookieBanner(page);
  // The page renders one card per booking under the UPCOMING tab. Each card
  // contains: day-of-month, weekday, "Month, YYYY", kind ("CROSSFIT® FIT" /
  // "CROSSFIT® Gymnastics"), instructor line, time, "Cancel" button.
  // Use the same per-card scoping logic as cancel-booking.js (smallest
  // ancestor containing exactly one Cancel button).
  const cards = await page.evaluate(() => {
    const cancelBtns = Array.from(document.querySelectorAll('button, a'))
      .filter(e => /^Cancel$/i.test((e.innerText || '').trim()));
    const out = [];
    for (const btn of cancelBtns) {
      let n = btn.parentElement;
      let best = (btn.innerText || '').trim();
      for (let j = 0; j < 15 && n; j++) {
        const cancelCount = Array.from(n.querySelectorAll('button, a'))
          .filter(e => /^Cancel$/i.test((e.innerText || '').trim())).length;
        if (cancelCount > 1) break;
        const t = (n.innerText || '').trim();
        if (t.length > best.length && t.length < 600) best = t;
        n = n.parentElement;
      }
      out.push(best.replace(/\s+/g, ' '));
    }
    return out;
  });
  return cards.map(parseBookingCard).filter(Boolean);
}

// Last-resort fallback: primary class failed post-BUY. Try the fallback time
// from the schedule page we're already on. Keeps the logic here (not in the
// main flow) to avoid nesting — primary attempt is the bulk of book.js.
async function attemptFallbackBooking(page, plan, target) {
  try {
    // Page may have been torn down by checkout navigation — re-land on schedule.
    if (!/locations\/ragtag/i.test(page.url())) {
      await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      await dismissCookieBanner(page);
      await clickClassesTab(page);
      await waitForScheduleView(page, 15000);
      await clickDayTab(page, target);
    }
    const hit = await findRow(page, plan, plan.fallback);
    if (!hit) return { ok: false, reason: `fallback row ${plan.fallback} not found` };
    const s = rowStatus(hit.text);
    log(`fallback ${plan.fallback}: ${s} — ${hit.text.slice(0,120)}`);
    if (s === 'BOOKED') return { ok: true, reason: 'fallback already BOOKED' };
    if (s !== 'BOOK_NOW' && s !== 'DETAILS') return { ok: false, reason: `fallback status ${s}` };

    // If DETAILS (rare at this point), poll briefly
    let rowLoc = hit.row;
    if (s === 'DETAILS') {
      const r = await pollUntilBookable(page, plan, plan.fallback, { timeoutMs: 4000, intervalMs: 200 });
      if (r.action === 'done') return { ok: true, reason: 'fallback BOOKED mid-poll' };
      if (r.action !== 'click') return { ok: false, reason: `fallback poll: ${r.reason || r.action}` };
      rowLoc = r.row;
    }

    const btn = rowLoc.locator('button, a').filter({ hasText: /BOOK NOW/i }).first();
    if (await btn.count() === 0) return { ok: false, reason: 'fallback BOOK NOW button missing' };
    log(`CLICK fallback BOOK NOW @ ${plan.fallback}`);
    await btn.click({ timeout: 10000 });
    await snap(page, 'fallback-post-click');

    const co = await waitForCheckout(page, { timeoutMs: 30000 });
    if (!co.ok) return { ok: false, reason: `fallback checkout: ${co.reason}` };
    await page.waitForTimeout(1000);
    await snap(page, 'fallback-checkout');
    const buy2 = page.locator('button').filter({ hasText: /^BUY$/i }).first();
    if (await buy2.count() === 0) return { ok: false, reason: 'fallback BUY button missing' };
    log('CLICK fallback BUY');
    await buy2.click();
    const o2 = await waitForBuyOutcome(page, { timeoutMs: 30000 });
    await snap(page, 'fallback-post-buy');
    log(`fallback BUY outcome: ok=${o2.ok}${o2.ambiguous ? ' (ambiguous)' : ''} reason=${o2.reason} — ${(o2.detail||'').slice(0,300)}`);

    // Re-verify on schedule using the retry-aware helper.
    await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await dismissCookieBanner(page);
    await clickClassesTab(page);
    await waitForScheduleView(page, 15000);
    await clickDayTab(page, target);
    const v2 = await verifyOnSchedule(page, plan, target, plan.fallback, { tries: 4, delayMs: 1500 });
    log(`fallback verify final: ${v2.status} (saw: ${v2.seen.join('→')})`);
    await snap(page, 'fallback-verify');
    if (v2.status === 'BOOKED') return { ok: true, reason: 'fallback booked' };
    if (o2.ok && v2.status !== 'BOOK_NOW' && v2.status !== 'FULL') {
      // Same trust logic as primary: BUY settled cleanly + ambiguous verify → trust BUY.
      return { ok: true, reason: `fallback booked (BUY-confirmed, verify=${v2.status})` };
    }
    return { ok: false, reason: `fallback unverified (row ${v2.status}; BUY ${o2.ok ? 'ok' : o2.reason + ': ' + (o2.detail||'').slice(0,120)})` };
  } catch (e) {
    return { ok: false, reason: `fallback exception: ${e.message}` };
  }
}

(async () => {
  const today = new Date();
  const target = dateArg ? new Date(`${dateArg}T00:00:00`) : addDays(today, 2);
  // Per-date overrides + pause windows are layered on top of the user's
  // baseline schedule. Override file is gym-booker/overrides.json (gitignored,
  // managed via gym-override.py — Lawrence writes to it on user request).
  // Yash has no users.json row, so his override key is the literal string 'yash'.
  const userKey = user ? user.id : 'yash';
  const overridesPath = path.join(__dirname, 'overrides.json');
  const dateOverrides = loadOverrides(overridesPath);
  const decision = resolveBookingsForDate(target, userKey, user ? user.schedule : null, dateOverrides);
  const dayLabelForMsg = `${DAY_SHORT[target.getDay()]} ${ymd(target)}`;
  if (decision.skip) {
    // Three skip kinds, all clean exits (ok=true so launchd / book-all reads as success):
    //   opt_out_day → no class scheduled for this DOW (user pref)
    //   date_skip   → user explicitly cancelled this date
    //   paused      → user is on leave through pauseUntil
    const who = user ? (user.label || user.id) : 'Yash';
    log(`skip ${decision.skip}: ${who} on ${dayLabelForMsg}${decision.detail ? ` (${decision.detail})` : ''}`);
    await tg(personality.outcome(user,
      { ok: true, reason: decision.skip, detail: decision.detail },
      { dayLabel: dayLabelForMsg, planLine: '', runId: RUN_ID }));
    // Without this, book-all.js sees exit 0 + no result file and synthesizes a
    // "setup failed" entry in the daily summary (false alarm). Empty results
    // array + skipReason tells the orchestrator the user is intentionally
    // sitting out.
    if (process.env.BOOKER_RESULT_FILE) {
      try {
        const payload = {
          user: user ? { id: user.id, label: user.label || user.id } : { id: 'yash', label: 'Yash' },
          results: [],
          setupErrored: false,
          skipReason: decision.skip,
          skipDetail: decision.detail || '',
          dayLabel: dayLabelForMsg,
          runId: RUN_ID,
          targetYmd: ymd(target),
        };
        fs.writeFileSync(process.env.BOOKER_RESULT_FILE, JSON.stringify(payload));
      } catch (e) { log(`result-file write failed: ${e.message}`); }
    }
    flushLog();
    process.exit(0);
  }

  // CLI overrides (--time / --kind / --no-fallback) collapse to a single plan.
  // The baseline can be a single class or a back-to-back list; with overrides,
  // we treat the first plan as the base and apply the override fields. This
  // preserves the legacy `node book.js <date> --time 8:30am --kind FIT` smoke
  // test path where you book exactly one class.
  const hasCliOverride = !!(timeOverride || kindOverride || noFallback);
  const plans = hasCliOverride
    ? [{
        kind: kindOverride || decision.plans[0].kind,
        primaryTime: timeOverride || decision.plans[0].primaryTime,
        fallback: noFallback || timeOverride ? null : decision.plans[0].fallback,
      }]
    : decision.plans.map(p => ({ kind: p.kind, primaryTime: p.primaryTime, fallback: p.fallback }));

  // FIT-priority ordering: when multiple plans exist on the same day, the FIT
  // class is the limiting/popular slot (BURN rarely sells out at 9am, FIT does).
  // Sort FIT-kind first so it gets the head start in the parallel race below —
  // worst case if only one booking lands, FIT wins. Stable sort.
  plans.sort((a, b) => (b.kind === 'FIT' ? 1 : 0) - (a.kind === 'FIT' ? 1 : 0));

  // GYM_T9_OVERRIDE_ISO: dress-rehearsal knob. Points the "9am" sprint target
  // at an arbitrary instant so the FULL time-critical path (stage → standby →
  // busy-wait → T+0 sprint → book → verify) can be exercised live off-cycle.
  // Test-only: nothing in launchd sets it; a real booking still happens, so
  // pair with a quiet slot + cancel-booking afterwards, and give users a
  // heads-up if any test DM could reach them. Proven 10-06-2026: 337ms drift,
  // booked + verified + cancelled.
  const { t9, overridden: t9Overridden } = resolveSprintTarget({
    overrideIso: process.env.GYM_T9_OVERRIDE_ISO, fallback: nineAmToday(),
  });
  if (t9Overridden) log(`⚠️ T9 OVERRIDE ACTIVE (dress rehearsal): sprint target ${t9.toISOString()}`);

  log(`RUN ${RUN_ID}`);
  log(`today: ${ymd(today)} ${DAY_SHORT[today.getDay()]}`);
  log(`target: ${ymd(target)} ${DAY_SHORT[target.getDay()]}`);
  for (const p of plans) {
    log(`plan: ${p.kind} @ ${p.primaryTime}` + (p.fallback ? ` (fallback ${p.fallback})` : ''));
  }
  log(`mode: dry=${dryRun} nowait=${noWait}` + (plans.length > 1 ? ` plans=${plans.length}` : ''));
  log(`9am SGT target: ${t9.toISOString()} (ms-from-now: ${t9.getTime() - Date.now()})`);

  const planLineForMsg = plans
    .map(p => `${p.kind} @ ${p.primaryTime}${p.fallback ? ` (fallback ${p.fallback})` : ''}`)
    .join(' + ');
  await tg(personality.started(user, {
    planLine: planLineForMsg,
    dayLabel: dayLabelForMsg,
    secs: Math.max(0, Math.round((t9.getTime() - Date.now()) / 1000)),
  }));

  const authPath = user
    ? usersLib.getAuthPath(user)
    : path.join(__dirname, 'auth.json');

  let browser = null, ctx = null, page = null;
  let didRelogin = false;
  let myBookings = [];           // pre-flight, shared across plans
  let setupError = null;          // login or pre-flight failure → all plans fail
  const results = [];             // per-plan { plan, status }

  // One Chromium for the whole fleet: book-all runs launchServer() and hands
  // children the ws endpoint via BOOKER_WS_ENDPOINT. Five simultaneous
  // Chromium cold-starts on a loaded mini were the 2026-06-06 and 2026-06-10
  // wipeouts; connect() to the shared server is near-instant. Any connect
  // failure falls back to a private launch so a dead/dying server can never
  // strand a user. browser.close() on a connected browser only disconnects
  // this child (and its contexts) — the server and other users live on.
  async function acquireBrowser() {
    const ws = process.env.BOOKER_WS_ENDPOINT;
    if (ws) {
      try {
        const b = await chromium.connect(ws, { timeout: 15000 });
        log('browser: connected to shared server');
        return b;
      } catch (e) {
        log(`browser: shared connect failed (${String(e.message).split('\n')[0].slice(0, 80)}) — private launch fallback`);
      }
    }
    return chromium.launch({ headless: true });
  }

  // Setup is retried once on failure (e.g. Chromium child process crash mid-auth
  // — see 2026-05-14 incident: Dani's run died at snap(landed) → next page.evaluate
  // hit "Target page, context or browser has been closed"). Retry relaunches a
  // fresh browser only when we have >75s headroom to 9am SGT (fresh login ~50s
  // + book ~3s + buffer). noWait mode (testing) skips the headroom check.
  async function attemptSetup() {
    // Auth: decideAuthAction (lib.js) decides login-vs-cached. A cached session
    // that LOOKS valid at startup can still die before 09:00 (the Bearer is held
    // ~20min through the spin-wait) — 2026-06-21 Yash + Chew Yien both 401'd at
    // 09:00 on a probe-clean cached session while fresh-login users succeeded. So
    // when there's ample headroom we now force a PROACTIVE fresh login (re-adds
    // the 2026-04-23 behavior, but only when there's time — tight/--now runs keep
    // the cached fast-path). The 2026-06-09 budget concern (login starving nav
    // retries) is covered by MAX_SETUP_ATTEMPTS=6 + the 75s headroom check below.
    // A corrupt auth file (2026-06-10: melissa.json had trailing garbage from a
    // non-atomic write) makes newContext({ storageState }) throw on EVERY setup
    // attempt. storageStatePathIfValid returns null for missing OR malformed
    // files, so we fall through to a fresh login (haveCachedAuth=false) and the
    // run self-heals instead of dying both attempts.
    const validAuthPath = storageStatePathIfValid(authPath);
    const haveCachedAuth = validAuthPath !== null;
    if (fs.existsSync(authPath) && !haveCachedAuth) {
      log(`auth: cached ${path.basename(authPath)} is corrupt/unreadable — discarding, logging in fresh`);
      try { fs.unlinkSync(authPath); } catch {}
    }
    log(`auth: ${haveCachedAuth ? 'using cached auth.json (login only if expired)' : 'no cached auth.json — will log in'}`);
    const localBrowser = await acquireBrowser();
    const localCtx = await localBrowser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 }, locale: 'en-SG', timezoneId: SGT_TZ,
      storageState: haveCachedAuth ? validAuthPath : undefined,
    });
    const localPage = await localCtx.newPage();
    let localDidRelogin = false;
    let localMyBookings = [];

    if (simulateSetupFail) throw new Error('synthetic setup failure for alert testing (--simulate-setup-fail)');
    log('navigating to ragtag');
    await gotoWithRetry(localPage, GYM_URL, t9.getTime() - Date.now(), 'ragtag');
    await localPage.waitForTimeout(2500);
    await dismissCookieBanner(localPage);
    await snap(localPage, 'landed');

    // Auth decision (unit-tested via decideAuthAction). Probe the Bearer only on
    // a cached session that LOOKS logged-in — that's the only case where a zombie
    // (logged-in UI but dead API session) can hide. Re-login covers no-session,
    // expired, AND zombie, while there's still time before 09:00.
    const loggedOut = await isLoggedOut(localPage);
    let bearerOk = null;
    if (haveCachedAuth && !loggedOut) {
      try { await captureBearerToken(localPage, { timeoutMs: 12000 }); bearerOk = true; }
      catch { bearerOk = false; }
    }
    const auth = decideAuthAction({ haveCachedAuth, loggedOut, bearerOk, msToNine: noWait ? null : t9.getTime() - Date.now() });
    if (auth.login) {
      log(`AUTH: ${auth.reason} — logging in`);
      localDidRelogin = true;
      await snap(localPage, 'logged-out');
      await loginAndSave(localPage, localCtx, authPath, { creds, log });
      log('AUTH: re-navigating to ragtag after login');
      await gotoWithRetry(localPage, GYM_URL, t9.getTime() - Date.now(), 'post-login');
      await localPage.waitForTimeout(2500);
      await dismissCookieBanner(localPage);
      await snap(localPage, 'post-relogin');
      if (await isLoggedOut(localPage)) throw new Error('still logged out after re-login attempt');
      await tg(personality.loggedIn(user));
    } else {
      log(`AUTH: ${auth.reason}`);
    }

    // Pre-flight: /account/schedule is the authoritative bookings list. Skip
    // any plan whose kind is already booked on the target date — explore-page
    // row text can show stale BOOK NOW even when the user is already booked
    // (caused the 2026-04-27 duplicate-booking incident). For back-to-back
    // days we fetch this ONCE and dup-check each plan against the same list.
    if (!allowDuplicate) {
      try {
        localMyBookings = await fetchMyUpcomingBookings(localPage);
        log(`my-schedule: ${localMyBookings.length} upcoming bookings`);
        for (const b of localMyBookings) log(`  ${b.ymd} ${b.kind} @ ${b.time}`);
      } catch (e) {
        log(`my-schedule pre-flight failed (${e.message.slice(0,120)}) — continuing without guard`);
      }
      // Re-land on ragtag for the rest of the flow.
      await gotoWithRetry(localPage, GYM_URL, t9.getTime() - Date.now(), 'reland');
      await localPage.waitForTimeout(2000);
      await dismissCookieBanner(localPage);
    }

    return { browser: localBrowser, ctx: localCtx, page: localPage, didRelogin: localDidRelogin, myBookings: localMyBookings };
  }

  // The real limiter on setup retries is the 75s headroom check in
  // canRetrySetup, NOT this count — it's just a backstop against a pathological
  // fast-failing loop. 2026-06-10: with the cap at 2, the run gave up at 08:58
  // with 211s (3.5 min) still on the clock to 09:00 when Mindbody was briefly
  // slow — well inside the margin, but the attempt-cap killed it first. Sizing
  // the cap above what the runway can fit lets a transient blip burn its full
  // recovery budget while a genuinely-dead network still fails fast on margin.
  const MAX_SETUP_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_SETUP_ATTEMPTS; attempt++) {
    let attemptBrowser = null, attemptPage = null;
    try {
      const r = await attemptSetup();
      browser = r.browser; ctx = r.ctx; page = r.page;
      didRelogin = r.didRelogin; myBookings = r.myBookings;
      setupError = null;
      if (attempt > 1) log(`SETUP RECOVERED on attempt ${attempt}`);
      break;
    } catch (e) {
      // Capture whatever browser/page exists so we can snap + close cleanly.
      attemptBrowser = browser; attemptPage = page;
      log(`ERROR (setup attempt ${attempt}/${MAX_SETUP_ATTEMPTS})`, e.message);
      try { if (attemptPage) await snap(attemptPage, `error-setup-${attempt}`); } catch {}
      try { if (attemptBrowser) await attemptBrowser.close(); } catch {}
      browser = null; ctx = null; page = null;
      setupError = e;
      const msRemaining = t9.getTime() - Date.now();
      const canRetry = canRetrySetup({ attempt, maxAttempts: MAX_SETUP_ATTEMPTS, msRemaining, marginMs: 75000, noWait });
      if (canRetry) {
        log(`SETUP RETRY: ${msRemaining}ms to 9am, relaunching fresh browser (attempt ${attempt + 1}/${MAX_SETUP_ATTEMPTS})`);
        continue;
      }
      if (attempt < MAX_SETUP_ATTEMPTS) {
        log(`SETUP RETRY skipped: only ${msRemaining}ms to 9am, below 75s safety margin — failing fast so Yash gets alerted`);
      }
      break;
    }
  }

  // Tell book-all this child is fully staged so it can release the next user's
  // setup. Serialized setups keep peak host load to one browser launch at a
  // time; the 09:00 sprint itself still fires in parallel for everyone.
  if (!setupError) log(SETUP_COMPLETE_MARKER);

  // Per-plan booking flow. Shares browser/ctx (so login + cookies are reused)
  // but receives its OWN page so multiple plans can run in parallel without
  // page-state collisions (e.g. plan #1 navigating to checkout while plan #2
  // is mid-poll). myBookings is shared (read-only here, mutated post-success).
  // Each plan runs with its own try/catch so a failure on one doesn't prevent
  // the other.
  async function bookOnePlan(plan, planIndex, page) {
    let status = { ok: false, reason: 'unknown', detail: '', time: null };
    const planTag = plans.length > 1 ? `[plan ${planIndex + 1}/${plans.length}] ` : '';
    try {
      log(`${planTag}booking: ${plan.kind} @ ${plan.primaryTime}` + (plan.fallback ? ` (fallback ${plan.fallback})` : ''));

      // Per-plan dup check against the shared myBookings list.
      if (!allowDuplicate) {
        const dup = myBookings.find(b => b.ymd === ymd(target) && b.kind === plan.kind);
        if (dup) {
          status = {
            ok: true,
            reason: 'already_booked',
            detail: `${plan.kind} on ${ymd(target)} already booked at ${dup.time} (skipped, would have tried ${plan.primaryTime})`,
            time: dup.time,
          };
          return status;
        }
      }

      // ── API-DIRECT FAST PATH ──────────────────────────────────────────
      // Bypass the React UI and book via Mindbody's marketplace gateway directly.
      // T+0 → committed in ~2.2s vs ~12s for the UI flow. Falls back to UI on
      // any failure so we never miss a booking due to API regressions.
      if (apiDirect && !dryRun) {
        try {
          const apiResult = await executeApiDirect(page, plan, target, t9, noWait);
          if (apiResult.ok) {
            status = apiResult;
            return status;
          }
          // Class was FULL → we landed on the waitlist. This is terminal and
          // honest (matches the pre-existing control flow, which also returned
          // here — it just used to mislabel it "booked"). Do NOT fall through to
          // the UI flow: it can't book a full class, it would only burn ~30s and
          // re-throw FULL. classifyBookingFailure arms the watcher off this.
          if (apiResult.waitlisted) {
            status = apiResult;
            return status;
          }
          log(`${planTag}api-direct failed (${apiResult.reason}: ${(apiResult.detail||'').slice(0,200)}) — falling back to UI flow`);
        } catch (e) {
          log(`${planTag}api-direct exception (${e.message.slice(0,200)}) — falling back to UI flow`);
        }
      }
      // ────────────────────────────────────────────────────────────────────

      // After api-direct (or its fallback), or fresh from setup, we may not be
      // on the schedule view. Re-land on ragtag so the UI flow has a known
      // starting point — especially important for plan #2+ where the previous
      // plan's verify navigated to /account/schedule.
      await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      await dismissCookieBanner(page);

      await clickClassesTab(page);
      await waitForScheduleView(page, 20000);
      await clickDayTab(page, target);
      await snap(page, `day-selected-p${planIndex + 1}`);

      // Pre-stage: verify the row exists and prefer fallback if primary is FULL/BOOKED-elsewhere.
      // Status here may be DETAILS (window not yet open) — that's fine; we refresh at 9am.
      async function pickRow(reason) {
        log(`${planTag}pickRow (${reason}): primary=${plan.primaryTime}${plan.fallback ? ` fallback=${plan.fallback}`:''}`);
        const a = await attemptRow(page, plan, plan.primaryTime);
        log(`  primary: ${a.notFound ? 'NOT FOUND' : `${a.status} — ${a.text.slice(0,140)}`}`);
        if (!a.notFound && a.status === 'BOOKED') return a;
        if (!a.notFound && (a.status === 'BOOK_NOW' || a.status === 'DETAILS')) return a;
        if (plan.fallback) {
          const b = await attemptRow(page, plan, plan.fallback);
          log(`  fallback: ${b.notFound ? 'NOT FOUND' : `${b.status} — ${b.text.slice(0,140)}`}`);
          if (!b.notFound && (b.status === 'BOOKED' || b.status === 'BOOK_NOW' || b.status === 'DETAILS')) return b;
          return a.notFound ? b : a;
        }
        return a;
      }

      let chosen = await pickRow('pre-stage');
      if (chosen.notFound) throw new Error(`no ${plan.kind} row found on ${ymd(target)} (tried ${plan.primaryTime}${plan.fallback ? ` + ${plan.fallback}`:''})`);
      log(`${planTag}chosen: ${plan.kind} @ ${chosen.time} — status=${chosen.status}`);

      if (chosen.status === 'BOOKED') {
        status = { ok: true, reason: 'already_booked', detail: `${plan.kind} @ ${chosen.time} was already BOOKED`, time: chosen.time };
        return status;
      }
      if (chosen.status === 'FULL') throw new Error(`${plan.kind} FULL (primary${plan.fallback ? ' and fallback' : ''})`);

      // Wait to 09:00:00.000 SGT unless --now or already past. For plan #2+
      // on a back-to-back day, msLeft is already negative (plan #1's BUY took
      // ~10s past 9am) so we click immediately.
      const msLeft = t9.getTime() - Date.now();
      if (!noWait && msLeft > 0) {
        const secs = Math.round(msLeft / 1000);
        await tg(personality.standby(user, {
          planLine: `${plan.kind} @ ${chosen.time}`,
          secs,
          mode: 'ui',
        }));
        log(`${planTag}waiting ${msLeft}ms to 09:00:00.000 SGT`);
        if (msLeft > 15000) {
          await new Promise(r => setTimeout(r, msLeft - 10000));
          log(`${planTag}T-10s soft refresh: clicking day tab again`);
          await softRefreshSchedule(page, target);
          const snapshot = await pickRow('T-10s refresh');
          if (snapshot.notFound) throw new Error('row disappeared after refresh');
          if (snapshot.status === 'BOOKED') {
            status = { ok: true, reason: 'already_booked', detail: `${plan.kind} @ ${snapshot.time} — booked during refresh`, time: snapshot.time };
            return status;
          }
          if (snapshot.status === 'FULL') throw new Error(`${plan.kind} went FULL before 9am (all fallbacks too)`);
          chosen = snapshot;
        }
        await busyWaitUntil(t9.getTime());
        log(`${planTag}drift from 09:00:00.000: ${Date.now() - t9.getTime()}ms`);
      } else if (msLeft < 0) {
        log(`${planTag}already past 9am today (by ${-msLeft}ms) — clicking immediately`);
      } else {
        log(`${planTag}--now: clicking immediately`);
      }

      // At T+0, MindBody's DOM is stale — the server has flipped the row to
      // BOOK_NOW but the cached DOM still shows DETAILS. Progressive refresh
      // tries a cheap soft re-click first (1.5s) before falling back to the
      // expensive page.reload() (6.5s). Cuts happy-path BUY time by ~5 seconds,
      // which is exactly the window in which popular slots get snatched.
      const poll = !noWait
        ? await progressivePollForBookNow(page, plan, chosen.time, target)
        : await pollUntilBookable(page, plan, chosen.time, { timeoutMs: 20000, intervalMs: 250 });
      if (poll.action === 'done') {
        status = { ok: true, reason: 'already_booked', detail: `${plan.kind} @ ${chosen.time} — ${poll.detail}`, time: chosen.time };
        return status;
      }
      if (poll.action === 'fail') {
        // Try fallback once if primary is FULL/NOT_FOUND (fast race: someone else booked it)
        if (plan.fallback && chosen.time === plan.primaryTime) {
          log(`${planTag}primary ${poll.reason} — trying fallback ${plan.fallback}`);
          const pollFb = await pollUntilBookable(page, plan, plan.fallback, { timeoutMs: 10000, intervalMs: 250 });
          if (pollFb.action === 'click') {
            chosen = { row: pollFb.row, text: pollFb.text, time: plan.fallback, status: 'BOOK_NOW' };
          } else if (pollFb.action === 'done') {
            status = { ok: true, reason: 'already_booked', detail: `${plan.kind} @ ${plan.fallback} — ${pollFb.detail}`, time: plan.fallback };
            return status;
          } else {
            throw new Error(`primary+fallback both failed: primary=${poll.reason}, fallback=${pollFb.reason}`);
          }
        } else {
          throw new Error(`poll failed: ${poll.reason}`);
        }
      } else {
        chosen = { row: poll.row, text: poll.text, time: chosen.time, status: 'BOOK_NOW' };
      }

      // Resolve BOOK NOW button on the fresh row
      const resolved = await resolveBookButton(chosen.row);
      if (!resolved) throw new Error('BOOK NOW button not resolvable on chosen row despite BOOK_NOW status');
      log(`${planTag}button label: ${resolved.label}`);

      if (dryRun) {
        log(`${planTag}DRY RUN — skipping click + buy`);
        await snap(page, `dryrun-at-click-p${planIndex + 1}`);
        status = { ok: true, reason: 'dry_run', detail: `would book ${plan.kind} @ ${chosen.time} on ${ymd(target)}`, time: chosen.time };
        return status;
      }

      log(`${planTag}CLICK book-now`);
      await resolved.btn.click({ timeout: 10000 });
      await snap(page, `post-click-p${planIndex + 1}`);

      log(`${planTag}waiting for checkout BUY button (up to 45s)`);
      const checkout = await waitForCheckout(page, { timeoutMs: 45000 });
      if (!checkout.ok) {
        await snap(page, `no-buy-p${planIndex + 1}`);
        throw new Error(`checkout failed: ${checkout.reason}`);
      }
      await page.waitForTimeout(1000);
      await snap(page, `checkout-p${planIndex + 1}`);

      const buy = page.locator('button').filter({ hasText: /^BUY$/i }).first();
      if (await buy.count() === 0) throw new Error('BUY button missing on checkout after wait');
      log(`${planTag}CLICK BUY`);
      await buy.click();

      // Wait for the PURCHASING transient to fully resolve before navigating away.
      // The 2026-04-27 failure was navigating during PURCHASING, which aborted the in-flight transaction.
      const buyOutcome = await waitForBuyOutcome(page, { timeoutMs: 30000 });
      await snap(page, `post-buy-p${planIndex + 1}`);
      log(`${planTag}BUY outcome: ok=${buyOutcome.ok}${buyOutcome.ambiguous ? ' (ambiguous)' : ''} reason=${buyOutcome.reason} — ${(buyOutcome.detail||'').slice(0,300)}`);

      // Schedule is the ground truth — Mindbody's checkout UI is unreliable
      // (false-positive "BUY missing", false-negative "error modal but actually booked").
      log(`${planTag}verifying booked status on schedule`);
      await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
      await dismissCookieBanner(page);
      await clickClassesTab(page);
      await waitForScheduleView(page, 20000);
      await clickDayTab(page, target);
      const verify = await verifyOnSchedule(page, plan, target, chosen.time, { tries: 4, delayMs: 1500 });
      log(`${planTag}verify final: ${verify.status} (saw: ${verify.seen.join('→')})`);
      await snap(page, `verify-p${planIndex + 1}`);

      if (verify.status === 'BOOKED') {
        status = { ok: true, reason: 'booked', detail: `${plan.kind} @ ${chosen.time} on ${DAY_SHORT[target.getDay()]} ${ymd(target)}`, time: chosen.time };
      } else if (verify.status === 'FULL') {
        // Race lost — the spot we tried to book is gone. Fallback may still be open.
        const fbReason = `row went FULL (race lost)`;
        if (plan.fallback && chosen.time === plan.primaryTime) {
          log(`${planTag}primary FULL — attempting fallback ${plan.fallback}`);
          const fb = await attemptFallbackBooking(page, plan, target);
          if (fb.ok) {
            status = { ok: true, reason: 'booked (fallback)', detail: `${plan.kind} @ ${plan.fallback} on ${DAY_SHORT[target.getDay()]} ${ymd(target)} (primary ${plan.primaryTime}: ${fbReason})`, time: plan.fallback };
          } else {
            status = { ok: false, reason: 'unverified', detail: `primary: ${fbReason}; fallback: ${fb.reason}`, time: chosen.time };
          }
        } else {
          status = { ok: false, reason: 'unverified', detail: fbReason, time: chosen.time };
        }
      } else if (verify.status === 'BOOK_NOW') {
        // Definitively NOT booked — BUY click never landed, or checkout was aborted.
        // Don't fire fallback to avoid double-booking; user can retry manually.
        status = { ok: false, reason: 'not booked', detail: `row still BOOK NOW after BUY (BUY outcome: ${buyOutcome.reason} — ${(buyOutcome.detail||'').slice(0,150)})`, time: chosen.time };
      } else if (buyOutcome.ok) {
        // Verify is ambiguous (DETAILS or NOT_FOUND), but waitForBuyOutcome saw a clean settle.
        // Mindbody hides booked classes from the explore view sometimes — trust the BUY signal.
        status = { ok: true, reason: 'booked (BUY-confirmed)', detail: `${plan.kind} @ ${chosen.time} on ${DAY_SHORT[target.getDay()]} ${ymd(target)} — verify ${verify.status} but BUY ok (${buyOutcome.reason})`, time: chosen.time };
      } else {
        // Truly ambiguous: BUY didn't settle cleanly AND verify isn't BOOKED.
        // Don't double-book by firing fallback — report and let user check.
        status = { ok: false, reason: 'unverified', detail: `verify=${verify.status} (${verify.seen.join('→')}); BUY=${buyOutcome.reason}: ${(buyOutcome.detail||'').slice(0,150)}`, time: chosen.time };
      }
    } catch (e) {
      log(`${planTag}ERROR`, e.message);
      status = { ok: false, reason: status.reason === 'unknown' ? 'exception' : status.reason, detail: e.message, time: status.time };
      try { await snap(page, `error-p${planIndex + 1}`); } catch {}
    }
    // After a successful booking we update myBookings so subsequent plans
    // see the new entry (otherwise rare same-class same-day double-bookings
    // could slip through if the schedule reflects the booking instantly).
    if (status.ok && (status.reason === 'booked' || status.reason === 'booked (fallback)' || status.reason === 'booked (api-direct)' || status.reason === 'booked (BUY-confirmed)')) {
      myBookings.push({ ymd: ymd(target), kind: plan.kind, time: status.time || plan.primaryTime });
    }
    return status;
  }

  if (setupError) {
    // Page Yash NOW — booking window is 9am, manual override may be needed.
    // Fires regardless of suppressTg so synthetic tests still alert. Sends
    // even if the failed user IS Yash; the alert format is materially different
    // from the friendly per-user vibe message and is worth the duplicate ping.
    await tgYashAlert(buildSetupFailureAlert({
      userLabel: user ? (user.label || user.id) : 'yash (default)',
      planLine: plans.map(p => `${p.kind} @ ${p.primaryTime}${p.fallback ? ` (fb ${p.fallback})` : ''}`).join(' + '),
      dayLabel: `${DAY_SHORT[target.getDay()]} ${ymd(target)}`,
      errorMessage: setupError.message,
      runId: RUN_ID,
      msToNine: t9.getTime() - Date.now(),
    }));
    // Login or pre-flight failed → mark every plan as exception, no per-plan attempt.
    for (const plan of plans) {
      results.push({ plan, status: { ok: false, reason: 'exception', detail: setupError.message, time: null } });
    }
  } else {
    // Parallel fan-out across plans. Each plan gets its own page (shares ctx,
    // so login cookies + storage carry over). Promise.all preserves array
    // order; plans are pre-sorted FIT-first so FIT's microtask queues first
    // and wins any shared-resource race (e.g. account-side lock at 09:00:00).
    log(`firing ${plans.length} plan(s) in parallel: ${plans.map(p => `${p.kind}@${p.primaryTime}`).join(', ')}`);
    const settled = await Promise.all(plans.map(async (plan, i) => {
      let planPage;
      try {
        planPage = await ctx.newPage();
        const status = await bookOnePlan(plan, i, planPage);
        return { plan, status };
      } catch (e) {
        return { plan, status: { ok: false, reason: 'exception', detail: e.message, time: null } };
      } finally {
        if (planPage) { try { await planPage.close(); } catch {} }
      }
    }));
    results.push(...settled);
  }

  try { if (ctx) await saveStorageStateAtomic(ctx, authPath); } catch {}
  try { if (browser) await browser.close(); } catch {}

  // Build aggregated Telegram message. For single-plan days this is identical
  // to the legacy single-message output. For back-to-back days each plan gets
  // its own personality.outcome line so Melissa sees both BURN and FIT.
  const dayLabel = `${DAY_SHORT[target.getDay()]} ${ymd(target)}`;
  const messages = results.map(({ plan, status }) => {
    const planLine = `${plan.kind} @ ${status.time || plan.primaryTime}${plan.fallback && status.time === plan.fallback ? ' (fallback)' : ''}`;
    return personality.outcome(user, status, { planLine, dayLabel, runId: RUN_ID, didRelogin });
  });
  await tg(messages.join('\n\n'));

  // Drop a structured result file for book-all.js to roll up into the daily
  // summary. Only written when explicitly asked (env set); standalone book.js
  // runs (manual smoke tests, ad-hoc) don't touch disk here.
  if (process.env.BOOKER_RESULT_FILE) {
    try {
      const payload = {
        user: user ? { id: user.id, label: user.label || user.id } : { id: 'yash', label: 'Yash' },
        results: results.map(r => ({
          plan: { kind: r.plan.kind, primaryTime: r.plan.primaryTime, fallback: r.plan.fallback || null },
          status: {
            ok: !!r.status.ok,
            reason: r.status.reason || 'unknown',
            detail: r.status.detail || '',
            time: r.status.time || null,
          },
        })),
        setupErrored: !!setupError,
        dayLabel,
        runId: RUN_ID,
        targetYmd: ymd(target),
      };
      fs.writeFileSync(process.env.BOOKER_RESULT_FILE, JSON.stringify(payload));
    } catch (e) { log(`result-file write failed: ${e.message}`); }
  }

  flushLog();
  const allOk = results.every(r => r.status.ok);
  process.exit(allOk ? 0 : 1);
})();
