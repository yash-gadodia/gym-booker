require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const {
  DAY_SHORT, addDays, ymd, classPlan, normalize, rowMatches, rowStatus,
  decideNextAction, isBookingWindowErrorText, isLoginRedirectUrl,
  classifyButtonStates, parseBookingCard, timeToHHMM, resolveSchedule,
} = require('./lib');
const {
  captureBearerToken, fetchScheduleClasses, findClass,
  fetchPaymentPassUuid, bookViaApi, generateRecaptchaToken,
} = require('./api-client');
const usersLib = require('./users');
const personality = require('./personality');

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

async function clickVisible(page, selector) {
  const els = await page.locator(selector).all();
  for (const el of els) {
    const r = await el.evaluate(n => n.getBoundingClientRect()).catch(() => null);
    if (!r || r.width === 0 || r.height === 0) continue;
    try { await el.click({ timeout: 5000 }); return { ok: true, rect: r }; } catch {}
  }
  return { ok: false };
}

// Resolve creds once. Yash uses env, other users use their users.json record.
const creds = user
  ? usersLib.getCreds(user)
  : { email: process.env.MINDBODY_EMAIL, password: process.env.MINDBODY_PASSWORD };

async function loginAndSave(page, ctx, authPath) {
  log('AUTH: re-login starting');
  if (!creds.email || !creds.password) {
    throw new Error('auth expired but creds not available' +
      (user ? ` for user "${user.id}" in users.json` : ' (MINDBODY_EMAIL/PASSWORD not set in .env)'));
  }
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

async function dismissCookieBanner(page) {
  for (const sel of [
    'button:has-text("AGREE AND PROCEED")',
    'button:has-text("Accept")',
    'button:has-text("I Agree")',
    '#onetrust-accept-btn-handler',
  ]) {
    const el = await page.$(sel);
    if (el) { try { await el.click({ timeout: 3000 }); log(`cookie dismissed: ${sel}`); await page.waitForTimeout(600); return; } catch {} }
  }
}

async function clickClassesTab(page) {
  for (let i = 0; i < 4; i++) {
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

async function busyWaitUntil(targetMs) {
  const delta = targetMs - Date.now();
  if (delta <= 0) return;
  log(`sleeping ${delta}ms to target`);
  if (delta > 500) await new Promise(r => setTimeout(r, delta - 400));
  while (Date.now() < targetMs) {}
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

  // 3. Pre-fetch payment pass.
  log('api-direct: fetching payment pass UUID');
  let paymentMethodUuid;
  try { paymentMethodUuid = await fetchPaymentPassUuid(bearer, classMeta); }
  catch (e) { return { ok: false, reason: 'pass-fetch-failed', detail: e.message, time: plan.primaryTime }; }
  log(`api-direct: pass ${paymentMethodUuid}`);

  // 4. Wait to 09:00:00.000 SGT.
  const usedTime = classMeta.startTime
    ? (() => { const d = new Date(classMeta.startTime); return `${(d.getHours()%12||12)}:${String(d.getMinutes()).padStart(2,'0')}${d.getHours()<12?'am':'pm'}`; })()
    : plan.primaryTime;
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
      if (ms > 500) await new Promise(r => setTimeout(r, ms - 400));
      while (Date.now() < t9.getTime()) {}
      log(`api-direct: drift ${Date.now() - t9.getTime()}ms`);
    }
  }

  // 5. Fire the booking pipeline.
  log('api-direct: firing booking pipeline');
  let result;
  try { result = await bookViaApi(bearer, { classMeta, paymentMethodUuid, recaptchaToken: '' }); }
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

  if (!result.ok) {
    return {
      ok: false,
      reason: `api-${result.step}-failed`,
      detail: `HTTP ${result.status}: ${(result.body || '').slice(0,300)}`,
      time: usedTime,
      timing: result.timing,
    };
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
  // For Yash (no --user): always use classPlan defaults.
  // For other users: resolve from their schedule override; null = opt-out for this DOW.
  const basePlan = user ? resolveSchedule(target, user.schedule) : classPlan(target);
  if (!basePlan) {
    // User explicitly has no schedule for this day-of-week — exit before
    // browser launch, no booking attempted, no error alert.
    const dayLabel = `${DAY_SHORT[target.getDay()]} ${ymd(target)}`;
    log(`opt_out_day: ${user.label || user.id} has no schedule for ${dayLabel}`);
    await tg(personality.outcome(user, { ok: true, reason: 'opt_out_day' }, { dayLabel, planLine: '', runId: RUN_ID }));
    flushLog();
    process.exit(0);
  }
  const plan = {
    kind: kindOverride || basePlan.kind,
    primaryTime: timeOverride || basePlan.primaryTime,
    fallback: noFallback || timeOverride ? null : basePlan.fallback,
  };
  const t9 = nineAmToday();

  log(`RUN ${RUN_ID}`);
  log(`today: ${ymd(today)} ${DAY_SHORT[today.getDay()]}`);
  log(`target: ${ymd(target)} ${DAY_SHORT[target.getDay()]}`);
  log(`plan: ${plan.kind} @ ${plan.primaryTime}` + (plan.fallback ? ` (fallback ${plan.fallback})` : ''));
  log(`mode: dry=${dryRun} nowait=${noWait}`);
  log(`9am SGT target: ${t9.toISOString()} (ms-from-now: ${t9.getTime() - Date.now()})`);

  const planLineForMsg = `${plan.kind} @ ${plan.primaryTime}${plan.fallback ? ` (fallback ${plan.fallback})` : ''}`;
  const dayLabelForMsg = `${DAY_SHORT[target.getDay()]} ${ymd(target)}`;
  await tg(personality.started(user, {
    planLine: planLineForMsg,
    dayLabel: dayLabelForMsg,
    secs: Math.max(0, Math.round((t9.getTime() - Date.now()) / 1000)),
  }));

  const authPath = user
    ? usersLib.getAuthPath(user)
    : path.join(__dirname, 'auth.json');
  const msToNine = t9.getTime() - Date.now();
  const forceLogin = !noWait && msToNine > 90000;
  log(`auth: ${forceLogin ? `FORCE fresh login (${msToNine}ms to 9am, >90s safety margin)` : 'using cached auth.json if available'}`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }, locale: 'en-SG', timezoneId: SGT_TZ,
    storageState: (!forceLogin && fs.existsSync(authPath)) ? authPath : undefined,
  });
  const page = await ctx.newPage();
  let status = { ok: false, reason: 'unknown', detail: '', time: null };
  let didRelogin = false;

  try {
    log('navigating to ragtag');
    await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    await dismissCookieBanner(page);
    await snap(page, 'landed');

    if (await isLoggedOut(page)) {
      log(`AUTH: detected logged-out state — ${forceLogin ? 'proactive' : 'reactive'} login`);
      didRelogin = true;
      await snap(page, 'logged-out');
      await loginAndSave(page, ctx, authPath);
      log('AUTH: re-navigating to ragtag after login');
      await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
      await dismissCookieBanner(page);
      await snap(page, 'post-relogin');
      if (await isLoggedOut(page)) throw new Error('still logged out after re-login attempt');
      await tg(personality.loggedIn(user));
    }

    // Pre-flight: /account/schedule is the authoritative bookings list. Skip
    // if user already has a same-kind booking on the target date — explore-page
    // row text can show stale BOOK NOW even when the user is already booked
    // (caused the 2026-04-27 duplicate-booking incident).
    if (!allowDuplicate) {
      try {
        const myBookings = await fetchMyUpcomingBookings(page);
        log(`my-schedule: ${myBookings.length} upcoming bookings`);
        for (const b of myBookings) log(`  ${b.ymd} ${b.kind} @ ${b.time}`);
        const dup = myBookings.find(b => b.ymd === ymd(target) && b.kind === plan.kind);
        if (dup) {
          status = {
            ok: true,
            reason: 'already_booked',
            detail: `${plan.kind} on ${ymd(target)} already booked at ${dup.time} (skipped, would have tried ${plan.primaryTime})`,
            time: dup.time,
          };
          return;
        }
      } catch (e) {
        log(`my-schedule pre-flight failed (${e.message.slice(0,120)}) — continuing without guard`);
      }
      // Re-land on ragtag for the rest of the flow.
      await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      await dismissCookieBanner(page);
    }

    // ── API-DIRECT FAST PATH ──────────────────────────────────────────────
    // Bypass the React UI and book via Mindbody's marketplace gateway directly.
    // T+0 → committed in ~2.2s vs ~12s for the UI flow. Falls back to UI on
    // any failure so we never miss a booking due to API regressions.
    if (apiDirect && !dryRun) {
      try {
        const apiResult = await executeApiDirect(page, plan, target, t9, noWait);
        if (apiResult.ok) {
          status = apiResult;
          return;
        }
        log(`api-direct failed (${apiResult.reason}: ${(apiResult.detail||'').slice(0,200)}) — falling back to UI flow`);
      } catch (e) {
        log(`api-direct exception (${e.message.slice(0,200)}) — falling back to UI flow`);
      }
    }
    // ──────────────────────────────────────────────────────────────────────

    await clickClassesTab(page);
    await waitForScheduleView(page, 20000);
    await clickDayTab(page, target);
    await snap(page, 'day-selected');

    // Pre-stage: verify the row exists and prefer fallback if primary is FULL/BOOKED-elsewhere.
    // Status here may be DETAILS (window not yet open) — that's fine; we refresh at 9am.
    async function pickRow(reason) {
      log(`pickRow (${reason}): primary=${plan.primaryTime}${plan.fallback ? ` fallback=${plan.fallback}`:''}`);
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
    log(`chosen: ${plan.kind} @ ${chosen.time} — status=${chosen.status}`);

    if (chosen.status === 'BOOKED') {
      status = { ok: true, reason: 'already_booked', detail: `${plan.kind} @ ${chosen.time} was already BOOKED`, time: chosen.time };
      return;
    }
    if (chosen.status === 'FULL') throw new Error(`${plan.kind} FULL (primary${plan.fallback ? ' and fallback' : ''})`);

    // Wait to 09:00:00.000 SGT unless --now or already past.
    const msLeft = t9.getTime() - Date.now();
    if (!noWait && msLeft > 0) {
      const secs = Math.round(msLeft / 1000);
      await tg(personality.standby(user, {
        planLine: `${plan.kind} @ ${chosen.time}`,
        secs,
        mode: 'ui',
      }));
      log(`waiting ${msLeft}ms to 09:00:00.000 SGT`);
      if (msLeft > 15000) {
        await new Promise(r => setTimeout(r, msLeft - 10000));
        log('T-10s soft refresh: clicking day tab again');
        await softRefreshSchedule(page, target);
        const snapshot = await pickRow('T-10s refresh');
        if (snapshot.notFound) throw new Error('row disappeared after refresh');
        if (snapshot.status === 'BOOKED') {
          status = { ok: true, reason: 'already_booked', detail: `${plan.kind} @ ${snapshot.time} — booked during refresh`, time: snapshot.time };
          return;
        }
        if (snapshot.status === 'FULL') throw new Error(`${plan.kind} went FULL before 9am (all fallbacks too)`);
        chosen = snapshot;
      }
      await busyWaitUntil(t9.getTime());
      log(`drift from 09:00:00.000: ${Date.now() - t9.getTime()}ms`);
    } else if (msLeft < 0) {
      log(`already past 9am today (by ${-msLeft}ms) — clicking immediately`);
    } else {
      log('--now: clicking immediately');
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
      return;
    }
    if (poll.action === 'fail') {
      // Try fallback once if primary is FULL/NOT_FOUND (fast race: someone else booked it)
      if (plan.fallback && chosen.time === plan.primaryTime) {
        log(`primary ${poll.reason} — trying fallback ${plan.fallback}`);
        const pollFb = await pollUntilBookable(page, plan, plan.fallback, { timeoutMs: 10000, intervalMs: 250 });
        if (pollFb.action === 'click') {
          chosen = { row: pollFb.row, text: pollFb.text, time: plan.fallback, status: 'BOOK_NOW' };
        } else if (pollFb.action === 'done') {
          status = { ok: true, reason: 'already_booked', detail: `${plan.kind} @ ${plan.fallback} — ${pollFb.detail}`, time: plan.fallback };
          return;
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
    log(`button label: ${resolved.label}`);

    if (dryRun) {
      log('DRY RUN — skipping click + buy');
      await snap(page, 'dryrun-at-click');
      status = { ok: true, reason: 'dry_run', detail: `would book ${plan.kind} @ ${chosen.time} on ${ymd(target)}`, time: chosen.time };
      return;
    }

    log('CLICK book-now');
    await resolved.btn.click({ timeout: 10000 });
    await snap(page, 'post-click');

    log('waiting for checkout BUY button (up to 45s)');
    const checkout = await waitForCheckout(page, { timeoutMs: 45000 });
    if (!checkout.ok) {
      await snap(page, 'no-buy');
      throw new Error(`checkout failed: ${checkout.reason}`);
    }
    await page.waitForTimeout(1000);
    await snap(page, 'checkout');

    const buy = page.locator('button').filter({ hasText: /^BUY$/i }).first();
    if (await buy.count() === 0) throw new Error('BUY button missing on checkout after wait');
    log('CLICK BUY');
    await buy.click();

    // Wait for the PURCHASING transient to fully resolve before navigating away.
    // The 2026-04-27 failure was navigating during PURCHASING, which aborted the in-flight transaction.
    const buyOutcome = await waitForBuyOutcome(page, { timeoutMs: 30000 });
    await snap(page, 'post-buy');
    log(`BUY outcome: ok=${buyOutcome.ok}${buyOutcome.ambiguous ? ' (ambiguous)' : ''} reason=${buyOutcome.reason} — ${(buyOutcome.detail||'').slice(0,300)}`);

    // Schedule is the ground truth — Mindbody's checkout UI is unreliable
    // (false-positive "BUY missing", false-negative "error modal but actually booked").
    log('verifying booked status on schedule');
    await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    await dismissCookieBanner(page);
    await clickClassesTab(page);
    await waitForScheduleView(page, 20000);
    await clickDayTab(page, target);
    const verify = await verifyOnSchedule(page, plan, target, chosen.time, { tries: 4, delayMs: 1500 });
    log(`verify final: ${verify.status} (saw: ${verify.seen.join('→')})`);
    await snap(page, 'verify');

    if (verify.status === 'BOOKED') {
      status = { ok: true, reason: 'booked', detail: `${plan.kind} @ ${chosen.time} on ${DAY_SHORT[target.getDay()]} ${ymd(target)}`, time: chosen.time };
    } else if (verify.status === 'FULL') {
      // Race lost — the spot we tried to book is gone. Fallback may still be open.
      const fbReason = `row went FULL (race lost)`;
      if (plan.fallback && chosen.time === plan.primaryTime) {
        log(`primary FULL — attempting fallback ${plan.fallback}`);
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
    log('ERROR', e.message);
    status = { ok: false, reason: status.reason === 'unknown' ? 'exception' : status.reason, detail: e.message, time: status.time };
    try { await snap(page, 'error'); } catch {}
  } finally {
    try { await ctx.storageState({ path: authPath }); } catch {}
    await browser.close();

    const planLine = `${plan.kind} @ ${status.time || plan.primaryTime}${plan.fallback && status.time === plan.fallback ? ' (fallback)' : ''}`;
    const dayLabel = `${DAY_SHORT[target.getDay()]} ${ymd(target)}`;
    const msg = personality.outcome(user, status, { planLine, dayLabel, runId: RUN_ID, didRelogin });
    await tg(msg);
    flushLog();
    process.exit(status.ok ? 0 : 1);
  }
})();
