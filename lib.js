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
      const dowDefault = classPlan(targetDate);
      return {
        kind: entry.kind || dowDefault.kind,
        primaryTime: entry.time || dowDefault.primaryTime,
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
      const dowDefault = classPlan(targetDate);
      return {
        plans: [{
          kind: entry.kind || dowDefault.kind,
          primaryTime: entry.time || dowDefault.primaryTime,
          fallback: null,
        }],
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
             : null;
  if (!dayM || !monthM || !timeM || !kind) return null;
  const dom = parseInt(dayM[1], 10);
  const mon = _MONTHS[monthM[1].toLowerCase().slice(0, 3)];
  const yr = parseInt(monthM[2], 10);
  const date = new Date(yr, mon, dom);
  return { date, ymd: ymd(date), kind, time: `${timeM[1]}${timeM[2].toLowerCase()}`, raw: flat };
}

module.exports = {
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
};
