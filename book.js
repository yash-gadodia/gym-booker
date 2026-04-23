require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { DAY_SHORT, addDays, ymd, classPlan, normalize, rowMatches, rowStatus } = require('./lib');

const GYM_URL = 'https://www.mindbodyonline.com/explore/locations/ragtag';
const SGT_TZ = 'Asia/Singapore';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noWait = args.includes('--now') || args.includes('--no-wait');
const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

const RUN_ID = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
const RUN_DIR = path.join(__dirname, 'runs', RUN_ID);
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

async function tg(text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) { log('tg: missing creds'); return; }
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
    });
    if (!r.ok) log('tg FAIL', r.status, await r.text());
    else log('tg sent');
  } catch (e) { log('tg ERR', e.message); }
}

async function isLoggedOut(page) {
  const sel = 'button:has-text("Sign in"), a:has-text("Sign in"), button:has-text("Log in"), a:has-text("Log in")';
  const el = page.locator(sel).first();
  if (await el.count() === 0) return false;
  return await el.isVisible({ timeout: 2000 }).catch(() => false);
}

async function loginAndSave(page, ctx, authPath) {
  log('AUTH: re-login starting');
  if (!process.env.MINDBODY_EMAIL || !process.env.MINDBODY_PASSWORD) {
    throw new Error('auth expired but MINDBODY_EMAIL/MINDBODY_PASSWORD not set in .env');
  }
  const loginSelectors = [
    'button:has-text("Sign in")', 'a:has-text("Sign in")',
    'button:has-text("Log in")', 'a:has-text("Log in")',
  ];
  let clicked = false;
  for (const sel of loginSelectors) {
    const el = page.locator(sel).first();
    if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
      try { await el.click({ timeout: 5000 }); clicked = true; log(`AUTH: clicked ${sel}`); break; } catch {}
    }
  }
  if (!clicked) throw new Error('auth expired and no Sign in button visible');
  await page.waitForTimeout(2500);
  const emailInput = page.locator('input:visible').first();
  await emailInput.waitFor({ state: 'visible', timeout: 15000 });
  await emailInput.fill(process.env.MINDBODY_EMAIL);
  await page.click('button:has-text("Continue"), button:has-text("Next"), button[type="submit"]');
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.fill('input[type="password"]', process.env.MINDBODY_PASSWORD);
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

async function resolveButton(rowLoc) {
  let b = rowLoc.locator('button, a').filter({ hasText: /BOOK NOW/i }).first();
  if (await b.count() > 0) return { btn: b, label: 'BOOK NOW' };
  b = rowLoc.locator('button, a').filter({ hasText: /DETAILS/i }).first();
  if (await b.count() > 0) return { btn: b, label: 'DETAILS' };
  return null;
}

