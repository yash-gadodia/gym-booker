const fs = require('fs');

const DAY_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function classPlan(targetDate) {
  const dow = targetDate.getDay();
  if (dow === 0) return { kind: 'Gymnastics', primaryTime: '1:00pm',  fallback: null };
  if (dow === 6) return { kind: 'Gymnastics', primaryTime: '12:30pm', fallback: null };
  if (dow === 5) return { kind: 'FIT', primaryTime: '7:30am', fallback: null };
  return { kind: 'FIT', primaryTime: '6:30am', fallback: '7:30am' };
}

// Per-user schedule resolution. `scheduleOverride` is either:
//   - null/undefined → use classPlan() (Yash's default rules)
//   - { Mon: {...}|[{...},{...}]|null, Tue: ..., ... } → per-day map keyed by DAY_SHORT
//
// Returns a single plan { kind, primaryTime, fallback } OR null when the user
// has explicitly opted out of that DOW. When the day's entry is an array
// (back-to-back classes), this returns the FIRST plan only — callers that
// need all classes for the day should use resolveSchedulePlans (plural).
function resolveSchedule(targetDate, scheduleOverride) {
  if (!scheduleOverride) return classPlan(targetDate);
  const dayKey = DAY_SHORT[targetDate.getDay()];
  if (!(dayKey in scheduleOverride)) return null;
  const entry = scheduleOverride[dayKey];
  if (!entry) return null;
  if (Array.isArray(entry)) {
    if (entry.length === 0) return null;
    const e = entry[0];
    return { kind: e.kind, primaryTime: e.primaryTime, fallback: e.fallback || null };
  }
  return { kind: entry.kind, primaryTime: entry.primaryTime, fallback: entry.fallback || null };
}

// Plural variant: returns ALL plans for the day, in order. Single-class days
// produce a 1-element array; back-to-back days produce N elements; opted-out
// days return []. Used by the booking loop in book.js to support users like
// Melissa who book BURN + FIT back-to-back on the same evening.
function resolveSchedulePlans(targetDate, scheduleOverride) {
  if (!scheduleOverride) return [classPlan(targetDate)];
  const dayKey = DAY_SHORT[targetDate.getDay()];
  if (!(dayKey in scheduleOverride)) return [];
  const entry = scheduleOverride[dayKey];
  if (!entry) return [];
  const arr = Array.isArray(entry) ? entry : [entry];
  return arr.map(e => ({ kind: e.kind, primaryTime: e.primaryTime, fallback: e.fallback || null }));
}

// Read overrides.json. Returns the parsed object on success, or an empty
// shell { users: {} } on missing/malformed — bookings must never crash on a
// bad override file, and an empty file means "no overrides, use baseline".
function loadOverrides(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { users: {} };
    const raw = fs.readFileSync(filePath, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || !j.users || typeof j.users !== 'object') return { users: {} };
    return j;
  } catch {
    return { users: {} };
  }
}

// Final booking decision for (targetDate, userKey). Layered precedence:
//   1. perDate[ymd] is an object   → use it (kind/time fall back to classPlan defaults)
//   2. perDate[ymd] === null       → skip this date
//   3. pauseUntil >= targetDate    → paused (skip)
//   4. baseline schedule           → resolveSchedule or classPlan; null → opt_out_day
//
// Note: explicit perDate beats pauseUntil — if you set an override for a date
// that's inside your pause window, the override wins (treated as "break the pause
// for this one class"). Explicit perDate also beats DOW opt-out for the same reason.
//
// Returns either a plan { kind, primaryTime, fallback } OR a skip object
// { skip: 'paused'|'date_skip'|'opt_out_day', detail? }.
function resolveBookingForDate(targetDate, userKey, userScheduleOverride, dateOverrides) {
  const target = ymd(targetDate);
  const userOverride = (dateOverrides && dateOverrides.users && dateOverrides.users[userKey]) || {};
  const perDate = userOverride.perDate || {};

  if (Object.prototype.hasOwnProperty.call(perDate, target)) {
    const entry = perDate[target];
    if (entry === null) return { skip: 'date_skip' };
    if (entry && typeof entry === 'object') {
      // Singular resolver: an array per-date override (double-booking) collapses
      // to its first class, mirroring resolveSchedule. Plural callers (book.js)
      // get every class via resolveBookingsForDate.
      const dowDefault = classPlan(targetDate);
      const first = Array.isArray(entry) ? entry[0] : entry;
      if (!first) return { skip: 'date_skip' };
      return {
        kind: first.kind || dowDefault.kind,
        primaryTime: first.time || first.primaryTime || dowDefault.primaryTime,
        fallback: null,
      };
    }
  }

  if (userOverride.pauseUntil && target <= userOverride.pauseUntil) {
    return { skip: 'paused', detail: `paused until ${userOverride.pauseUntil}` };
  }

  const base = userScheduleOverride
    ? resolveSchedule(targetDate, userScheduleOverride)
    : classPlan(targetDate);
  if (!base) return { skip: 'opt_out_day' };
  return base;
}

