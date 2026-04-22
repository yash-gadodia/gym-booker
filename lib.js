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

module.exports = { DAY_SHORT, addDays, ymd, classPlan, normalize, rowMatches, rowStatus };