async function attemptRow(page, plan, time) {
  const hit = await findRow(page, plan, time);
  if (!hit) return { notFound: true, time };
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

function nineAmToday() { const d = new Date(); d.setHours(9,0,0,0); return d; }

(async () => {
  const today = new Date();
  const target = dateArg ? new Date(`${dateArg}T00:00:00`) : addDays(today, 2);
  const plan = classPlan(target);
  const t9 = nineAmToday();

  log(`RUN ${RUN_ID}`);
  log(`today: ${ymd(today)} ${DAY_SHORT[today.getDay()]}`);
  log(`target: ${ymd(target)} ${DAY_SHORT[target.getDay()]}`);
  log(`plan: ${plan.kind} @ ${plan.primaryTime}` + (plan.fallback ? ` (fallback ${plan.fallback})` : ''));
  log(`mode: dry=${dryRun} nowait=${noWait}`);
  log(`9am SGT target: ${t9.toISOString()} (ms-from-now: ${t9.getTime() - Date.now()})`);

  const planLineForMsg = `${plan.kind} @ ${plan.primaryTime}${plan.fallback ? ` (fallback ${plan.fallback})` : ''}`;
  await tg(
    `🚀 *ragtag booking* — *started*\n` +
    `target: ${DAY_SHORT[target.getDay()]} ${ymd(target)} — ${planLineForMsg}\n` +
    `run: \`${RUN_ID}\``
  );

  const authPath = path.join(__dirname, 'auth.json');
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
      await tg(`🔐 *ragtag booking* — *logged in*\nfresh session saved (${forceLogin ? 'proactive' : 'reactive'})`);
    }

    await clickClassesTab(page);
    await waitForScheduleView(page, 20000);
    await clickDayTab(page, target);
    await snap(page, 'day-selected');

    // Pre-stage: try primary, then fallback if primary missing/FULL/BOOKED-elsewhere
    async function pickRow(reason) {
      log(`pickRow (${reason}): primary=${plan.primaryTime}${plan.fallback ? ` fallback=${plan.fallback}`:''}`);
      let a = await attemptRow(page, plan, plan.primaryTime);
      log(`  primary: ${a.notFound ? 'NOT FOUND' : `${a.status} — ${a.text.slice(0,140)}`}`);
      if (!a.notFound && a.status === 'BOOKED') return a;
      if (!a.notFound && (a.status === 'BOOK_NOW' || a.status === 'DETAILS')) return a;
      if (plan.fallback) {
        const b = await attemptRow(page, plan, plan.fallback);
        log(`  fallback: ${b.notFound ? 'NOT FOUND' : `${b.status} — ${b.text.slice(0,140)}`}`);
        if (!b.notFound && (b.status === 'BOOKED' || b.status === 'BOOK_NOW' || b.status === 'DETAILS')) return b;
        // Both unusable — prefer to surface primary's failure reason
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

    // Wait to 09:00:00.000 SGT unless --now or already past
    const msLeft = t9.getTime() - Date.now();
    if (!noWait && msLeft > 0) {
      const secs = Math.round(msLeft / 1000);
      await tg(
        `⏸️ *ragtag booking* — *on standby*\n` +
        `${plan.kind} @ ${chosen.time} — row staged (${chosen.status})\n` +
        `waiting ${secs}s to 09:00:00.000 SGT`
      );
      log(`waiting ${msLeft}ms to 09:00:00.000 SGT`);
      if (msLeft > 15000) {
        await new Promise(r => setTimeout(r, msLeft - 10000));
        log('T-10s refresh: clicking day tab again');
        await clickDayTab(page, target);
        chosen = await pickRow('T-10s refresh');
        if (chosen.notFound) throw new Error('row disappeared after refresh');
        if (chosen.status === 'BOOKED') { status = { ok: true, reason: 'already_booked', detail: `${plan.kind} @ ${chosen.time} — booked during refresh`, time: chosen.time }; return; }
        if (chosen.status === 'FULL') throw new Error(`${plan.kind} went FULL before 9am (all fallbacks too)`);
      }
      await busyWaitUntil(t9.getTime());
      log(`drift from 09:00:00.000: ${Date.now() - t9.getTime()}ms`);
    } else if (msLeft < 0) {
      log(`already past 9am today (by ${-msLeft}ms) — clicking immediately`);
    } else {
      log('--now: clicking immediately');
    }

    // Resolve the click target on the chosen row
    let resolved = await resolveButton(chosen.row);
    if (!resolved) throw new Error(`no Book Now / Details button on chosen row (status=${chosen.status})`);
    log(`button label: ${resolved.label}`);
    const btn = resolved.btn;

    if (dryRun) {
      log('DRY RUN — skipping click + buy');
      await snap(page, 'dryrun-at-click');
      status = { ok: true, reason: 'dry_run', detail: `would book ${plan.kind} @ ${chosen.time} on ${ymd(target)}`, time: chosen.time };
      return;
    }

    log('CLICK book-now');
    await btn.click({ timeout: 10000 });
    await snap(page, 'post-click');

    // Wait for checkout BUY button
    log('waiting for BUY button on checkout');
    try {
      await page.waitForSelector('button:has-text("BUY"), button:has-text("Buy")', { timeout: 30000 });
    } catch {
      await snap(page, 'no-buy');
      throw new Error('checkout did not load (no BUY button within 30s)');
    }
    await page.waitForTimeout(1000);
    await snap(page, 'checkout');

    const buy = page.locator('button').filter({ hasText: /^BUY$/i }).first();
    if (await buy.count() === 0) throw new Error('BUY button missing on checkout');
    log('CLICK BUY');
    await buy.click();
    await page.waitForTimeout(5000);
    await snap(page, 'post-buy');

    // Verify on schedule
    log('verifying booked status on schedule');
    await page.goto(GYM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    await dismissCookieBanner(page);
    await clickClassesTab(page);
    await waitForScheduleView(page, 20000);
    await clickDayTab(page, target);
    const verify = await findRow(page, plan, chosen.time);
    const vStatus = verify ? rowStatus(verify.text) : 'NOT_FOUND';
    log(`verify status: ${vStatus}, text: ${verify ? verify.text.slice(0,160) : '(no row)'}`);
    await snap(page, 'verify');

    if (vStatus === 'BOOKED') {
      status = { ok: true, reason: 'booked', detail: `${plan.kind} @ ${chosen.time} on ${DAY_SHORT[target.getDay()]} ${ymd(target)}`, time: chosen.time };
    } else {
      status = { ok: false, reason: 'unverified', detail: `clicked BUY but row shows ${vStatus}`, time: chosen.time };
    }
  } catch (e) {
    log('ERROR', e.message);
    status = { ok: false, reason: status.reason === 'unknown' ? 'exception' : status.reason, detail: e.message, time: status.time };
    try { await snap(page, 'error'); } catch {}
  } finally {
    try { await ctx.storageState({ path: authPath }); } catch {}
    await browser.close();

    const icon = status.ok ? '✅' : '❌';
    const planLine = `${plan.kind} @ ${status.time || plan.primaryTime}${plan.fallback && status.time === plan.fallback ? ' (fallback)' : ''}`;
    const reloginLine = didRelogin ? `\n_auto re-login used — auth.json refreshed_` : '';
    const msg =
      `${icon} *ragtag booking* — ${ymd(target)} ${DAY_SHORT[target.getDay()]}\n` +
      `${planLine}\n` +
      `*${status.reason}:* ${status.detail}${reloginLine}\n` +
      `run: \`${RUN_ID}\``;
    await tg(msg);
    flushLog();
    process.exit(status.ok ? 0 : 1);
  }
})();