// Plural variant of resolveBookingForDate: returns either { skip, detail? }
// or { plans: [{kind, primaryTime, fallback}, ...] }. Per-date overrides and
// pause windows always produce a single plan (back-to-back is only supported
// in the baseline weekly schedule). DOW opt-outs and missing-key days surface
// as { skip: 'opt_out_day' }.
function resolveBookingsForDate(targetDate, userKey, userScheduleOverride, dateOverrides) {
  const target = ymd(targetDate);
  const userOverride = (dateOverrides && dateOverrides.users && dateOverrides.users[userKey]) || {};
  const perDate = userOverride.perDate || {};

  if (Object.prototype.hasOwnProperty.call(perDate, target)) {
    const entry = perDate[target];
    if (entry === null) return { skip: 'date_skip' };
    if (entry && typeof entry === 'object') {
      // A per-date override is a single class {time,kind} OR an array of them
      // for a double-booking (e.g. 8:30am Lift + 9:30am Steam). Either way it
      // fully replaces the day's baseline.
      const dowDefault = classPlan(targetDate);
      const arr = Array.isArray(entry) ? entry : [entry];
      if (arr.length === 0) return { skip: 'date_skip' };
      return {
        plans: arr.map(e => ({
          kind: e.kind || dowDefault.kind,
          primaryTime: e.time || e.primaryTime || dowDefault.primaryTime,
          fallback: null,
        })),
      };
    }
  }

  if (userOverride.pauseUntil && target <= userOverride.pauseUntil) {
    return { skip: 'paused', detail: `paused until ${userOverride.pauseUntil}` };
  }

  const plans = userScheduleOverride
    ? resolveSchedulePlans(targetDate, userScheduleOverride)
    : [classPlan(targetDate)];
  if (plans.length === 0) return { skip: 'opt_out_day' };
  return { plans };
}

