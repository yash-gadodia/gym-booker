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

function normalize(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

function rowMatches(text, { kind, time }) {
  const t = normalize(text);
  if (kind === 'FIT' && !/CROSSFIT® FIT\b/i.test(t)) return false;
  if (kind === 'Gymnastics' && !/CROSSFIT® Gymnastics\b/i.test(t)) return false;
  const [hhmm, ap] = time.split(/(am|pm)/i);
  const timeRe = new RegExp(`${hhmm.trim().replace(':','\\:')}\\s*${ap}`, 'i');
  return timeRe.test(t);
}

function rowStatus(text) {
  if (/\bBOOKED\b/i.test(text)) return 'BOOKED';
  if (/\bFULL\b/i.test(text)) return 'FULL';
  if (/BOOK NOW/i.test(text)) return 'BOOK_NOW';
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
};