function normalize(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

function rowMatches(text, { kind, time }) {
  const t = normalize(text);
  if (kind === 'FIT' && !/CROSSFIT® FIT\b/i.test(t)) return false;
  if (kind === 'Gymnastics' && !/CROSSFIT® Gymnastics\b/i.test(t)) return false;
  // BURN appears under "Gym classes Burn" prefix (not Crossfit®). Reject rows
  // that are clearly other kinds so a BURN search at 6:30pm doesn't latch onto
  // a co-timed FIT/Lift row.
  if (kind === 'BURN') {
    if (!/\bBurn\b/i.test(t)) return false;
    if (/CROSSFIT®\s*(FIT|Lift|Gymnastics|Foundations)\b/i.test(t)) return false;
  }
  // Steam has no kind-specific text gate elsewhere; require the row to actually
  // say "Steam" so a same-time class can't be latched by mistake.
  if (kind === 'Steam' && !/steam/i.test(t)) return false;
  const [hhmm, ap] = time.split(/(am|pm)/i);
  const timeRe = new RegExp(`${hhmm.trim().replace(':','\\:')}\\s*${ap}`, 'i');
  return timeRe.test(t);
}

function rowStatus(text) {
  if (/\bBOOKED\b/i.test(text)) return 'BOOKED';
  if (/BOOK NOW/i.test(text)) return 'BOOK_NOW';
  if (/JOIN\s*WAITLIST|WAITLIST/i.test(text)) return 'WAITLIST';
  if (/\bFULL\b/i.test(text)) return 'FULL';
  if (/\bDETAILS\b/i.test(text)) return 'DETAILS';
  return 'UNKNOWN';
}

// Decide what the booking flow should do, given a row's status at a given moment
// (T+0 = at/after 9am when booking is expected to open).
//
// Returns one of:
//   { action: 'click' }            — BOOK NOW visible; click it
//   { action: 'done', detail: ..}  — already BOOKED; nothing to do
//   { action: 'poll' }              — DETAILS (window not yet visible in DOM) or UNKNOWN; keep polling
//   { action: 'fail', reason }     — FULL / NOT_FOUND etc; terminal failure
function decideNextAction(status) {
  switch (status) {
    case 'BOOK_NOW': return { action: 'click' };
    case 'BOOKED':   return { action: 'done', detail: 'already BOOKED' };
    case 'DETAILS':  return { action: 'poll' };
    case 'UNKNOWN':  return { action: 'poll' };
    case 'FULL':     return { action: 'fail', reason: 'class is FULL' };
    case 'WAITLIST': return { action: 'fail', reason: 'class is on WAITLIST — manual join required' };
    case 'NOT_FOUND':return { action: 'fail', reason: 'row disappeared from schedule' };
    default:         return { action: 'fail', reason: `unexpected status: ${status}` };
  }
}

// MindBody shows this modal when you click DETAILS/BOOK NOW on a class whose
// booking window hasn't opened yet (or just closed). Used to surface a clear
// error instead of a generic "no BUY button" timeout.
function isBookingWindowErrorText(text) {
  if (!text) return false;
  return /missed the booking window/i.test(text) ||
         /booking window.*(not|isn'?t)\s+open/i.test(text) ||
         /booking.*not.*available/i.test(text);
}

// Mindbody redirects to these URL shapes when the session has expired or the
// booking endpoint requires re-auth. Used to fail fast with a clear message
// instead of waiting 30s for a BUY button that will never appear.
function isLoginRedirectUrl(url) {
  if (!url) return false;
  return /\/login\b/i.test(url) ||
         /\/signin\b/i.test(url) ||
         /\/authorize\b/i.test(url) ||
         /screen=login/i.test(url);
}

// After clicking BUY, Mindbody temporarily relabels the button to "PURCHASING"
// (greyed out, click disabled) for ~5-10s while the server processes the order.
// The 2026-04-27 failure was treating "BUY missing" as success — but PURCHASING
// also has no BUY text. Use this classifier to distinguish:
//   - 'pending' = transaction in flight (PURCHASING/PROCESSING/etc) → keep waiting
//   - 'buy'     = BUY visible (didn't click yet, OR re-rendered after error/success)
//   - 'settled' = neither — checkout closed or page navigated
function classifyCheckoutButton(buttonText) {
  if (!buttonText) return 'absent';
  const t = buttonText.trim();
  if (/^BUY$/i.test(t)) return 'buy';
  if (/^(PURCHASING|PROCESSING|LOADING|PLEASE WAIT|SUBMITTING|BUYING)$/i.test(t)) return 'pending';
  return 'other';
}

// Aggregate state across all visible button texts. Returns a summary used by
// waitForBuyOutcome to decide whether to wait or call the checkout settled.
function classifyButtonStates(buttonTexts) {
  const arr = Array.isArray(buttonTexts) ? buttonTexts : [];
  let buy = false, pending = false;
  for (const t of arr) {
    const c = classifyCheckoutButton(t);
    if (c === 'buy') buy = true;
    if (c === 'pending') pending = true;
  }
  if (pending) return 'pending';   // highest priority — transaction in flight
  if (buy)     return 'buy';       // BUY available — not done
  return 'settled';                 // neither BUY nor PURCHASING — checkout closed
}

// Convert a "8:30am" / "12:30pm" / "1:00pm" string to a "HH:MM" 24h string.
// Used by the API-direct path to match Mindbody's UTC startTime against our
// SGT-local target time.
function timeToHHMM(t) {
  if (!t || typeof t !== 'string') throw new Error(`bad time: ${t}`);
  const m = t.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) throw new Error(`bad time: ${t}`);
  let h = parseInt(m[1], 10);
  const ap = m[3].toLowerCase();
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h < 0 || h > 23) throw new Error(`hour out of range: ${t}`);
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

// Match a Mindbody schedule entry against (kind, sgtDate, sgtHHMM). Returns
// true if courseName contains kindNeedle (case-insensitive) and startTime is
// within 60s of the target SGT moment. Pure function for testing the matcher
// independently of the network layer in api-client.
function matchesScheduleEntry(entry, { kindNeedle, sgtDate, sgtHHMM }) {
  if (!entry || !entry.startTime || !entry.courseName) return false;
  if (!entry.courseName.toLowerCase().includes(kindNeedle.toLowerCase())) return false;
  const targetMs = new Date(`${sgtDate}T${sgtHHMM}:00+08:00`).getTime();
  const t = new Date(entry.startTime).getTime();
  return Math.abs(t - targetMs) < 60_000;
}

// Parse a single booking card's flat text from /explore/account/schedule into
// { date, ymd, kind, time, raw }. Returns null if any field can't be extracted.
// Format observed 2026-04-27:
//   "28 Tuesday April, 2026 CROSSFIT® FIT RagTag Training w/ Sam Chappie 6:30am (60 min) Cancel +CALENDAR"
const _MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
function parseBookingCard(text) {
  if (!text || typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ');
  const dayM = flat.match(/\b(\d{1,2})\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i);
  const monthM = flat.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*,?\s+(\d{4})/i);
  const timeM = flat.match(/\b(\d{1,2}:\d{2})\s*(am|pm)\b/i);
  const kind = /CROSSFIT®\s*FIT\b/i.test(flat) ? 'FIT'
             : /CROSSFIT®\s*Gymnastics\b/i.test(flat) ? 'Gymnastics'
             : /CROSSFIT®\s*Lift\b/i.test(flat) ? 'Lift'
             : /\bBurn\b/i.test(flat) ? 'BURN'
             : /Open Gym/i.test(flat) ? 'Open Gym'
             : /\bSteam\b/i.test(flat) ? 'Steam'
             : null;
  if (!dayM || !monthM || !timeM || !kind) return null;
  const dom = parseInt(dayM[1], 10);
  const mon = _MONTHS[monthM[1].toLowerCase().slice(0, 3)];
  const yr = parseInt(monthM[2], 10);
  const date = new Date(yr, mon, dom);
  return { date, ymd: ymd(date), kind, time: `${timeM[1]}${timeM[2].toLowerCase()}`, raw: flat };
}

// Check whether a target booking (date + kind + time) appears in an
// /account/schedule "upcoming" list. Pure function so book.js's verify-don't-trust
// path and the 5c processing_requested path share one tested matcher.
function isBookingInUpcoming(upcoming, { targetYmd, kind, time }) {
  if (!Array.isArray(upcoming)) return false;
  return upcoming.some(b => b && b.ymd === targetYmd && b.kind === kind && b.time === time);
}

// True when api-direct booking_items failed with the Mindbody/Ragtag inventory
// row INSERT race: parallel requests targeting the same class collide on the
// `index_inventory_item_references_on_source_reference` unique index. On a
// retry the row exists, the INSERT path is skipped, and the booking proceeds
// normally (so long as the class still has a spot). Cheap to retry — the
// alternative is a 30+s UI fallback that loses the spot anyway.
function isInventoryRowRace(result) {
  if (!result || result.ok) return false;
  if (result.step !== 'booking_items') return false;
  const body = String(result.body || '');
  return /RecordNotUnique|UniqueViolation/i.test(body);
}

// ── Resilience helpers (2026-06-06 mass-failure incident) ───────────────────
// At 08:57 all 5 users died on the first page.goto: 5 parallel Chromium
// cold-starts thrashed the Mac Mini (~58s just to launch the browser), then the
// nav itself timed out at 30s. With the run firing only ~160s before the 09:00
// sprint, the setup-retry was skipped (71s left < 75s margin) and everyone
// missed. These three pure helpers encode the fix and are unit-tested.

// Stagger N parallel child spawns so their Chromium cold-starts don't collide.
// Linear step, capped. Each child independently busy-waits to 09:00:00.000, so
// spreading setup out costs nothing at booking time.
function spawnStaggerMs(index, stepMs = 1500, capMs = 12000) {
  if (!(index > 0)) return 0;
  return Math.min(Math.round(index * stepMs), capMs);
}

// Decide the navigation retry budget given ms remaining to the 9am sprint.
// One monolithic 30s goto turns a 2-second blip into a total miss; several
// short attempts absorb it. When time is tight we shrink to fail fast so the
// caller can still alert before 09:00. noWait (manual --now / tests) has no
// deadline, so use the full budget.
function navRetryPlan(msRemaining, { noWait = false, perAttemptMs = 15000, maxAttempts = 3, backoffMs = 1000, reserveMs = 8000 } = {}) {
  if (noWait || msRemaining == null) return { attempts: maxAttempts, perAttemptMs, backoffMs };
  const usable = Math.max(0, msRemaining - reserveMs);
  const fit = Math.floor(usable / perAttemptMs);
  const attempts = Math.max(1, Math.min(maxAttempts, fit));
  return { attempts, perAttemptMs, backoffMs };
}

// Whether the outer setup loop (relaunch browser + fresh login, ~60s) should
// retry after a setup failure. noWait has no deadline. Otherwise we need enough
// headroom (marginMs) to redo setup AND still book before 09:00 — below that we
// fail fast so Yash gets alerted instead of a silent miss past the deadline.
function canRetrySetup({ attempt, maxAttempts, msRemaining, marginMs = 75000, noWait = false }) {
  if (attempt >= maxAttempts) return false;
  return noWait || msRemaining > marginMs;
}

module.exports = {
  isInventoryRowRace,
  spawnStaggerMs,
  navRetryPlan,
  canRetrySetup,
  DAY_SHORT,
  addDays,
  ymd,
  classPlan,
  normalize,
  rowMatches,
  rowStatus,
  decideNextAction,
  isBookingWindowErrorText,
  isLoginRedirectUrl,
  classifyCheckoutButton,
  classifyButtonStates,
  parseBookingCard,
  timeToHHMM,
  matchesScheduleEntry,
  resolveSchedule,
  resolveSchedulePlans,
  loadOverrides,
  resolveBookingForDate,
  resolveBookingsForDate,
  isBookingInUpcoming,
};

// ── Login-button protection (2026-05-12 incident) ───────────────────────────
// Constants and pure helpers used by book.js's ensureLoginUnblocked and
// tgYashAlert. Exported here so test.js can exercise them against a fake DOM
// and a synthetic context without spinning up Playwright.

const LOGIN_BUTTON_SEL = 'button[data-name="NavigationBar.Login.Button"]';

// Ordered list of dismiss selectors. Tries each per probe iteration. Adding a
// new overlay pattern (newsletter modal, GDPR variant, promo banner) is one
// line. Specific cookie-banner texts FIRST so we don't miss-click a generic
// "OK" before the real banner has loaded.
const OVERLAY_DISMISS_SELS = [
  'button:has-text("AGREE AND PROCEED")',
  'button:has-text("Accept all")',
  'button:has-text("Accept")',
  'button:has-text("I Agree")',
  '#onetrust-accept-btn-handler',
  'button[aria-label="Close"]',
  'button[aria-label="close"]',
  '[role="dialog"] button:has-text("Got it")',
  '[role="dialog"] button:has-text("Dismiss")',
  '[role="dialog"] button:has-text("Close")',
  '[role="dialog"] button:has-text("OK")',
];

const YASH_ALERT_CHAT_ID = 166637821;

// Z-stack probe. References `document` as a global so the SAME function runs:
//   - in the browser via Playwright page.evaluate (document = real DOM)
//   - in Node tests via probeLoginButton (doc is shimmed onto globalThis)
// State semantics:
//   no-button  — selector matched nothing (probably already logged in)
//   invisible  — element exists, 0×0 box (still rendering or display:none)
//   no-topmost — elementFromPoint returned null (off-screen or torn down)
//   covered    — something is on top of the button, blocker descriptor returned
//   clear      — button (or its ancestor/descendant) is on top → safe to click
function probeLoginButtonInBrowser(selector) {
  const btn = document.querySelector(selector);
  if (!btn) return { state: 'no-button' };
  const r = btn.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { state: 'invisible' };
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const top = document.elementFromPoint(cx, cy);
  if (!top) return { state: 'no-topmost' };
  if (top === btn || btn.contains(top) || top.contains(btn)) return { state: 'clear' };
  const tag = top.tagName.toLowerCase();
  const id = top.id ? '#' + top.id : '';
  const cls = (top.className || '').toString().trim().split(/\s+/).slice(0, 2).filter(Boolean).map(c => '.' + c).join('');
  return { state: 'covered', blocker: (tag + id + cls).slice(0, 80) };
}

// Node wrapper: shims `globalThis.document` so probeLoginButtonInBrowser can
// run unmodified in Node tests. Restores the previous value in finally so
// concurrent tests don't leak.
function probeLoginButton(doc, selector) {
  const saved = globalThis.document;
  globalThis.document = doc;
  try {
    return probeLoginButtonInBrowser(selector);
  } finally {
    globalThis.document = saved;
  }
}

// Build the high-priority Yash alert text on setup failure. Pure string
// builder so test.js can pin every branch. msToNine is signed: positive means
// 9am SGT hasn't hit yet (booker still has time for manual override);
// negative means we're past 9am (urgent).
function buildSetupFailureAlert({ userLabel, planLine, dayLabel, errorMessage, runId, msToNine }) {
  const minsToNine = Math.max(0, Math.round((msToNine || 0) / 60000));
  return (
    '🚨 BOOKER SETUP FAILED\n' +
    `user: ${userLabel}\n` +
    `target: ${planLine} on ${dayLabel}\n` +
    `error: ${(errorMessage || '').slice(0, 240)}\n` +
    `run: ${runId}\n` +
    (minsToNine > 0
      ? `${minsToNine}min until 9am SGT — manual override possible`
      : '9am window already open — book manually NOW')
  );
}

// Daily roll-up sent to Yash after book-all.js finishes all parallel runs.
// One message per day, every day — successes AND failures so Yash has a
// single ground-truth source on the day's bookings. Setup-failure alerts
// still fire IMMEDIATELY (pre-9am, actionable); this summary lands a couple
// minutes later with the full picture.
//
// `runs` is an array of { user, results, setupErrored, dayLabel } where:
//   user: { id, label }
//   results: [{ plan, status }] (status.ok bool, status.reason/detail/time)
//   setupErrored: bool — true if setup blew up (already alerted on)
//   dayLabel: 'Thu 2026-05-14' (target booking day)
function buildDailySummary({ runs, runId, dayLabel }) {
  // A "skipped" run is an intentional opt-out (no DOW class, date_skip, or paused).
  // It carries skipReason + empty results, and should NOT count as a failure
  // toward the overall header — Melissa/Geraldine/Cheryl on Sun is success, not 🚨.
  const isSkipped = (r) => !!r.skipReason && !r.setupErrored;
  const activeRuns = runs.filter(r => !isSkipped(r));
  const allOk = activeRuns.every(r => !r.setupErrored && r.results.every(p => p.status.ok));
  const allFailed = activeRuns.length > 0
    && activeRuns.every(r => r.setupErrored || r.results.every(p => !p.status.ok));
  let header;
  if (activeRuns.length === 0) header = '✅ BOOKER DAILY — no bookings scheduled today';
  else if (allOk) header = '✅ BOOKER DAILY — all bookings landed';
  else if (allFailed) header = '🚨 BOOKER DAILY — every user failed';
  else header = '⚠️ BOOKER DAILY — partial';

  const lines = [header, `day: ${dayLabel}`, `users: ${runs.length}`, ''];

  const fmtPlanLine = (r) => {
    const time = r.status.time || r.plan.primaryTime;
    if (r.status.ok) {
      if (r.status.reason === 'already_booked') return `   ↪ ${r.plan.kind} @ ${time} (already booked)`;
      return `   ✅ ${r.plan.kind} @ ${time}`;
    }
    const reason = (r.status.reason || 'unknown').slice(0, 40);
    const detail = (r.status.detail || '').replace(/\s+/g, ' ').slice(0, 80);
    return `   ❌ ${r.plan.kind} @ ${time} — ${reason}${detail ? `: ${detail}` : ''}`;
  };

  const fmtSkipLine = (run) => {
    const label = run.user.label || run.user.id;
    const detail = (run.skipDetail || '').replace(/\s+/g, ' ').slice(0, 80);
    if (run.skipReason === 'opt_out_day') return `✅ ${label} — no class scheduled`;
    if (run.skipReason === 'date_skip')   return `↪ ${label} — date skipped${detail ? ` (${detail})` : ''}`;
    if (run.skipReason === 'paused')      return `⏸️ ${label} — ${detail || 'paused'}`;
    return `↪ ${label} — ${run.skipReason}${detail ? ` (${detail})` : ''}`;
  };

  for (const run of runs) {
    if (isSkipped(run)) { lines.push(fmtSkipLine(run)); continue; }
    const label = run.user.label || run.user.id;
    const okCount = run.results.filter(p => p.status.ok).length;
    const total = run.results.length;
    let userHeader;
    if (run.setupErrored) userHeader = `🚨 ${label} — setup failed (alerted)`;
    else if (okCount === total) userHeader = `✅ ${label} (${okCount}/${total})`;
    else if (okCount === 0)     userHeader = `❌ ${label} (0/${total})`;
    else                        userHeader = `⚠️ ${label} (${okCount}/${total})`;
    lines.push(userHeader);
    for (const r of run.results) lines.push(fmtPlanLine(r));
  }

  lines.push('', `run: ${runId}`);
  return lines.join('\n');
}

// Single HTTP send-path to Yash's personal Telegram chat. Used by both
// book.js (setup-failure alert, per-child) and book-all.js (daily summary,
// orchestrator). Returns true on 200, false on any failure — failures log to
// stderr but never throw, so a Telegram outage can't take down the booker.
async function sendYashAlert(text, { fetchImpl = (typeof fetch !== 'undefined' ? fetch : null), env = process.env, logger = (m) => process.stderr.write(`alert: ${m}\n`) } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) { logger('no TELEGRAM_BOT_TOKEN — alert dropped'); return false; }
  if (!fetchImpl) { logger('no fetch impl — alert dropped'); return false; }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: YASH_ALERT_CHAT_ID, text, disable_web_page_preview: true }),
    });
    if (r.ok) return true;
    logger(`HTTP ${r.status}: ${typeof r.text === 'function' ? await r.text() : ''}`);
    return false;
  } catch (e) { logger(`ERR ${e.message}`); return false; }
}

// Generic single-message send to ANY chat id. Same fail-soft contract as
// sendYashAlert (false on any failure, never throws). Used by book-all.js to DM
// an auto-enrolled user their own failure reason + watchlist note.
async function sendTelegram(chatId, text, { fetchImpl = (typeof fetch !== 'undefined' ? fetch : null), env = process.env, logger = (m) => process.stderr.write(`tg: ${m}\n`) } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token || !fetchImpl || !chatId) { logger('missing token/fetch/chatId — send dropped'); return false; }
  try {
    const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text, disable_web_page_preview: true }),
    });
    if (r.ok) return true;
    logger(`HTTP ${r.status}`);
    return false;
  } catch (e) { logger(`ERR ${e.message}`); return false; }
}

Object.assign(module.exports, {
  LOGIN_BUTTON_SEL,
  OVERLAY_DISMISS_SELS,
  YASH_ALERT_CHAT_ID,
  probeLoginButtonInBrowser,
  probeLoginButton,
  buildSetupFailureAlert,
  buildDailySummary,
  sendYashAlert,
  sendTelegram,
});

// ── Failure diagnosis + auto-enroll into the waitlist watcher ────────────────
// When the daily booker fails for a user, book-all.js asks classifyBookingFailure
// what went wrong and whether it's worth auto-arming the waitlist watcher for
// that person. Pure (status in → verdict out) so it's fully unit-testable; the
// 2026-06-07 Geraldine miss surfaced as `exception: could not click
// Classes/Schedule tab` (an api-direct pass-fetch miss masked by a fragile
// pre-window UI fallback), which lands in the `infra` bucket → autoWatch.
//
// status = { ok, reason, detail, time }. We read BOTH reason and detail because
// FULL arrives as detail ("FIT FULL (primary and fallback)") off a thrown error
// whose reason is the generic "exception".
function classifyBookingFailure(status) {
  if (status && status.ok) return { category: 'ok', cause: 'booked', autoWatch: false };
  const reason = String((status && status.reason) || '').toLowerCase();
  const detail = String((status && status.detail) || '').toLowerCase();
  const blob = `${reason} ${detail}`;

  // Class full / waitlist-only — lost the 09:00 race. A cancellation may free a
  // slot, which is exactly what the watcher is for.
  if (/\bfull\b|max capacity|on waitlist|waitlist required|waitlist — manual/.test(blob)) {
    return { category: 'full', cause: 'Class was full by 09:00 (lost the booking race).', autoWatch: true };
  }
  // No eligible pass at booking time. Either a pre-window timing artifact (the
  // eligible-pass list had not populated when we fetched it pre-09:00) or the
  // user is low on class credits. Watch either way; the DM hints to check passes.
  if (reason === 'pass-fetch-failed' || /no eligible pass/.test(blob)) {
    return { category: 'no_pass', cause: 'No eligible class pass at booking time (pre-window timing, or low on class credits).', autoWatch: true };
  }
  // Class never appeared on the schedule — nothing for a watcher to poll.
  if (reason === 'class-not-found' || /not in schedule|row disappeared|no .* row found/.test(blob)) {
    return { category: 'not_found', cause: 'Target class was not on the schedule.', autoWatch: false };
  }
  // Login / token capture failed — the watcher shares the same auth and would
  // hit the same wall, so route to a fix rather than a watch.
  if (/\bauth\b|login|bearer-capture|logged out|sign in/.test(blob)) {
    return { category: 'auth', cause: 'Login/auth failed before booking could run.', autoWatch: false };
  }
  // Everything else: the automation broke (tab-click, pipeline, timeout,
  // unverified, generic exception, no-result-file). The class may well have
  // been bookable, so arm a watch as a safety net — if the user actually did
  // get in, the watcher detects the existing booking and self-unloads.
  const shortDetail = String((status && status.detail) || (status && status.reason) || 'unknown')
    .replace(/\s+/g, ' ').trim().slice(0, 120);
  return { category: 'infra', cause: `Booking automation error: ${shortDetail}`, autoWatch: true };
}

// ── Waitlist watch registry (pure helpers) ──────────────────────────────────
// The registry is a JSON file ({ updated, watches: [...] }); waitlist-registry.js
// fans waitlist-watch.js out over each active entry, mirroring how book-all.js
// fans book.js out. These helpers operate on the bare `watches` array so they
// stay pure and testable. Entry shape:
//   { user, name, date, time, kind, chatIds, source, reason, addedAt }
function parseClockToMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(String(t || '').trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  const ap = m[3].toLowerCase();
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h * 60 + mins;
}

// SGT class-start epoch ms. Built from an explicit +08:00 offset so it is
// timezone-independent (works the same on the SGT Mac Mini and in CI).
function classStartMs(date, time) {
  const mins = parseClockToMinutes(time);
  if (mins == null || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  const t = new Date(`${date}T${hh}:${mm}:00+08:00`).getTime();
  return Number.isNaN(t) ? null : t;
}

// Dedupe key: one watch per (user, date, time, kind), normalized.
function watchRegistryKey(w) {
  return [
    String((w && w.user) || '').toLowerCase(),
    String((w && w.date) || ''),
    String((w && w.time) || '').replace(/\s+/g, '').toLowerCase(),
    String((w && w.kind) || '').toUpperCase(),
  ].join('|');
}

// Add or refresh an entry. Returns a NEW array (does not mutate). Re-enrolling
// the same slot replaces the prior entry (so addedAt/reason/chatIds refresh)
// rather than duplicating it.
function upsertWatch(watches, entry) {
  const key = watchRegistryKey(entry);
  const out = (watches || []).filter(w => watchRegistryKey(w) !== key);
  out.push(entry);
  return out;
}

// Drop entries whose class has already started (or are malformed). nowMs is the
// current epoch ms. Returns a NEW array.
function pruneWatchRegistry(watches, nowMs) {
  return (watches || []).filter(w => {
    const startMs = classStartMs(w && w.date, w && w.time);
    if (startMs == null) return false;
    return startMs > nowMs;
  });
}

// Turn the daily booker's per-user run results into watch-registry entries for
// every failed plan that classifyBookingFailure says is worth watching, skipping
// classes that have already started. Pure: nowMs / nowIso / yashChatId are
// injected so book-all stays thin and this is unit-testable.
//   runs: [{ id, user:{label}, targetYmd, results:[{plan,status}] }]
function buildWatchCandidates(runs, { usersById = {}, nowMs = null, yashChatId = null, nowIso = null } = {}) {
  const out = [];
  for (const run of runs || []) {
    if (!run || !run.targetYmd || !Array.isArray(run.results)) continue;
    for (const res of run.results) {
      const status = (res && res.status) || {};
      if (status.ok) continue;
      const verdict = classifyBookingFailure(status);
      if (!verdict.autoWatch) continue;
      const time = (res.plan && res.plan.primaryTime) || status.time;
      const kind = res.plan && res.plan.kind;
      if (!time || !kind) continue;
      const startMs = classStartMs(run.targetYmd, time);
      if (startMs == null || (nowMs != null && startMs <= nowMs)) continue;
      const u = usersById[run.id] || {};
      const userChatId = u.telegramChatId ? String(u.telegramChatId) : null;
      const chatIds = [...new Set([u.telegramChatId, yashChatId].filter(Boolean).map(String))];
      out.push({
        user: run.id,
        name: (run.user && run.user.label) || u.label || run.id,
        date: run.targetYmd,
        time,
        kind,
        userChatId,
        chatIds: chatIds.join(','),
        source: 'auto-enroll',
        reason: verdict.category,
        cause: verdict.cause,
        addedAt: nowIso,
      });
    }
  }
  return out;
}

// ── Pre-window pass-fetch recovery (Geraldine root-cause fix, 2026-06-07) ────
// api-direct pre-fetches the payment pass BEFORE the 09:00 booking window opens.
// On 2026-06-07 Geraldine's eligible-pass list was empty at 08:59 ("Outside
// booking window") while Dani's populated, so her api-direct bailed with
// `pass-fetch-failed` and fell into a fragile pre-window UI flow that then threw
// on the schedule tab. The window opens at 09:00 regardless, so the right move
// when the pass-fetch misses pre-window is to WAIT for the window and retry the
// fetch once (the list usually populates), rather than abandon the fast path.
// Pure so book.js can unit-test the decision without Playwright/clock.
function shouldRetryPassFetchPreWindow(passResult, msToNine, waitEnabled) {
  if (!waitEnabled) return false;
  if (!passResult || passResult.reason !== 'pass-fetch-failed') return false;
  return msToNine > 0;
}

Object.assign(module.exports, {
  classifyBookingFailure,
  parseClockToMinutes,
  classStartMs,
  watchRegistryKey,
  upsertWatch,
  pruneWatchRegistry,
  buildWatchCandidates,
  shouldRetryPassFetchPreWindow,
});
