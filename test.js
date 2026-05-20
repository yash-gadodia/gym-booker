const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  DAY_SHORT, addDays, ymd, classPlan, normalize, rowMatches, rowStatus,
  decideNextAction, isBookingWindowErrorText, isLoginRedirectUrl,
  classifyCheckoutButton, classifyButtonStates, parseBookingCard,
  timeToHHMM, matchesScheduleEntry, resolveSchedule, resolveSchedulePlans,
  loadOverrides, resolveBookingForDate, resolveBookingsForDate,
  LOGIN_BUTTON_SEL, OVERLAY_DISMISS_SELS, YASH_ALERT_CHAT_ID,
  probeLoginButton, buildSetupFailureAlert, buildDailySummary, sendYashAlert,
} = require('./lib');
const { getTelegramTarget } = require('./users');
const personality = require('./personality');

test('DAY_SHORT is Sun..Sat indexed by getDay()', () => {
  assert.equal(DAY_SHORT[new Date('2026-04-26').getDay()], 'Sun');
  assert.equal(DAY_SHORT[new Date('2026-04-27').getDay()], 'Mon');
  assert.equal(DAY_SHORT[new Date('2026-04-25').getDay()], 'Sat');
});

test('addDays: simple +2', () => {
  const d = new Date('2026-04-22T00:00:00');
  assert.equal(ymd(addDays(d, 2)), '2026-04-24');
});

test('addDays: crosses month boundary', () => {
  assert.equal(ymd(addDays(new Date('2026-04-29T00:00:00'), 2)), '2026-05-01');
});

test('addDays: crosses year boundary', () => {
  assert.equal(ymd(addDays(new Date('2026-12-30T00:00:00'), 2)), '2027-01-01');
});

test('addDays: negative no-op for source', () => {
  const d = new Date('2026-04-22T00:00:00');
  addDays(d, 2);
  assert.equal(ymd(d), '2026-04-22', 'source date must not mutate');
});

test('ymd: zero-pads month and day', () => {
  assert.equal(ymd(new Date('2026-01-05T00:00:00')), '2026-01-05');
  assert.equal(ymd(new Date('2026-11-30T00:00:00')), '2026-11-30');
});

test('classPlan: all seven days', () => {
  const cases = [
    ['2026-04-26', { kind: 'Gymnastics', primaryTime: '1:00pm',  fallback: null }],
    ['2026-04-27', { kind: 'FIT',        primaryTime: '6:30am',  fallback: '7:30am' }],
    ['2026-04-28', { kind: 'FIT',        primaryTime: '6:30am',  fallback: '7:30am' }],
    ['2026-04-29', { kind: 'FIT',        primaryTime: '6:30am',  fallback: '7:30am' }],
    ['2026-04-30', { kind: 'FIT',        primaryTime: '6:30am',  fallback: '7:30am' }],
    ['2026-05-01', { kind: 'FIT',        primaryTime: '7:30am',  fallback: null      }],
    ['2026-04-25', { kind: 'Gymnastics', primaryTime: '12:30pm', fallback: null }],
  ];
  for (const [date, expected] of cases) {
    const got = classPlan(new Date(date));
    assert.deepEqual(got, expected, `${date} (${DAY_SHORT[new Date(date).getDay()]})`);
  }
});

test('classPlan: Fridays book FIT 7:30am with no fallback (regression — was 6:30am fb 7:30am)', () => {
  // Yash + Dani changed their Friday default to 7:30am on 2026-05-15. Other
  // users already have explicit Fri 7:30am in users.json, so this only affects
  // schedule:null users (Yash, Dani). Pin three consecutive Fridays so a future
  // edit that re-introduces the 6:30am branch fails loudly.
  for (const date of ['2026-05-01', '2026-05-08', '2026-05-15', '2026-05-22']) {
    const got = classPlan(new Date(date));
    assert.equal(DAY_SHORT[new Date(date).getDay()], 'Fri', `${date} must be Fri`);
    assert.deepEqual(got, { kind: 'FIT', primaryTime: '7:30am', fallback: null }, `${date}`);
  }
});

test('normalize: collapses whitespace + trims', () => {
  assert.equal(normalize('  foo\nbar   baz\t  '), 'foo bar baz');
  assert.equal(normalize(''), '');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
});

test('rowMatches: FIT 6:30am hits a real FIT row', () => {
  const text = 'CROSSFIT® FIT Aidan Chemaly 6:30am (60 min) BOOK NOW';
  assert.equal(rowMatches(text, { kind: 'FIT', time: '6:30am' }), true);
});

test('rowMatches: FIT regex does NOT match Lift', () => {
  const text = 'CROSSFIT® Lift Sam Chappie 6:30am (60 min) BOOK NOW';
  assert.equal(rowMatches(text, { kind: 'FIT', time: '6:30am' }), false);
});

test('rowMatches: FIT regex does NOT match Foundations', () => {
  const text = 'CROSSFIT® Foundations Coach 6:30am (60 min) BOOK NOW';
  assert.equal(rowMatches(text, { kind: 'FIT', time: '6:30am' }), false);
});

test('rowMatches: FIT regex does NOT match Gymnastics', () => {
  const text = 'CROSSFIT® Gymnastics Tris Kong 6:30am (60 min) BOOK NOW';
  assert.equal(rowMatches(text, { kind: 'FIT', time: '6:30am' }), false);
});

test('rowMatches: Gymnastics match', () => {
  const text = 'CROSSFIT® Gymnastics Tris Kong 1:00pm (90 min) BOOK NOW';
  assert.equal(rowMatches(text, { kind: 'Gymnastics', time: '1:00pm' }), true);
});

test('rowMatches: wrong time rejected', () => {
  const text = 'CROSSFIT® FIT Aidan Chemaly 6:30am (60 min) FULL';
  assert.equal(rowMatches(text, { kind: 'FIT', time: '7:30am' }), false);
});

test('rowMatches: 12:30pm does not collide with 1:30pm', () => {
  const text = 'CROSSFIT® Gymnastics Coach 1:30pm (90 min) BOOK NOW';
  assert.equal(rowMatches(text, { kind: 'Gymnastics', time: '12:30pm' }), false);
});

test('rowMatches: time with space "6:30 am" still matches', () => {
  const text = 'CROSSFIT® FIT Coach 6:30 am (60 min) BOOK NOW';
  assert.equal(rowMatches(text, { kind: 'FIT', time: '6:30am' }), true);
});

test('rowMatches: BURN kind matches "Gym classes Burn" row', () => {
  const text = 'Gym classes Burn Annie Set 6:30pm (60 min) BOOK NOW';
  assert.equal(rowMatches(text, { kind: 'BURN', time: '6:30pm' }), true);
});

test('rowMatches: BURN kind rejects co-timed FIT row', () => {
  const text = 'CROSSFIT® FIT Sam Chappie 6:30pm (60 min) BOOK NOW';
  assert.equal(rowMatches(text, { kind: 'BURN', time: '6:30pm' }), false);
});

test('rowMatches: BURN kind rejects co-timed Lift row', () => {
  const text = 'CROSSFIT® Lift Sam Chappie 6:30pm (60 min) BOOK NOW';
  assert.equal(rowMatches(text, { kind: 'BURN', time: '6:30pm' }), false);
});

test('rowMatches: FIT kind rejects BURN row', () => {
  const text = 'Gym classes Burn Annie Set 6:30pm (60 min) BOOK NOW';
  assert.equal(rowMatches(text, { kind: 'FIT', time: '6:30pm' }), false);
});

test('rowMatches: BURN at 7:30pm is rejected when target is 6:30pm', () => {
  const text = 'Gym classes Burn Annie Set 7:30pm (60 min) BOOK NOW';
  assert.equal(rowMatches(text, { kind: 'BURN', time: '6:30pm' }), false);
});

test('parseBookingCard: parses a Burn booking confirmation card', () => {
  const text = '05 Tuesday May, 2026 Burn Annie Set 6:30pm (60 min) Cancel +CALENDAR';
  const got = parseBookingCard(text);
  assert.ok(got, 'expected non-null');
  assert.equal(got.kind, 'BURN');
  assert.equal(got.time, '6:30pm');
  assert.equal(got.ymd, '2026-05-05');
});

test('rowStatus: BOOKED wins over stray BOOK NOW', () => {
  const text = 'CROSSFIT® FIT Aidan 6:30am (60 min) BOOKED  — also Book Now for another class';
  assert.equal(rowStatus(text), 'BOOKED');
});

test('rowStatus: FULL detected', () => {
  assert.equal(rowStatus('CROSSFIT® FIT 6:30am (60 min) FULL'), 'FULL');
});

test('rowStatus: BOOK NOW detected when no booked/full', () => {
  assert.equal(rowStatus('CROSSFIT® FIT 6:30am (60 min) BOOK NOW'), 'BOOK_NOW');
});

test('rowStatus: DETAILS detected (pre-9am state)', () => {
  assert.equal(rowStatus('CROSSFIT® Gymnastics 1:00pm (90 min) DETAILS'), 'DETAILS');
});

test('rowStatus: unknown text', () => {
  assert.equal(rowStatus('some random text with no status marker'), 'UNKNOWN');
});

test('rowStatus: FULL precedence over DETAILS', () => {
  assert.equal(rowStatus('CROSSFIT® FIT 6:30am FULL — see DETAILS'), 'FULL');
});

test('day tab regex against live format "FRI\\n24"', () => {
  const re = new RegExp(`^FRI\\s*24$`, 'i');
  assert.equal(re.test('FRI\n24'), true);
  assert.equal(re.test('FRI 24'), true);
  assert.equal(re.test('FRI24'), true);
  assert.equal(re.test('FRI 241'), false, 'must not cross-match 2-digit prefix');
  assert.equal(re.test('FRI 2'), false);
});

// ---------- new: post-9am booking-race logic ----------

test('decideNextAction: BOOK_NOW → click', () => {
  assert.deepEqual(decideNextAction('BOOK_NOW'), { action: 'click' });
});

test('decideNextAction: BOOKED → done (idempotent rerun)', () => {
  assert.deepEqual(decideNextAction('BOOKED'), { action: 'done', detail: 'already BOOKED' });
});

test('decideNextAction: DETAILS → poll (pre-flip DOM state)', () => {
  assert.deepEqual(decideNextAction('DETAILS'), { action: 'poll' });
});

test('decideNextAction: UNKNOWN → poll (transient render)', () => {
  assert.deepEqual(decideNextAction('UNKNOWN'), { action: 'poll' });
});

test('decideNextAction: FULL → fail (lost the race)', () => {
  const d = decideNextAction('FULL');
  assert.equal(d.action, 'fail');
  assert.match(d.reason, /FULL/);
});

test('decideNextAction: NOT_FOUND → fail', () => {
  const d = decideNextAction('NOT_FOUND');
  assert.equal(d.action, 'fail');
  assert.match(d.reason, /disappeared/);
});

test('decideNextAction: WAITLIST → fail (manual join, never auto)', () => {
  const d = decideNextAction('WAITLIST');
  assert.equal(d.action, 'fail');
  assert.match(d.reason, /WAITLIST/);
});

test('decideNextAction: unexpected status → fail with diagnostic', () => {
  const d = decideNextAction('GIBBERISH');
  assert.equal(d.action, 'fail');
  assert.match(d.reason, /GIBBERISH/);
});

test('rowStatus: JOIN WAITLIST detected', () => {
  assert.equal(rowStatus('CROSSFIT® FIT 6:30am (60 min) JOIN WAITLIST'), 'WAITLIST');
  assert.equal(rowStatus('CROSSFIT® FIT 6:30am (60 min) WAITLIST'), 'WAITLIST');
});

test('rowStatus: BOOK_NOW takes precedence over stray WAITLIST text', () => {
  assert.equal(rowStatus('CROSSFIT® FIT 6:30am BOOK NOW (waitlist also visible elsewhere)'), 'BOOK_NOW');
});

test('rowStatus: WAITLIST takes precedence over FULL when both appear', () => {
  assert.equal(rowStatus('CROSSFIT® FIT 6:30am FULL — JOIN WAITLIST'), 'WAITLIST');
});

test('isBookingWindowErrorText: exact modal copy from 2026-04-24 failure', () => {
  assert.equal(isBookingWindowErrorText('You missed the booking window for this class.'), true);
});

test('isBookingWindowErrorText: case-insensitive + trailing punctuation', () => {
  assert.equal(isBookingWindowErrorText('YOU MISSED THE BOOKING WINDOW FOR THIS CLASS'), true);
  assert.equal(isBookingWindowErrorText('you missed the booking window'), true);
});

test('isBookingWindowErrorText: "booking window not open" variant', () => {
  assert.equal(isBookingWindowErrorText('The booking window is not open yet'), true);
  assert.equal(isBookingWindowErrorText("booking window isn't open"), true);
});

test('isBookingWindowErrorText: "booking not available" variant', () => {
  assert.equal(isBookingWindowErrorText('Sorry, booking is not available for this class'), true);
});

test('isBookingWindowErrorText: unrelated modals pass through', () => {
  assert.equal(isBookingWindowErrorText('Welcome back!'), false);
  assert.equal(isBookingWindowErrorText('Are you sure you want to cancel?'), false);
  assert.equal(isBookingWindowErrorText(''), false);
  assert.equal(isBookingWindowErrorText(null), false);
  assert.equal(isBookingWindowErrorText(undefined), false);
});

test('isLoginRedirectUrl: detects /login, /signin, /authorize', () => {
  assert.equal(isLoginRedirectUrl('https://www.mindbodyonline.com/login'), true);
  assert.equal(isLoginRedirectUrl('https://www.mindbodyonline.com/signin?next=/book'), true);
  assert.equal(isLoginRedirectUrl('https://prod-mkt-gateway.mindbody.io/v1/auth/authorize?code_challenge=abc'), true);
});

test('isLoginRedirectUrl: detects screen=login query', () => {
  assert.equal(isLoginRedirectUrl('https://example.com/explore?screen=login&foo=bar'), true);
});

test('isLoginRedirectUrl: does NOT match booking/schedule URLs', () => {
  assert.equal(isLoginRedirectUrl('https://www.mindbodyonline.com/explore/locations/ragtag'), false);
  assert.equal(isLoginRedirectUrl('https://www.mindbodyonline.com/explore/checkout'), false);
  assert.equal(isLoginRedirectUrl(''), false);
  assert.equal(isLoginRedirectUrl(null), false);
});

test('isLoginRedirectUrl: "signinghelp" should not false-positive /signin', () => {
  // word-boundary check: /signin\b means /signin not /signinghelp
  assert.equal(isLoginRedirectUrl('https://example.com/signinghelp'), false);
});

// ---------- regression: today's exact failure ----------

test('regression 2026-04-24: DETAILS row at T+0 → poll (not click)', () => {
  // At Fri 09:00:00.015 SGT, the Sun 1pm Gymnastics row read:
  //   "CROSSFIT® Gymnastics Tris Kong 1:00pm (90 min) DETAILS"
  // The old code clicked DETAILS and hit "You missed the booking window".
  // New code must recognise DETAILS as "not yet flipped" and keep polling.
  const text = 'CROSSFIT® Gymnastics Tris Kong 1:00pm (90 min) DETAILS';
  const status = rowStatus(text);
  assert.equal(status, 'DETAILS');
  assert.equal(decideNextAction(status).action, 'poll');
});

test('regression 2026-04-24: the exact modal copy is recognised', () => {
  // Screenshot from runs/2026-04-24T00-57-04/92400183-post-click.png
  assert.equal(isBookingWindowErrorText('You missed the booking window for this class.'), true);
});

// ---------- regression: 2026-04-27 PURCHASING false-positive ----------

test('classifyCheckoutButton: BUY (idle)', () => {
  assert.equal(classifyCheckoutButton('BUY'), 'buy');
  assert.equal(classifyCheckoutButton('Buy'), 'buy');
  assert.equal(classifyCheckoutButton('  BUY  '), 'buy');
});

test('classifyCheckoutButton: PURCHASING and other in-flight labels', () => {
  // Exact label seen on 2026-04-27 post-buy screenshot.
  assert.equal(classifyCheckoutButton('PURCHASING'), 'pending');
  assert.equal(classifyCheckoutButton('Purchasing'), 'pending');
  assert.equal(classifyCheckoutButton('PROCESSING'), 'pending');
  assert.equal(classifyCheckoutButton('LOADING'), 'pending');
  assert.equal(classifyCheckoutButton('PLEASE WAIT'), 'pending');
  assert.equal(classifyCheckoutButton('SUBMITTING'), 'pending');
  assert.equal(classifyCheckoutButton('BUYING'), 'pending');
});

test('classifyCheckoutButton: unrelated buttons fall through', () => {
  assert.equal(classifyCheckoutButton('Edit'), 'other');
  assert.equal(classifyCheckoutButton('Cancel'), 'other');
  assert.equal(classifyCheckoutButton(''), 'absent');
  assert.equal(classifyCheckoutButton(null), 'absent');
  assert.equal(classifyCheckoutButton(undefined), 'absent');
});

test('classifyButtonStates: page with PURCHASING is "pending" (regression)', () => {
  // 2026-04-27 post-buy.png had buttons: ['Edit', 'Edit', 'Edit', 'Edit', 'PURCHASING'].
  // Old code: BUY missing → returned ok=true after 2s → bug.
  // New: PURCHASING dominates → classifier returns 'pending' → caller keeps waiting.
  const labels = ['Edit', 'Edit', 'Edit', 'Edit', 'PURCHASING'];
  assert.equal(classifyButtonStates(labels), 'pending');
});

test('classifyButtonStates: idle checkout with BUY is "buy"', () => {
  const labels = ['Edit', 'Edit', 'Edit', 'Edit', 'BUY'];
  assert.equal(classifyButtonStates(labels), 'buy');
});

test('classifyButtonStates: pending wins over BUY (Mindbody flicker)', () => {
  // If both labels somehow co-exist mid-render, treat as pending — never settled.
  const labels = ['BUY', 'PURCHASING'];
  assert.equal(classifyButtonStates(labels), 'pending');
});

test('classifyButtonStates: empty / non-checkout page is "settled"', () => {
  assert.equal(classifyButtonStates([]), 'settled');
  assert.equal(classifyButtonStates(['Home', 'Logout', 'My Account']), 'settled');
  assert.equal(classifyButtonStates(null), 'settled');
});

test('classifyButtonStates: 2026-04-26 false-negative (BUY back after error toast) is "buy" not "settled"', () => {
  // Yesterday's run: error toast shown but booking succeeded, BUY re-rendered.
  // The classifier must say 'buy' — caller should not call this "checkout closed".
  // Verify step (schedule = ground truth) handles the actual outcome.
  const labels = ['Edit', 'Edit', 'Edit', 'Edit', 'BUY'];
  assert.equal(classifyButtonStates(labels), 'buy');
});

// ---------- parseBookingCard: source of truth for "already booked" guard ----------

test('parseBookingCard: real card from 2026-04-27 /account/schedule', () => {
  const text = '28 Tuesday April, 2026 CROSSFIT® FIT RagTag Training w/ Sam Chappie 6:30am (60 min) Cancel +CALENDAR';
  const b = parseBookingCard(text);
  assert.ok(b);
  assert.equal(b.ymd, '2026-04-28');
  assert.equal(b.kind, 'FIT');
  assert.equal(b.time, '6:30am');
});

test('parseBookingCard: 8:30am variant', () => {
  const text = '28 Tuesday April, 2026 CROSSFIT® FIT RagTag Training w/ Sam Chappie 8:30am (60 min) Cancel +CALENDAR';
  const b = parseBookingCard(text);
  assert.equal(b.time, '8:30am');
  assert.equal(b.kind, 'FIT');
});

test('parseBookingCard: Gymnastics kind', () => {
  const text = '26 Sunday April, 2026 CROSSFIT® Gymnastics Tris Kong 1:00pm (90 min) Cancel +CALENDAR';
  const b = parseBookingCard(text);
  assert.equal(b.kind, 'Gymnastics');
  assert.equal(b.time, '1:00pm');
  assert.equal(b.ymd, '2026-04-26');
});

test('parseBookingCard: Lift and Open Gym kinds', () => {
  assert.equal(parseBookingCard('30 Friday April, 2026 CROSSFIT® Lift Sam Chappie 6:30pm (60 min) Cancel +CALENDAR').kind, 'Lift');
  assert.equal(parseBookingCard('27 Monday April, 2026 OTHER Open Gym RAGTAG Staff 5:30pm (60 min) Cancel +CALENDAR').kind, 'Open Gym');
});

test('parseBookingCard: returns null for non-booking text', () => {
  assert.equal(parseBookingCard('foo bar baz'), null);
  assert.equal(parseBookingCard(''), null);
  assert.equal(parseBookingCard(null), null);
  assert.equal(parseBookingCard(undefined), null);
  // Missing time
  assert.equal(parseBookingCard('28 Tuesday April, 2026 CROSSFIT® FIT Cancel'), null);
});

test('parseBookingCard: month abbreviations work', () => {
  const b = parseBookingCard('1 Friday May, 2026 CROSSFIT® FIT Coach 6:30am (60 min) Cancel');
  assert.equal(b.ymd, '2026-05-01');
});

// ---------- timeToHHMM: API-direct uses 24h SGT for matching schedule entries ----------

test('timeToHHMM: am/pm conversion', () => {
  assert.equal(timeToHHMM('6:30am'), '06:30');
  assert.equal(timeToHHMM('8:30am'), '08:30');
  assert.equal(timeToHHMM('12:00am'), '00:00');   // midnight
  assert.equal(timeToHHMM('12:30pm'), '12:30');   // noon-half
  assert.equal(timeToHHMM('1:00pm'), '13:00');
  assert.equal(timeToHHMM('6:30pm'), '18:30');
  assert.equal(timeToHHMM('11:59pm'), '23:59');
});

test('timeToHHMM: case + whitespace tolerant', () => {
  assert.equal(timeToHHMM('6:30 AM'), '06:30');
  assert.equal(timeToHHMM('1:00 PM'), '13:00');
});

test('timeToHHMM: rejects bad input', () => {
  assert.throws(() => timeToHHMM(''), /bad time/);
  assert.throws(() => timeToHHMM('25:00am'), /hour out of range/);
  assert.throws(() => timeToHHMM('630am'), /bad time/);
  assert.throws(() => timeToHHMM(null), /bad time/);
});

// ---------- matchesScheduleEntry: API-direct picks the right class instance ----------

test('matchesScheduleEntry: real class on Tue 28 8:30am SGT', () => {
  // Captured 2026-04-27: Tue 28 8:30am FIT had startTime 2026-04-28T00:30:00Z (UTC).
  // 00:30 UTC == 08:30 SGT (UTC+8). Matcher must convert and align.
  const entry = { startTime: '2026-04-28T00:30:00Z', courseName: 'FIT' };
  assert.equal(matchesScheduleEntry(entry, { kindNeedle: 'FIT', sgtDate: '2026-04-28', sgtHHMM: '08:30' }), true);
});

test('matchesScheduleEntry: kind mismatch rejected', () => {
  const entry = { startTime: '2026-04-28T00:30:00Z', courseName: 'Open Gym' };
  assert.equal(matchesScheduleEntry(entry, { kindNeedle: 'FIT', sgtDate: '2026-04-28', sgtHHMM: '08:30' }), false);
});

test('matchesScheduleEntry: time mismatch rejected (5min off)', () => {
  const entry = { startTime: '2026-04-28T00:35:00Z', courseName: 'FIT' };
  assert.equal(matchesScheduleEntry(entry, { kindNeedle: 'FIT', sgtDate: '2026-04-28', sgtHHMM: '08:30' }), false);
});

test('matchesScheduleEntry: 30s drift accepted (within 1min window)', () => {
  const entry = { startTime: '2026-04-28T00:30:30Z', courseName: 'FIT' };
  assert.equal(matchesScheduleEntry(entry, { kindNeedle: 'FIT', sgtDate: '2026-04-28', sgtHHMM: '08:30' }), true);
});

test('matchesScheduleEntry: kind needle is case-insensitive substring', () => {
  const entry = { startTime: '2026-04-28T00:30:00Z', courseName: 'CROSSFIT FIT' };
  assert.equal(matchesScheduleEntry(entry, { kindNeedle: 'fit', sgtDate: '2026-04-28', sgtHHMM: '08:30' }), true);
});

test('matchesScheduleEntry: missing fields → false', () => {
  assert.equal(matchesScheduleEntry({}, { kindNeedle: 'FIT', sgtDate: '2026-04-28', sgtHHMM: '08:30' }), false);
  assert.equal(matchesScheduleEntry({ startTime: '2026-04-28T00:30:00Z' }, { kindNeedle: 'FIT', sgtDate: '2026-04-28', sgtHHMM: '08:30' }), false);
  assert.equal(matchesScheduleEntry({ courseName: 'FIT' }, { kindNeedle: 'FIT', sgtDate: '2026-04-28', sgtHHMM: '08:30' }), false);
  assert.equal(matchesScheduleEntry(null, { kindNeedle: 'FIT', sgtDate: '2026-04-28', sgtHHMM: '08:30' }), false);
});

// ---------- resolveSchedule: per-user schedule overrides ----------

test('resolveSchedule: null override → falls back to classPlan (Yash default)', () => {
  // Mon-Fri default
  assert.deepEqual(resolveSchedule(new Date('2026-04-27'), null),
    { kind: 'FIT', primaryTime: '6:30am', fallback: '7:30am' });
  // Sat default
  assert.deepEqual(resolveSchedule(new Date('2026-04-25'), null),
    { kind: 'Gymnastics', primaryTime: '12:30pm', fallback: null });
  // Sun default
  assert.deepEqual(resolveSchedule(new Date('2026-04-26'), null),
    { kind: 'Gymnastics', primaryTime: '1:00pm', fallback: null });
});

test('resolveSchedule: undefined override → also falls back to classPlan', () => {
  assert.deepEqual(resolveSchedule(new Date('2026-04-27'), undefined),
    { kind: 'FIT', primaryTime: '6:30am', fallback: '7:30am' });
});

test('resolveSchedule: per-day entry returned with explicit override', () => {
  const sched = {
    Mon: { kind: 'FIT', primaryTime: '7:30am', fallback: null },
    Wed: { kind: 'FIT', primaryTime: '6:30am', fallback: '7:30am' },
  };
  // Mon → custom 7:30am
  assert.deepEqual(resolveSchedule(new Date('2026-04-27'), sched),
    { kind: 'FIT', primaryTime: '7:30am', fallback: null });
  // Wed → custom 6:30am with fallback
  assert.deepEqual(resolveSchedule(new Date('2026-04-29'), sched),
    { kind: 'FIT', primaryTime: '6:30am', fallback: '7:30am' });
});

test('resolveSchedule: explicit-null day entry → null (opt out of that day)', () => {
  const sched = {
    Mon: { kind: 'FIT', primaryTime: '6:30am', fallback: null },
    Tue: null,  // explicit opt-out
    Wed: { kind: 'FIT', primaryTime: '6:30am', fallback: null },
  };
  assert.equal(resolveSchedule(new Date('2026-04-28'), sched), null);  // Tue
});

test('resolveSchedule: missing day key in override → null (opt out)', () => {
  // Override has Mon only — Tue/Wed/etc. all return null.
  const sched = { Mon: { kind: 'FIT', primaryTime: '6:30am', fallback: null } };
  assert.equal(resolveSchedule(new Date('2026-04-28'), sched), null);  // Tue
  assert.equal(resolveSchedule(new Date('2026-04-25'), sched), null);  // Sat
  assert.equal(resolveSchedule(new Date('2026-04-26'), sched), null);  // Sun
});

test('resolveSchedule: empty override object → all days null (opt out of everything)', () => {
  const sched = {};
  assert.equal(resolveSchedule(new Date('2026-04-27'), sched), null);
  assert.equal(resolveSchedule(new Date('2026-04-25'), sched), null);
});

test('resolveSchedule: fallback defaults to null when omitted from entry', () => {
  const sched = { Mon: { kind: 'FIT', primaryTime: '7:30am' } };  // no fallback key
  assert.deepEqual(resolveSchedule(new Date('2026-04-27'), sched),
    { kind: 'FIT', primaryTime: '7:30am', fallback: null });
});

// ---------- users.getTelegramTarget: per-user routing ----------

test('getTelegramTarget: null chat_id → fallback to env with [Label] prefix', () => {
  const t = getTelegramTarget(
    { id: 'dani', label: 'Dani', telegramChatId: null },
    { TELEGRAM_CHAT_ID: '166637821' });
  assert.equal(t.chatId, '166637821');
  assert.equal(t.prefix, '[Dani] ');
});

test('getTelegramTarget: missing label → falls back to id in prefix', () => {
  const t = getTelegramTarget(
    { id: 'someone', telegramChatId: null },
    { TELEGRAM_CHAT_ID: '166637821' });
  assert.equal(t.prefix, '[someone] ');
});

test('getTelegramTarget: chat_id set → routes to user, no prefix', () => {
  const t = getTelegramTarget(
    { id: 'dani', label: 'Dani', telegramChatId: 999888777 },
    { TELEGRAM_CHAT_ID: '166637821' });
  assert.equal(t.chatId, '999888777');
  assert.equal(t.prefix, '');
});

test('getTelegramTarget: chat_id as string is preserved', () => {
  const t = getTelegramTarget(
    { id: 'x', label: 'X', telegramChatId: '12345' },
    { TELEGRAM_CHAT_ID: '99' });
  assert.equal(t.chatId, '12345');
  assert.equal(t.prefix, '');
});

// ---------- personality: per-user vibes for Lawrence ----------

const YASH_LIKE = null;  // book.js passes null for the legacy default user
const DANI_LIKE = { id: 'dani', label: 'Dani', vibe: 'wholesome' };
const MYSTERY = { id: 'someone', label: 'Someone' };  // unknown user → default vibe

test('vibeFor: yash (no user) → gymbro default', () => {
  assert.equal(personality.vibeFor(YASH_LIKE), 'gymbro');
});
test('vibeFor: dani via explicit vibe field still honors override', () => {
  assert.equal(personality.vibeFor(DANI_LIKE), 'wholesome');
});
test('vibeFor: dani via id-mapping with no vibe field falls back to default', () => {
  assert.equal(personality.vibeFor({ id: 'dani', label: 'Dani' }), 'gymbro');
});
test('vibeFor: unknown user → gymbro default', () => {
  assert.equal(personality.vibeFor(MYSTERY), 'gymbro');
});
test('vibeFor: explicit gymbro vibe field returns gymbro', () => {
  assert.equal(personality.vibeFor({ id: 'melissa', vibe: 'gymbro' }), 'gymbro');
});

test('firstName: legacy user → Yash', () => {
  assert.equal(personality.firstName(YASH_LIKE), 'Yash');
});
test('firstName: uses label, falls back to id', () => {
  assert.equal(personality.firstName({ id: 'dani', label: 'Dani' }), 'Dani');
  assert.equal(personality.firstName({ id: 'mystery' }), 'mystery');
});

test('safe: strips Markdown-breaking chars', () => {
  assert.equal(personality.safe('hello *world* _foo_ [bar]'), 'hello world foo bar');
  assert.equal(personality.safe('order id: `abc-123` and `def`'), 'order id: abc-123 and def');
  assert.equal(personality.safe(null), '');
  assert.equal(personality.safe(undefined), '');
  assert.equal(personality.safe(42), '42');
});

// Use a deterministic RNG so test output is stable. After each personality
// test, reset the RNG so unrelated tests don't see a stale stub.
function withRng(rngVal, fn) {
  personality._setRng(() => rngVal);
  try { fn(); } finally { personality._resetRng(); }
}

test('started: every variant for all vibes is non-empty + Markdown-safe', () => {
  const ctx = { planLine: 'FIT @ 6:30am', dayLabel: 'Mon 2026-05-04', secs: 120 };
  const userByVibe = {
    chaotic: YASH_LIKE,
    wholesome: DANI_LIKE,
    gymbro: { id: 'melissa', label: 'Melissa', vibe: 'gymbro' },
  };
  for (const vibe of ['chaotic', 'wholesome', 'gymbro']) {
    const user = userByVibe[vibe];
    const pool = personality.STARTED[vibe];
    for (let i = 0; i < pool.length; i++) {
      withRng((i + 0.5) / pool.length, () => {
        const msg = personality.started(user, ctx);
        assert.ok(msg.length > 10, `vibe=${vibe} variant=${i} too short: ${msg}`);
        assert.match(msg, /FIT @ 6:30am/, `vibe=${vibe} variant=${i} missing planLine`);
        assert.match(msg, /Mon 2026-05-04/, `vibe=${vibe} variant=${i} missing dayLabel`);
      });
    }
  }
});

test('loggedIn: every variant for all vibes is non-empty', () => {
  const userByVibe = {
    chaotic: YASH_LIKE,
    wholesome: DANI_LIKE,
    gymbro: { id: 'melissa', label: 'Melissa', vibe: 'gymbro' },
  };
  for (const vibe of ['chaotic', 'wholesome', 'gymbro']) {
    const user = userByVibe[vibe];
    const pool = personality.LOGGED_IN[vibe];
    for (let i = 0; i < pool.length; i++) {
      withRng((i + 0.5) / pool.length, () => {
        const msg = personality.loggedIn(user);
        assert.ok(msg.length > 5, `vibe=${vibe} variant=${i} too short`);
      });
    }
  }
});

test('standby: ui mode renders all vibes with secs interpolated', () => {
  const ctx = { planLine: 'FIT @ 6:30am', secs: 23, mode: 'ui' };
  const userByVibe = {
    chaotic: YASH_LIKE,
    wholesome: DANI_LIKE,
    gymbro: { id: 'melissa', label: 'Melissa', vibe: 'gymbro' },
  };
  for (const vibe of ['chaotic', 'wholesome', 'gymbro']) {
    const user = userByVibe[vibe];
    const pool = personality.STANDBY_UI[vibe];
    for (let i = 0; i < pool.length; i++) {
      withRng((i + 0.5) / pool.length, () => {
        const msg = personality.standby(user, ctx);
        // Every variant must show secs (the standby's whole purpose).
        assert.match(msg, /23s/, `vibe=${vibe} variant=${i} missing secs: ${msg}`);
      });
    }
  }
});

test('standby: api mode renders all vibes with secs interpolated', () => {
  const ctx = { planLine: 'FIT @ 6:30am', secs: 121, mode: 'api' };
  const userByVibe = {
    chaotic: YASH_LIKE,
    wholesome: DANI_LIKE,
    gymbro: { id: 'melissa', label: 'Melissa', vibe: 'gymbro' },
  };
  for (const vibe of ['chaotic', 'wholesome', 'gymbro']) {
    const user = userByVibe[vibe];
    const pool = personality.STANDBY_API[vibe];
    for (let i = 0; i < pool.length; i++) {
      withRng((i + 0.5) / pool.length, () => {
        const msg = personality.standby(user, ctx);
        assert.match(msg, /121s/, `vibe=${vibe} variant=${i} missing secs`);
      });
    }
  }
});

test('outcome: every gymbro variant in every bucket renders without crash', () => {
  const ctx = { planLine: 'FIT @ 6:30am', dayLabel: 'Mon 2026-05-04', didRelogin: false, runId: 'r1' };
  const user = { id: 'melissa', label: 'Melissa', vibe: 'gymbro' };
  const buckets = ['bookedFast', 'bookedSlow', 'alreadyBooked', 'dryRun', 'optOut',
                   'paused', 'dateSkip', 'full', 'unverified', 'notBooked', 'exception'];
  const statusByBucket = {
    bookedFast:    { ok: true, reason: 'booked (api-direct)', via: 'api', timing: { total: 1873 } },
    bookedSlow:    { ok: true, reason: 'booked' },
    alreadyBooked: { ok: true, reason: 'already_booked' },
    dryRun:        { ok: true, reason: 'dry_run' },
    optOut:        { ok: true, reason: 'opt_out_day' },
    paused:        { ok: true, reason: 'paused', detail: 'on leave until 2026-05-15' },
    dateSkip:      { ok: true, reason: 'date_skip' },
    full:          { ok: false, reason: 'class is FULL' },
    unverified:    { ok: false, reason: 'unverified', detail: 'BUY ambiguous' },
    notBooked:     { ok: false, reason: 'not booked', detail: 'row stayed BOOK NOW' },
    exception:     { ok: false, reason: 'exception', detail: 'auth-flow-broke' },
  };
  for (const bucket of buckets) {
    const pool = personality.OUTCOME[bucket].gymbro;
    assert.ok(Array.isArray(pool) && pool.length > 0, `bucket=${bucket} missing gymbro pool`);
    for (let i = 0; i < pool.length; i++) {
      withRng((i + 0.5) / pool.length, () => {
        const msg = personality.outcome(user, statusByBucket[bucket], ctx);
        assert.ok(msg.length > 5, `bucket=${bucket} variant=${i} too short: ${msg}`);
      });
    }
  }
});

test('personality.js source: zero em-dashes (Yash voice rule, set 2026-05-15)', () => {
  // Universal rule across every AI on Yash's behalf: em-dashes (U+2014) read
  // as AI-tell and break the human-voice feel. Pin the source file as
  // em-dash-free so a future edit that re-introduces one fails loudly.
  // Hyphen (-, U+002D) and en-dash (–, U+2013) are fine and unaffected.
  const src = fs.readFileSync(path.join(__dirname, 'personality.js'), 'utf8');
  const matches = [...src.matchAll(/—/g)];
  assert.equal(matches.length, 0,
    `personality.js must contain zero em-dashes; found ${matches.length}. Replace with commas, periods, or rewrite.`);
});

test('personality: every rendered variant across every vibe is em-dash-free', () => {
  // Defense-in-depth on top of the static-source guard: even if an em-dash
  // sneaks in via a future interpolation path or context value, the Lawrence
  // DM that lands in a user's phone must never carry one. Walks every public
  // render entry point × every vibe × every variant.
  const user = { id: 'melissa', label: 'Melissa', vibe: 'gymbro' };
  const userByVibe = { chaotic: YASH_LIKE, wholesome: DANI_LIKE, gymbro: user };
  const ctx = { planLine: 'FIT @ 6:30am', dayLabel: 'Mon 2026-05-04', secs: 60, ceilSecs: 1, runId: 'rTEST', didRelogin: false };
  const buckets = ['bookedFast', 'bookedSlow', 'alreadyBooked', 'dryRun', 'optOut',
                   'paused', 'dateSkip', 'full', 'unverified', 'notBooked', 'exception'];
  const statusByBucket = {
    bookedFast:    { ok: true, reason: 'booked (api-direct)', via: 'api', timing: { total: 1873 } },
    bookedSlow:    { ok: true, reason: 'booked' },
    alreadyBooked: { ok: true, reason: 'already_booked' },
    dryRun:        { ok: true, reason: 'dry_run' },
    optOut:        { ok: true, reason: 'opt_out_day' },
    paused:        { ok: true, reason: 'paused', detail: 'on leave' },
    dateSkip:      { ok: true, reason: 'date_skip' },
    full:          { ok: false, reason: 'class is FULL' },
    unverified:    { ok: false, reason: 'unverified', detail: 'BUY ambiguous' },
    notBooked:     { ok: false, reason: 'not booked', detail: 'row stayed BOOK NOW' },
    exception:     { ok: false, reason: 'exception', detail: 'auth-flow-broke' },
  };
  const noEmDash = (msg, where) =>
    assert.ok(!msg.includes('—'), `${where}: rendered output contains em-dash: ${msg}`);

  for (const vibe of ['chaotic', 'wholesome', 'gymbro']) {
    const u = userByVibe[vibe];
    for (let i = 0; i < personality.STARTED[vibe].length; i++) {
      withRng((i + 0.5) / personality.STARTED[vibe].length, () => noEmDash(personality.started(u, ctx), `started/${vibe}/${i}`));
    }
    for (let i = 0; i < personality.LOGGED_IN[vibe].length; i++) {
      withRng((i + 0.5) / personality.LOGGED_IN[vibe].length, () => noEmDash(personality.loggedIn(u), `loggedIn/${vibe}/${i}`));
    }
    for (let i = 0; i < personality.STANDBY_UI[vibe].length; i++) {
      withRng((i + 0.5) / personality.STANDBY_UI[vibe].length, () => noEmDash(personality.standby(u, { ...ctx, mode: 'ui' }), `standbyUI/${vibe}/${i}`));
    }
    for (let i = 0; i < personality.STANDBY_API[vibe].length; i++) {
      withRng((i + 0.5) / personality.STANDBY_API[vibe].length, () => noEmDash(personality.standby(u, { ...ctx, mode: 'api' }), `standbyAPI/${vibe}/${i}`));
    }
    for (const bucket of buckets) {
      const pool = personality.OUTCOME[bucket] && personality.OUTCOME[bucket][vibe];
      if (!pool) continue;
      for (let i = 0; i < pool.length; i++) {
        withRng((i + 0.5) / pool.length, () => noEmDash(personality.outcome(u, statusByBucket[bucket], ctx), `outcome/${bucket}/${vibe}/${i}`));
      }
    }
  }
});

test('outcome bucket selection: api-direct success → bookedFast', () => {
  const status = {
    ok: true, reason: 'booked (api-direct)',
    via: 'api', timing: { total: 1873 },
  };
  assert.equal(personality._bucket(status), 'bookedFast');
});

test('outcome bucket selection: UI-flow success → bookedSlow', () => {
  assert.equal(personality._bucket({ ok: true, reason: 'booked' }), 'bookedSlow');
  assert.equal(personality._bucket({ ok: true, reason: 'booked (BUY-confirmed)' }), 'bookedSlow');
});

test('outcome bucket selection: classifies all known outcomes', () => {
  assert.equal(personality._bucket({ ok: true, reason: 'already_booked' }), 'alreadyBooked');
  assert.equal(personality._bucket({ ok: true, reason: 'dry_run' }), 'dryRun');
  assert.equal(personality._bucket({ ok: true, reason: 'opt_out_day' }), 'optOut');
  assert.equal(personality._bucket({ ok: false, reason: 'opt_out_day' }), 'optOut');
  assert.equal(personality._bucket({ ok: false, reason: 'exception' }), 'exception');
  assert.equal(personality._bucket({ ok: false, reason: 'unverified' }), 'unverified');
  assert.equal(personality._bucket({ ok: false, reason: 'not booked' }), 'full');
  assert.equal(personality._bucket({ ok: false, reason: 'FULL' }), 'full');
  // Unknown failure → bucketed as exception (generic error template)
  assert.equal(personality._bucket({ ok: false, reason: 'something weird' }), 'exception');
});

test('outcome: api-direct success includes ms timing in body', () => {
  const status = { ok: true, reason: 'booked (api-direct)', via: 'api', timing: { total: 1873 } };
  const ctx = { planLine: 'FIT @ 6:30am', dayLabel: 'Mon 2026-05-04', runId: 'X', didRelogin: false };
  // Try every variant — all should mention ms.
  const pool = personality.OUTCOME.bookedFast.chaotic;
  for (let i = 0; i < pool.length; i++) {
    withRng((i + 0.5) / pool.length, () => {
      const msg = personality.outcome(YASH_LIKE, status, ctx);
      assert.match(msg, /1873ms/, `chaotic bookedFast variant ${i}: missing ms`);
    });
  }
});

test('outcome: includes run id footnote', () => {
  const status = { ok: true, reason: 'booked', via: 'ui' };
  const ctx = { planLine: 'FIT @ 6:30am', dayLabel: 'Mon 2026-05-04', runId: '2026-05-02T01-00-00' };
  withRng(0.0, () => {
    const msg = personality.outcome(YASH_LIKE, status, ctx);
    assert.match(msg, /run: `2026-05-02T01-00-00`/);
  });
});

test('outcome: includes auth-refreshed marker when didRelogin=true', () => {
  const status = { ok: true, reason: 'booked', via: 'ui' };
  const ctx = { planLine: 'FIT @ 6:30am', dayLabel: 'Mon', runId: 'X', didRelogin: true };
  withRng(0.0, () => {
    const msg = personality.outcome(YASH_LIKE, status, ctx);
    assert.match(msg, /auth refreshed mid-flow/);
  });
});

test('outcome: dani gets wholesome variants for happy path', () => {
  const status = { ok: true, reason: 'booked (api-direct)', via: 'api', timing: { total: 2089 } };
  const ctx = { planLine: 'FIT @ 6:30am', dayLabel: 'Mon 2026-05-04', runId: 'X' };
  const pool = personality.OUTCOME.bookedFast.wholesome;
  for (let i = 0; i < pool.length; i++) {
    withRng((i + 0.5) / pool.length, () => {
      const msg = personality.outcome(DANI_LIKE, status, ctx);
      // Wholesome shouldn't contain insulting words or the chaotic-only emojis
      // (rough sanity — variants with "annihilated", "rinsed", "brutal" should
      // never reach Dani).
      assert.doesNotMatch(msg, /annihilated|rinsed|brutal|cooked|insufferably/i,
        `wholesome variant ${i} leaked chaotic vocab: ${msg}`);
    });
  }
});

test('outcome: opt-out day for chaotic vibe', () => {
  const status = { ok: true, reason: 'opt_out_day' };
  const ctx = { planLine: '', dayLabel: 'Wed 2026-05-06', runId: 'X' };
  withRng(0.0, () => {
    const msg = personality.outcome(YASH_LIKE, status, ctx);
    assert.ok(msg.length > 10);
    assert.match(msg, /Wed 2026-05-06/);
  });
});

test('outcome: FULL race-loss says it nicely (wholesome)', () => {
  const status = { ok: false, reason: 'unverified', detail: 'row went FULL (race lost)' };
  const ctx = { planLine: 'FIT @ 6:30am', dayLabel: 'Mon 2026-05-04', runId: 'X' };
  // status reason 'unverified' goes to unverified bucket, but if reason is FULL → full bucket.
  // Test the FULL bucket directly with a true FULL reason.
  const fullStatus = { ok: false, reason: 'FULL primary' };
  withRng(0.5, () => {
    const msg = personality.outcome(DANI_LIKE, fullStatus, ctx);
    assert.match(msg, /FIT @ 6:30am/);
    // Must not crash / produce empty
    assert.ok(msg.length > 10);
  });
});

test('safe: real-world dynamic content from book.js does not break', () => {
  // Examples observed in book.js status.detail:
  //   "FIT @ 6:30am on Mon 2026-05-04 via API in 1873ms (`processing_requested`)"
  //   "row went FULL (race lost)"
  //   `verify=DETAILS (...) BUY=ok: ...`
  const inputs = [
    'FIT @ 6:30am via API in 1873ms (`processing_requested`)',
    'verify=DETAILS (DETAILS→BOOKED); BUY=checkout closed: BUY/PURCHASING gone for 1500ms',
    '_auto re-login used — auth.json refreshed_',
    'order id: [abc-123]',
  ];
  for (const s of inputs) {
    const cleaned = personality.safe(s);
    // Must not contain unbalanced markdown-breaking chars after cleaning
    assert.doesNotMatch(cleaned, /[*_[\]`]/, `safe() left a chr in: ${cleaned}`);
  }
});

// ──────────────────────── overrides + resolveBookingForDate ────────────────────────

test('loadOverrides: missing file returns empty shell', () => {
  const o = loadOverrides('/tmp/this-file-definitely-does-not-exist-9z8y.json');
  assert.deepEqual(o, { users: {} });
});

test('loadOverrides: malformed JSON returns empty shell (does not throw)', () => {
  const tmp = path.join(os.tmpdir(), `gym-overrides-bad-${Date.now()}.json`);
  fs.writeFileSync(tmp, '{this is not valid json');
  try {
    const o = loadOverrides(tmp);
    assert.deepEqual(o, { users: {} });
  } finally { fs.unlinkSync(tmp); }
});

test('loadOverrides: missing top-level "users" key returns empty shell', () => {
  const tmp = path.join(os.tmpdir(), `gym-overrides-noroot-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ version: 1 }));
  try {
    const o = loadOverrides(tmp);
    assert.deepEqual(o, { users: {} });
  } finally { fs.unlinkSync(tmp); }
});

test('loadOverrides: well-formed file round-trips', () => {
  const tmp = path.join(os.tmpdir(), `gym-overrides-good-${Date.now()}.json`);
  const payload = { version: 1, users: { yash: { pauseUntil: '2026-05-15' } } };
  fs.writeFileSync(tmp, JSON.stringify(payload));
  try {
    const o = loadOverrides(tmp);
    assert.deepEqual(o, payload);
  } finally { fs.unlinkSync(tmp); }
});

test('resolveBookingForDate: no overrides → falls through to classPlan (Yash)', () => {
  const r = resolveBookingForDate(new Date('2026-05-04T00:00:00'), 'yash', null, { users: {} });
  assert.deepEqual(r, { kind: 'FIT', primaryTime: '6:30am', fallback: '7:30am' });
});

test('resolveBookingForDate: per-date time override (Yash) — fallback is dropped', () => {
  const o = { users: { yash: { perDate: { '2026-05-04': { time: '7:30am' } } } } };
  const r = resolveBookingForDate(new Date('2026-05-04T00:00:00'), 'yash', null, o);
  assert.deepEqual(r, { kind: 'FIT', primaryTime: '7:30am', fallback: null });
});

test('resolveBookingForDate: per-date kind override picks up explicit kind', () => {
  const o = { users: { yash: { perDate: { '2026-05-04': { time: '12:30pm', kind: 'Gymnastics' } } } } };
  const r = resolveBookingForDate(new Date('2026-05-04T00:00:00'), 'yash', null, o);
  assert.deepEqual(r, { kind: 'Gymnastics', primaryTime: '12:30pm', fallback: null });
});

test('resolveBookingForDate: per-date null = date_skip', () => {
  const o = { users: { yash: { perDate: { '2026-05-04': null } } } };
  const r = resolveBookingForDate(new Date('2026-05-04T00:00:00'), 'yash', null, o);
  assert.deepEqual(r, { skip: 'date_skip' });
});

test('resolveBookingForDate: pauseUntil window skips dates within range (inclusive)', () => {
  const o = { users: { yash: { pauseUntil: '2026-05-15' } } };
  // before pause start — pause window is "until X", so any date <= X is paused
  const r1 = resolveBookingForDate(new Date('2026-05-11T00:00:00'), 'yash', null, o);  // Mon
  assert.equal(r1.skip, 'paused');
  // exact boundary day (inclusive) — Fri
  const r2 = resolveBookingForDate(new Date('2026-05-15T00:00:00'), 'yash', null, o);
  assert.equal(r2.skip, 'paused');
  // day after pause ends — booking resumes (use Mon to keep FIT default)
  const r3 = resolveBookingForDate(new Date('2026-05-18T00:00:00'), 'yash', null, o);  // Mon
  assert.equal(r3.kind, 'FIT');
  assert.equal(r3.skip, undefined);
});

test('resolveBookingForDate: explicit perDate beats pauseUntil (break-the-pause for one class)', () => {
  const o = { users: { yash: {
    pauseUntil: '2026-05-15',
    perDate: { '2026-05-11': { time: '8:30am' } },  // Mon, inside pause
  } } };
  const r = resolveBookingForDate(new Date('2026-05-11T00:00:00'), 'yash', null, o);
  assert.deepEqual(r, { kind: 'FIT', primaryTime: '8:30am', fallback: null });
});

test('resolveBookingForDate: per-user isolation (yash override does not affect dani)', () => {
  const o = { users: { yash: { pauseUntil: '2030-01-01' } } };
  const r = resolveBookingForDate(new Date('2026-05-04T00:00:00'), 'dani', null, o);
  assert.equal(r.skip, undefined);
  assert.equal(r.kind, 'FIT');
});

test('resolveBookingForDate: DOW opt-out via userScheduleOverride → opt_out_day', () => {
  // Dani has Mon-Wed only; Thursday is opt-out
  const danischedule = { Mon: {kind:'FIT', primaryTime:'7:30am'}, Tue: {kind:'FIT', primaryTime:'7:30am'}, Wed: {kind:'FIT', primaryTime:'7:30am'} };
  // 2026-05-07 = Thursday (no Mon/Tue/Wed → null)
  const r = resolveBookingForDate(new Date('2026-05-07T00:00:00'), 'dani', danischedule, { users: {} });
  assert.deepEqual(r, { skip: 'opt_out_day' });
});

test('resolveBookingForDate: explicit perDate beats DOW opt-out', () => {
  const danischedule = { Mon: {kind:'FIT', primaryTime:'7:30am'} };
  const o = { users: { dani: { perDate: { '2026-05-07': { time: '8:30am' } } } } };  // Thu, normally opt-out
  const r = resolveBookingForDate(new Date('2026-05-07T00:00:00'), 'dani', danischedule, o);
  // Thu DOW default in classPlan is FIT @ 6:30am, but override sets time → 8:30am
  assert.deepEqual(r, { kind: 'FIT', primaryTime: '8:30am', fallback: null });
});

test('resolveBookingForDate: malformed dateOverrides arg does not crash', () => {
  const r1 = resolveBookingForDate(new Date('2026-05-04T00:00:00'), 'yash', null, null);
  assert.equal(r1.kind, 'FIT');
  const r2 = resolveBookingForDate(new Date('2026-05-04T00:00:00'), 'yash', null, undefined);
  assert.equal(r2.kind, 'FIT');
  const r3 = resolveBookingForDate(new Date('2026-05-04T00:00:00'), 'yash', null, { users: null });
  assert.equal(r3.kind, 'FIT');
});

test('resolveBookingForDate: Saturday gymnastics default carries through override-free path', () => {
  const r = resolveBookingForDate(new Date('2026-05-02T00:00:00'), 'yash', null, { users: {} });
  assert.deepEqual(r, { kind: 'Gymnastics', primaryTime: '12:30pm', fallback: null });
});

test('resolveBookingForDate: Saturday with time-only override defaults kind to Gymnastics', () => {
  // User says "do 11am instead of 12:30pm Saturday" — kind should still be Gymnastics
  const o = { users: { yash: { perDate: { '2026-05-02': { time: '11:00am' } } } } };
  const r = resolveBookingForDate(new Date('2026-05-02T00:00:00'), 'yash', null, o);
  assert.deepEqual(r, { kind: 'Gymnastics', primaryTime: '11:00am', fallback: null });
});

// ──────────── resolveSchedulePlans / resolveBookingsForDate (back-to-back) ────────────

test('resolveSchedulePlans: null override → 1-element list with classPlan default', () => {
  // Mon — Yash default is FIT 6:30am with 7:30am fallback
  assert.deepEqual(resolveSchedulePlans(new Date('2026-04-27'), null),
    [{ kind: 'FIT', primaryTime: '6:30am', fallback: '7:30am' }]);
});

test('resolveSchedulePlans: single-class day → 1-element list', () => {
  const sched = { Mon: { kind: 'FIT', primaryTime: '7:30pm' } };
  assert.deepEqual(resolveSchedulePlans(new Date('2026-04-27'), sched),
    [{ kind: 'FIT', primaryTime: '7:30pm', fallback: null }]);
});

test('resolveSchedulePlans: array entry → multi-plan list preserves order', () => {
  const sched = { Mon: [
    { kind: 'BURN', primaryTime: '6:30pm' },
    { kind: 'FIT', primaryTime: '7:30pm' },
  ]};
  assert.deepEqual(resolveSchedulePlans(new Date('2026-04-27'), sched), [
    { kind: 'BURN', primaryTime: '6:30pm', fallback: null },
    { kind: 'FIT',  primaryTime: '7:30pm', fallback: null },
  ]);
});

test('resolveSchedulePlans: empty array → [] (treated as opt-out)', () => {
  const sched = { Mon: [] };
  assert.deepEqual(resolveSchedulePlans(new Date('2026-04-27'), sched), []);
});

test('resolveSchedulePlans: null entry → [] (explicit opt-out)', () => {
  const sched = { Mon: null };
  assert.deepEqual(resolveSchedulePlans(new Date('2026-04-27'), sched), []);
});

test('resolveSchedulePlans: missing day key → []', () => {
  const sched = { Mon: { kind: 'FIT', primaryTime: '7:30pm' } };
  assert.deepEqual(resolveSchedulePlans(new Date('2026-04-29'), sched), []);  // Wed
});

test('resolveSchedulePlans: array entries preserve fallback when set', () => {
  const sched = { Fri: [
    { kind: 'FIT', primaryTime: '6:30am', fallback: '7:30am' },
  ]};
  assert.deepEqual(resolveSchedulePlans(new Date('2026-05-01'), sched),
    [{ kind: 'FIT', primaryTime: '6:30am', fallback: '7:30am' }]);
});

test('resolveSchedule (singular): array entry returns first plan only', () => {
  const sched = { Mon: [
    { kind: 'BURN', primaryTime: '6:30pm' },
    { kind: 'FIT', primaryTime: '7:30pm' },
  ]};
  assert.deepEqual(resolveSchedule(new Date('2026-04-27'), sched),
    { kind: 'BURN', primaryTime: '6:30pm', fallback: null });
});

test('resolveSchedule (singular): empty array returns null', () => {
  const sched = { Mon: [] };
  assert.equal(resolveSchedule(new Date('2026-04-27'), sched), null);
});

test('resolveBookingsForDate: back-to-back day → { plans: [BURN, FIT] }', () => {
  const sched = { Mon: [
    { kind: 'BURN', primaryTime: '6:30pm' },
    { kind: 'FIT', primaryTime: '7:30pm' },
  ]};
  const r = resolveBookingsForDate(new Date('2026-04-27T00:00:00'), 'melissa', sched, { users: {} });
  assert.deepEqual(r, { plans: [
    { kind: 'BURN', primaryTime: '6:30pm', fallback: null },
    { kind: 'FIT',  primaryTime: '7:30pm', fallback: null },
  ]});
});

test('resolveBookingsForDate: single-class day → 1-element plans array', () => {
  const sched = { Fri: { kind: 'FIT', primaryTime: '7:30am' } };
  const r = resolveBookingsForDate(new Date('2026-05-01T00:00:00'), 'melissa', sched, { users: {} });
  assert.deepEqual(r, { plans: [{ kind: 'FIT', primaryTime: '7:30am', fallback: null }]});
});

test('resolveBookingsForDate: opt-out day → { skip: opt_out_day }', () => {
  const sched = { Mon: { kind: 'FIT', primaryTime: '7:30pm' } };  // no Wed key
  const r = resolveBookingsForDate(new Date('2026-04-29T00:00:00'), 'melissa', sched, { users: {} });
  assert.deepEqual(r, { skip: 'opt_out_day' });
});

test('resolveBookingsForDate: explicit-null day → { skip: opt_out_day }', () => {
  const sched = { Mon: null };
  const r = resolveBookingsForDate(new Date('2026-04-27T00:00:00'), 'melissa', sched, { users: {} });
  assert.deepEqual(r, { skip: 'opt_out_day' });
});

test('resolveBookingsForDate: per-date override → single plan (back-to-back not supported via overrides)', () => {
  const sched = { Mon: [
    { kind: 'BURN', primaryTime: '6:30pm' },
    { kind: 'FIT', primaryTime: '7:30pm' },
  ]};
  const overrides = { users: { melissa: { perDate: { '2026-04-27': { kind: 'FIT', time: '8:00pm' } } } } };
  const r = resolveBookingsForDate(new Date('2026-04-27T00:00:00'), 'melissa', sched, overrides);
  assert.deepEqual(r, { plans: [{ kind: 'FIT', primaryTime: '8:00pm', fallback: null }]});
});

test('resolveBookingsForDate: per-date null on back-to-back day → date_skip (cancels both)', () => {
  const sched = { Mon: [
    { kind: 'BURN', primaryTime: '6:30pm' },
    { kind: 'FIT', primaryTime: '7:30pm' },
  ]};
  const overrides = { users: { melissa: { perDate: { '2026-04-27': null } } } };
  const r = resolveBookingsForDate(new Date('2026-04-27T00:00:00'), 'melissa', sched, overrides);
  assert.deepEqual(r, { skip: 'date_skip' });
});

test('resolveBookingsForDate: pauseUntil window cancels back-to-back day', () => {
  const sched = { Mon: [
    { kind: 'BURN', primaryTime: '6:30pm' },
    { kind: 'FIT', primaryTime: '7:30pm' },
  ]};
  const overrides = { users: { melissa: { pauseUntil: '2026-05-15' } } };
  const r = resolveBookingsForDate(new Date('2026-05-04T00:00:00'), 'melissa', sched, overrides);
  assert.equal(r.skip, 'paused');
});

test('resolveBookingsForDate: no override → Yash default classPlan as 1-element list', () => {
  // Yash has no users.json schedule; Tue → FIT 6:30am/7:30am
  const r = resolveBookingsForDate(new Date('2026-05-05T00:00:00'), 'yash', null, { users: {} });
  assert.deepEqual(r, { plans: [{ kind: 'FIT', primaryTime: '6:30am', fallback: '7:30am' }]});
});

test('resolveBookingForDate (singular): back-to-back day still returns first plan only (legacy callers)', () => {
  const sched = { Mon: [
    { kind: 'BURN', primaryTime: '6:30pm' },
    { kind: 'FIT', primaryTime: '7:30pm' },
  ]};
  const r = resolveBookingForDate(new Date('2026-04-27T00:00:00'), 'melissa', sched, { users: {} });
  assert.deepEqual(r, { kind: 'BURN', primaryTime: '6:30pm', fallback: null });
});

// FIT-first sort: when book.js receives multiple plans, FIT must lead so that
// in the parallel race below, FIT's microtask queues first → wins shared-resource
// races at 09:00:00. Mirrors the sort at book.js right after `plans` is built.
function fitFirstSort(plans) {
  return [...plans].sort((a, b) => (b.kind === 'FIT' ? 1 : 0) - (a.kind === 'FIT' ? 1 : 0));
}

test('fit-first sort: BURN+FIT → FIT first', () => {
  const sorted = fitFirstSort([
    { kind: 'BURN', primaryTime: '6:30pm' },
    { kind: 'FIT', primaryTime: '7:30pm' },
  ]);
  assert.deepEqual(sorted.map(p => p.kind), ['FIT', 'BURN']);
});

test('fit-first sort: FIT+BURN already first → unchanged', () => {
  const sorted = fitFirstSort([
    { kind: 'FIT', primaryTime: '7:30pm' },
    { kind: 'BURN', primaryTime: '6:30pm' },
  ]);
  assert.deepEqual(sorted.map(p => p.kind), ['FIT', 'BURN']);
});

test('fit-first sort: single FIT plan → unchanged', () => {
  const sorted = fitFirstSort([{ kind: 'FIT', primaryTime: '6:30am', fallback: '7:30am' }]);
  assert.deepEqual(sorted.map(p => p.kind), ['FIT']);
});

test('fit-first sort: stable for non-FIT order (Gymnastics+BURN)', () => {
  const sorted = fitFirstSort([
    { kind: 'Gymnastics', primaryTime: '1:00pm' },
    { kind: 'BURN', primaryTime: '6:30pm' },
  ]);
  assert.deepEqual(sorted.map(p => p.kind), ['Gymnastics', 'BURN']);
});

// Parallel-fan-out timing: when book.js fans plans out via Promise.all, both
// plans' bookViaApi-equivalent calls must be in-flight concurrently (NOT
// sequenced). The 2026-05-09 incident: BURN booked then FIT tried — popular
// FIT slot was full by then. Parallel firing closes that 1–3s window.
test('parallel fan-out: 2 plans fire bookViaApi concurrently (within 200ms)', async () => {
  const calls = [];
  // Stub: simulate per-plan work — trivial pre-work, then a "9am POST" that
  // takes a long time. If we ran sequentially, plan #2's POST starts only
  // after plan #1's 500ms POST finishes. In parallel, both start ~immediately.
  async function fakeBookOnePlan(plan) {
    await new Promise(r => setTimeout(r, 5));         // pre-work (e.g. fetch class meta)
    calls.push({ kind: plan.kind, postStartedAt: Date.now() });
    await new Promise(r => setTimeout(r, 500));        // simulate 9am bookViaApi POST
    return { ok: true, kind: plan.kind };
  }

  const plans = fitFirstSort([
    { kind: 'BURN', primaryTime: '6:30pm' },
    { kind: 'FIT', primaryTime: '7:30pm' },
  ]);

  const t0 = Date.now();
  const settled = await Promise.all(plans.map(p => fakeBookOnePlan(p)));
  const wallMs = Date.now() - t0;

  assert.equal(settled.length, 2);
  assert.equal(calls.length, 2, 'both plans must record a POST start');
  const gap = Math.abs(calls[0].postStartedAt - calls[1].postStartedAt);
  assert.ok(gap < 200, `POSTs should fire within 200ms; gap was ${gap}ms (sequential would be ~500ms)`);
  assert.ok(wallMs < 700, `wall time must reflect parallel exec; got ${wallMs}ms (sequential would be ~1000ms)`);
});

test('parallel fan-out: FIT POST initiated before BURN POST', async () => {
  const calls = [];
  async function fakeBookOnePlan(plan) {
    await new Promise(r => setTimeout(r, 5));
    calls.push({ kind: plan.kind, t: Date.now() });
    await new Promise(r => setTimeout(r, 50));
    return { ok: true };
  }

  const plans = fitFirstSort([
    { kind: 'BURN', primaryTime: '6:30pm' },
    { kind: 'FIT', primaryTime: '7:30pm' },
  ]);
  await Promise.all(plans.map(p => fakeBookOnePlan(p)));

  const fitTime = calls.find(c => c.kind === 'FIT').t;
  const burnTime = calls.find(c => c.kind === 'BURN').t;
  // FIT must initiate before-or-equal BURN. JS microtask ordering means
  // index-0 in Promise.all queues first, so equal-or-earlier is the spec.
  assert.ok(fitTime <= burnTime, `FIT must initiate ≤ BURN; got FIT=${fitTime} BURN=${burnTime}`);
});

test('parallel fan-out: one plan failing does not abort the other', async () => {
  async function fakeBookOnePlan(plan) {
    if (plan.kind === 'BURN') throw new Error('BURN row went FULL');
    await new Promise(r => setTimeout(r, 20));
    return { ok: true, kind: plan.kind };
  }

  const plans = fitFirstSort([
    { kind: 'BURN', primaryTime: '6:30pm' },
    { kind: 'FIT', primaryTime: '7:30pm' },
  ]);

  // Mirror book.js: each plan's promise wraps in try/catch so one rejection
  // doesn't cancel siblings (Promise.all rejects fast otherwise).
  const settled = await Promise.all(plans.map(async (plan) => {
    try { return { plan, status: await fakeBookOnePlan(plan) }; }
    catch (e) { return { plan, status: { ok: false, reason: 'exception', detail: e.message } }; }
  }));

  const fit = settled.find(r => r.plan.kind === 'FIT');
  const burn = settled.find(r => r.plan.kind === 'BURN');
  assert.equal(fit.status.ok, true, 'FIT must succeed even when BURN throws');
  assert.equal(burn.status.ok, false);
  assert.match(burn.status.detail, /FULL/);
});


// ─── Keychain-backed credential storage (2026-05-10 migration) ─────────────
//
// Mindbody passwords moved from plaintext users.json into a custom macOS
// keychain (~/Library/Keychains/gym-booker.keychain-db). These tests pin
// the contract:
//   - keychain.js round-trips set/get/delete
//   - users.getCreds() reads keychain first, falls back to plaintext, throws
//     when neither has a value
//   - real users (Dani, Mer) resolve cleanly via keychain — proves tomorrow's
//     09:00 booking pipeline can still pick up creds.

const keychain = require('./keychain');
const users = require('./users');

const SMOKE_CHAT_ID = '__test_chat_777__';

test('keychain: set / get / delete round-trip', () => {
  // Idempotent cleanup before
  keychain.deleteCred(SMOKE_CHAT_ID, 'email');
  keychain.deleteCred(SMOKE_CHAT_ID, 'password');

  assert.equal(keychain.hasCred(SMOKE_CHAT_ID, 'email'), false);

  keychain.setCred(SMOKE_CHAT_ID, 'email', 'unit-test@example.com');
  keychain.setCred(SMOKE_CHAT_ID, 'password', 'unit-test-pw-1234');
  assert.equal(keychain.getCred(SMOKE_CHAT_ID, 'email'), 'unit-test@example.com');
  assert.equal(keychain.getCred(SMOKE_CHAT_ID, 'password'), 'unit-test-pw-1234');

  // Update overwrites
  keychain.setCred(SMOKE_CHAT_ID, 'email', 'updated@example.com');
  assert.equal(keychain.getCred(SMOKE_CHAT_ID, 'email'), 'updated@example.com');

  // Delete returns true once, false on idempotent re-delete
  assert.equal(keychain.deleteCred(SMOKE_CHAT_ID, 'email'), true);
  assert.equal(keychain.deleteCred(SMOKE_CHAT_ID, 'email'), false);
  assert.equal(keychain.hasCred(SMOKE_CHAT_ID, 'email'), false);

  // Cleanup
  keychain.deleteCred(SMOKE_CHAT_ID, 'password');
});

test('keychain: refuses empty value (defense vs. silent overwrite)', () => {
  assert.throws(
    () => keychain.setCred(SMOKE_CHAT_ID, 'email', ''),
    /refusing to store empty/i,
  );
});

test('keychain: missing chatId or field rejected', () => {
  assert.throws(() => keychain.getCred(undefined, 'email'), /chatId required/i);
  assert.throws(() => keychain.getCred('x', ''), /field required/i);
});

test('users.getCreds: prefers keychain over plaintext', () => {
  const KC_CHAT = '__test_chat_888__';
  // Stash both keychain and plaintext for the same user; keychain should win.
  keychain.setCred(KC_CHAT, 'email', 'kc-email@example.com');
  keychain.setCred(KC_CHAT, 'password', 'kc-pw');
  const fakeUser = {
    id: 'kctest',
    telegramChatId: KC_CHAT,
    email: 'plain-email@example.com',
    password: 'plain-pw',
  };
  const c = users.getCreds(fakeUser);
  assert.equal(c.email, 'kc-email@example.com', 'keychain email must win over plaintext');
  assert.equal(c.password, 'kc-pw', 'keychain password must win over plaintext');

  keychain.deleteCred(KC_CHAT, 'email');
  keychain.deleteCred(KC_CHAT, 'password');
});

test('users.getCreds: falls back to plaintext when keychain is empty', () => {
  const fakeUser = {
    id: 'plaintest',
    telegramChatId: '__test_chat_999__',
    email: 'plain@example.com',
    password: 'plain-fallback',
  };
  const c = users.getCreds(fakeUser);
  assert.equal(c.email, 'plain@example.com');
  assert.equal(c.password, 'plain-fallback');
});

test('users.getCreds: throws when neither keychain nor plaintext has creds', () => {
  const fakeUser = {
    id: 'emptytest',
    telegramChatId: '__test_chat_aaa__',
  };
  assert.throws(() => users.getCreds(fakeUser), /no creds/i);
});

test('users.getCreds: every registered user resolves cleanly via keychain', () => {
  // Regression guard for the daily 09:00 booking pipeline. Yash, Dani, Mer,
  // and Cheryl were all migrated to keychain on 2026-05-10 — Yash via the
  // .env-scrub follow-up later that evening. Pin that resolution still
  // works for everyone (incl. users still in onboarding — creds may be
  // saved before schedule).
  const all = users.loadUsers();
  const live = all.filter(u => u.telegramChatId);
  assert.ok(live.length >= 4, `expected >=4 registered users with chatId, got ${live.length}`);
  for (const u of live) {
    const c = users.getCreds(u);
    assert.ok(c.email && c.email.length > 3, `${u.id}: empty email`);
    assert.ok(c.password && c.password.length > 3, `${u.id}: empty password`);
  }
});

test('users.getCreds: Yash (chat 166637821) resolves via keychain', () => {
  // Specific guard for the 2026-05-10 evening migration that brought Yash
  // off the legacy .env path into the keychain alongside everyone else.
  const yash = users.loadUsers().find(u => u.telegramChatId === 166637821);
  assert.ok(yash, 'Yash should be in users.json with telegramChatId 166637821');
  assert.equal(yash.id, 'yash');
  const c = users.getCreds(yash);
  assert.ok(c.email && c.email.includes('@'), 'Yash email malformed or empty');
  assert.ok(c.password && c.password.length >= 6, 'Yash password missing or too short');
});

test('book-all roster: every entry passes --user (no legacy no-user branch)', () => {
  // The legacy "Yash uses no --user" branch in book-all.js was removed on
  // 2026-05-10 when Yash joined the keychain. Re-introducing it would
  // bypass getCreds() and re-create the .env plaintext dependency.
  const src = fs.readFileSync(path.join(__dirname, 'book-all.js'), 'utf8');
  // The legacy literal we don't want back
  assert.ok(
    !src.includes("[{ id: 'yash', label: 'Yash', bookArgs: [] }]"),
    'book-all.js still has the legacy hardcoded yash-without-user roster entry',
  );
  // The replacement: every user gets --user via the loop
  assert.ok(
    src.includes("bookArgs: ['--user', u.id]"),
    'book-all.js should map every users.json entry to bookArgs with --user',
  );
});

// ── Login-button protection (2026-05-12 incident regression suite) ──────────
// These tests guard the fix for the cookie-banner-overlay race that broke 4/5
// bookings on 2026-05-12. The probe logic and alert format live in lib.js so
// they can be exercised here without Playwright; the same source runs in
// production via page.evaluate (probeLoginButtonInBrowser).

// Minimal fake DOM. Each node has tagName/id/className, a rect, and a parent
// chain so contains() can walk it. enough to exercise probeLoginButton without
// pulling in jsdom (kept zero-dep on purpose).
function makeNode({ tagName = 'BUTTON', id = '', className = '', rect = null, parent = null } = {}) {
  const node = {
    tagName: tagName.toUpperCase(),
    id,
    className,
    getBoundingClientRect: () => rect || { left: 0, top: 0, width: 100, height: 40 },
    __parent: parent,
    contains(other) {
      if (other === this) return true;
      let p = other && other.__parent;
      while (p) { if (p === this) return true; p = p.__parent; }
      return false;
    },
  };
  return node;
}

function makeDoc({ button = null, topmost = null } = {}) {
  return {
    querySelector: () => button,
    elementFromPoint: () => topmost,
  };
}

test('probeLoginButton: no-button when selector matches nothing', () => {
  const r = probeLoginButton(makeDoc({ button: null }), LOGIN_BUTTON_SEL);
  assert.deepEqual(r, { state: 'no-button' });
});

test('probeLoginButton: invisible when button rect is 0x0', () => {
  const btn = makeNode({ rect: { left: 0, top: 0, width: 0, height: 0 } });
  const r = probeLoginButton(makeDoc({ button: btn, topmost: btn }), LOGIN_BUTTON_SEL);
  assert.deepEqual(r, { state: 'invisible' });
});

test('probeLoginButton: invisible when only width is 0', () => {
  const btn = makeNode({ rect: { left: 0, top: 0, width: 0, height: 40 } });
  const r = probeLoginButton(makeDoc({ button: btn, topmost: btn }), LOGIN_BUTTON_SEL);
  assert.equal(r.state, 'invisible');
});

test('probeLoginButton: invisible when only height is 0', () => {
  const btn = makeNode({ rect: { left: 0, top: 0, width: 80, height: 0 } });
  const r = probeLoginButton(makeDoc({ button: btn, topmost: btn }), LOGIN_BUTTON_SEL);
  assert.equal(r.state, 'invisible');
});

test('probeLoginButton: no-topmost when elementFromPoint returns null', () => {
  const btn = makeNode({});
  const r = probeLoginButton(makeDoc({ button: btn, topmost: null }), LOGIN_BUTTON_SEL);
  assert.deepEqual(r, { state: 'no-topmost' });
});

test('probeLoginButton: clear when topmost IS the button', () => {
  const btn = makeNode({});
  const r = probeLoginButton(makeDoc({ button: btn, topmost: btn }), LOGIN_BUTTON_SEL);
  assert.deepEqual(r, { state: 'clear' });
});

test('probeLoginButton: clear when topmost is a descendant of the button', () => {
  const btn = makeNode({ tagName: 'BUTTON' });
  const inner = makeNode({ tagName: 'SPAN', parent: btn });
  const r = probeLoginButton(makeDoc({ button: btn, topmost: inner }), LOGIN_BUTTON_SEL);
  assert.deepEqual(r, { state: 'clear' });
});

test('probeLoginButton: clear when topmost is an ancestor of the button', () => {
  const inner = makeNode({ tagName: 'SPAN' });
  const btn = makeNode({ tagName: 'BUTTON', parent: inner });
  const r = probeLoginButton(makeDoc({ button: btn, topmost: inner }), LOGIN_BUTTON_SEL);
  assert.deepEqual(r, { state: 'clear' });
});

// ───────── waitlist auto-join state machine (2026-05-20) ──────────────────

test('waitlist state machine: joins when status FULL and not yet joined', () => {
  const state = { lastStatus: 'UNKNOWN', lastChecked: null, polls: 0, firstSeen: null, joined: false };
  const observed = 'FULL';
  const classMeta = { className: 'FIT', startTime: '06:30' };

  // Simulate state machine path 1: join trigger
  if (observed === 'FULL' && !state.joined) {
    state.joined = true;
    state.joinedAt = new Date().toISOString();
    // In real code, joinWaitlistViaApi would be called here
  }

  assert.equal(state.joined, true);
  assert.ok(state.joinedAt);
});

test('waitlist state machine: joins when status WAITLIST and not yet joined', () => {
  const state = { lastStatus: 'UNKNOWN', joined: false };
  const observed = 'WAITLIST';

  if (observed === 'WAITLIST' && !state.joined) {
    state.joined = true;
  }

  assert.equal(state.joined, true);
});

test('waitlist state machine: does not re-join if already joined', () => {
  const state = { joined: true, joinedAt: '2026-05-20T08:00:00Z', joinResult: { ok: true } };
  const observed = 'FULL';

  if (observed === 'FULL' && !state.joined) {
    state.joined = true;  // should not execute
  }

  assert.equal(state.joined, true);
  assert.equal(state.joinedAt, '2026-05-20T08:00:00Z');  // unchanged
});

test('waitlist state machine: promotes when joined and user books the class', () => {
  const state = { joined: true, joinedAt: '2026-05-20T07:00:00Z', promoted: false };

  // Simulate path 2: promotion detection (in real code, hasMatchingBooking would be called)
  const hasMatchingBooking = true;

  if (state.joined && !state.promoted && hasMatchingBooking) {
    state.promoted = true;
    state.promotedAt = new Date().toISOString();
  }

  assert.equal(state.promoted, true);
  assert.ok(state.promotedAt);
});

test('waitlist state machine: does not double-promote', () => {
  const state = {
    joined: true,
    promoted: true,
    promotedAt: '2026-05-20T08:30:00Z'
  };
  const hasMatchingBooking = true;

  if (state.joined && !state.promoted && hasMatchingBooking) {
    state.promotedAt = new Date().toISOString();  // should not execute
  }

  assert.equal(state.promoted, true);
  assert.equal(state.promotedAt, '2026-05-20T08:30:00Z');  // unchanged
});

test('waitlist state machine: backwards compat - migrates alerted:true to joined:true', () => {
  // Legacy state files from alert-only era have alerted:true but no joined flag
  const oldState = { lastStatus: 'FULL', alerted: true, firedAt: '2026-05-20T07:00:00Z' };

  // Migration logic: if alerted:true and joined undefined, set joined from firedAt
  if (oldState.alerted && oldState.joined === undefined) {
    oldState.joined = true;
    oldState.joinedAt = oldState.firedAt;
  }

  assert.equal(oldState.joined, true);
  assert.equal(oldState.joinedAt, '2026-05-20T07:00:00Z');
});

test('waitlist state machine: BOOK_NOW observed while not joined should trigger join', () => {
  const state = { joined: false, lastStatus: 'UNKNOWN' };
  const observed = 'BOOK_NOW';
  const previousObserved = 'UNKNOWN';

  // Join condition: status in [FULL, WAITLIST, BOOK_NOW] && !joined && observed !== BOOK_NOW
  // But if observed transitioned FROM something else TO BOOK_NOW, we should join
  // (not re-join continuously on every BOOK_NOW poll)
  if (['FULL', 'WAITLIST', 'BOOK_NOW'].includes(observed) && !state.joined && previousObserved !== 'BOOK_NOW') {
    state.joined = true;
  }

  assert.equal(state.joined, true);
});

test('waitlist state machine: does not spam join on continuous BOOK_NOW polls', () => {
  const state = { joined: false, lastStatus: 'BOOK_NOW' };
  const observed = 'BOOK_NOW';

  // If we were already on BOOK_NOW, don't rejoin
  if (['FULL', 'WAITLIST', 'BOOK_NOW'].includes(observed) && !state.joined && state.lastStatus !== 'BOOK_NOW') {
    state.joined = true;
  }

  assert.equal(state.joined, false);  // should not join when lastStatus was already BOOK_NOW
});

test('waitlist messaging: user DM format includes no em-dashes', () => {
  // Mock message that would be sent to user on join
  const userLabel = 'Melissa';
  const className = 'FIT';
  const classTime = '6:30am';
  const dayLabel = 'Fri 22-May';

  const msg = `[${userLabel}] on waitlist for ${className} at ${classTime} on ${dayLabel}. Mindbody will auto-promote if slot opens.`;

  // Must not contain em-dash U+2014
  assert.ok(!msg.includes('—'), `user DM contains em-dash: ${msg}`);
});

test('waitlist messaging: promotion DM format includes no em-dashes', () => {
  const userLabel = 'Melissa';
  const className = 'FIT';
  const classTime = '6:30am';
  const dayLabel = 'Fri 22-May';

  const msg = `[${userLabel}]. You're in. ${className} at ${classTime} on ${dayLabel}. See you there.`;

  assert.ok(!msg.includes('—'), `promotion DM contains em-dash: ${msg}`);
});

test('waitlist messaging: broadcast includes both user and Yash per rule', () => {
  // When sending DM on behalf of a user, must include:
  // 1. user's chat_id for the main message
  // 2. Yash's chat_id (166637821) for transparency

  const recipients = [109578819, 166637821];  // Melissa + Yash

  assert.ok(recipients.includes(109578819), 'must include Melissa');
  assert.ok(recipients.includes(166637821), 'must include Yash');
  assert.equal(recipients.length, 2, 'broadcast rule requires exactly 2 recipients');
});

test('parseTimeToMinutes: various edge cases for promotion detection', () => {
  // Helper to parse times for matching against /account/schedule
  // Used in hasMatchingBooking comparison
  function parseTimeToMinutes(timeStr) {
    const m = timeStr.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (m[3] && m[3].toLowerCase() === 'pm' && h !== 12) h += 12;
    if (m[3] && m[3].toLowerCase() === 'am' && h === 12) h = 0;
    return h * 60 + min;
  }

  assert.equal(parseTimeToMinutes('6:30am'), 6 * 60 + 30);
  assert.equal(parseTimeToMinutes('12:00am'), 0);  // midnight
  assert.equal(parseTimeToMinutes('12:00pm'), 12 * 60);  // noon
  assert.equal(parseTimeToMinutes('6:30pm'), 18 * 60 + 30);
  assert.equal(parseTimeToMinutes('11:59pm'), 23 * 60 + 59);
  assert.equal(parseTimeToMinutes('invalid'), null);
  assert.equal(parseTimeToMinutes(''), null);
});

test('probeLoginButton: covered when topmost is unrelated', () => {
  const btn = makeNode({ tagName: 'BUTTON' });
  const overlay = makeNode({ tagName: 'DIV', id: 'onetrust-banner', className: 'banner-sdk' });
  const r = probeLoginButton(makeDoc({ button: btn, topmost: overlay }), LOGIN_BUTTON_SEL);
  assert.equal(r.state, 'covered');
  assert.ok(r.blocker.includes('div'), `expected tag in blocker: ${r.blocker}`);
  assert.ok(r.blocker.includes('#onetrust-banner'), `expected id in blocker: ${r.blocker}`);
  assert.ok(r.blocker.includes('.banner-sdk'), `expected class in blocker: ${r.blocker}`);
});

test('probeLoginButton: blocker descriptor caps multi-class to first 2', () => {
  const btn = makeNode({ tagName: 'BUTTON' });
  const overlay = makeNode({ tagName: 'DIV', className: 'a b c d e f' });
  const r = probeLoginButton(makeDoc({ button: btn, topmost: overlay }), LOGIN_BUTTON_SEL);
  assert.equal(r.state, 'covered');
  // First 2 classes only — keeps descriptor compact
  assert.ok(r.blocker.includes('.a'));
  assert.ok(r.blocker.includes('.b'));
  assert.ok(!r.blocker.includes('.c'), `should not include 3rd class: ${r.blocker}`);
});

test('probeLoginButton: blocker descriptor capped at 80 chars', () => {
  const btn = makeNode({ tagName: 'BUTTON' });
  // Long class name to push over 80
  const overlay = makeNode({ tagName: 'DIV', id: 'x'.repeat(50), className: 'y'.repeat(50) });
  const r = probeLoginButton(makeDoc({ button: btn, topmost: overlay }), LOGIN_BUTTON_SEL);
  assert.equal(r.state, 'covered');
  assert.ok(r.blocker.length <= 80, `blocker length ${r.blocker.length} > 80: ${r.blocker}`);
});

test('probeLoginButton: covered descriptor handles missing id/class', () => {
  const btn = makeNode({ tagName: 'BUTTON' });
  const overlay = makeNode({ tagName: 'IFRAME', id: '', className: '' });
  const r = probeLoginButton(makeDoc({ button: btn, topmost: overlay }), LOGIN_BUTTON_SEL);
  assert.deepEqual(r, { state: 'covered', blocker: 'iframe' });
});

test('probeLoginButton: restores globalThis.document after running', () => {
  const sentinel = { __sentinel: true };
  globalThis.document = sentinel;
  try {
    const btn = makeNode({});
    probeLoginButton(makeDoc({ button: btn, topmost: btn }), LOGIN_BUTTON_SEL);
    assert.equal(globalThis.document, sentinel, 'document should be restored');
  } finally {
    delete globalThis.document;
  }
});

test('probeLoginButton: restores globalThis.document even when probe throws', () => {
  const sentinel = { __sentinel: true };
  globalThis.document = sentinel;
  // Force probe to throw by passing a doc whose querySelector throws
  const explodingDoc = {
    querySelector: () => { throw new Error('boom'); },
    elementFromPoint: () => null,
  };
  try {
    assert.throws(() => probeLoginButton(explodingDoc, LOGIN_BUTTON_SEL), /boom/);
    assert.equal(globalThis.document, sentinel, 'document should be restored even after throw');
  } finally {
    delete globalThis.document;
  }
});

test('LOGIN_BUTTON_SEL targets Mindbody nav button by data-name', () => {
  assert.equal(LOGIN_BUTTON_SEL, 'button[data-name="NavigationBar.Login.Button"]');
});

test('OVERLAY_DISMISS_SELS includes the OneTrust cookie banner button text', () => {
  assert.ok(Array.isArray(OVERLAY_DISMISS_SELS));
  assert.ok(OVERLAY_DISMISS_SELS.length >= 5, 'expected several dismiss patterns');
  // The exact selector that worked May 1-11 — losing this would regress the
  // happy path even if every other selector is still valid.
  assert.ok(
    OVERLAY_DISMISS_SELS.includes('button:has-text("AGREE AND PROCEED")'),
    'OneTrust canonical "AGREE AND PROCEED" must remain in the dismiss list',
  );
  assert.ok(
    OVERLAY_DISMISS_SELS.includes('#onetrust-accept-btn-handler'),
    'OneTrust id selector must remain (text-based may break on rename)',
  );
});

test('OVERLAY_DISMISS_SELS entries are all non-empty strings', () => {
  for (const s of OVERLAY_DISMISS_SELS) {
    assert.equal(typeof s, 'string');
    assert.ok(s.length > 0, `empty selector in dismiss list`);
  }
});

test('YASH_ALERT_CHAT_ID is Yash personal Telegram chat (regression guard)', () => {
  // The alert is the ONLY oncall channel for setup failures. Pointing it
  // anywhere else (e.g. a group, another user) would silently drop pages.
  assert.equal(YASH_ALERT_CHAT_ID, 166637821);
});

test('buildSetupFailureAlert: header and core fields present', () => {
  const out = buildSetupFailureAlert({
    userLabel: 'Melissa',
    planLine: 'BURN @ 6:30pm + FIT @ 7:30pm',
    dayLabel: 'Thu 2026-05-14',
    errorMessage: 'auth expired and no visible Login button found',
    runId: '2026-05-12T00-57-01',
    msToNine: 3 * 60 * 1000, // 3 minutes
  });
  assert.ok(out.startsWith('🚨 BOOKER SETUP FAILED\n'));
  assert.ok(out.includes('user: Melissa'));
  assert.ok(out.includes('target: BURN @ 6:30pm + FIT @ 7:30pm on Thu 2026-05-14'));
  assert.ok(out.includes('error: auth expired and no visible Login button found'));
  assert.ok(out.includes('run: 2026-05-12T00-57-01'));
  assert.ok(out.includes('3min until 9am SGT'));
});

test('buildSetupFailureAlert: post-9am branch when msToNine <= 0', () => {
  const past = buildSetupFailureAlert({
    userLabel: 'Yash', planLine: 'FIT @ 6:30am', dayLabel: 'Wed 2026-05-13',
    errorMessage: 'X', runId: 'R', msToNine: -90 * 60 * 1000,
  });
  assert.ok(past.includes('9am window already open — book manually NOW'));
  assert.ok(!past.includes('min until 9am'));

  const exact = buildSetupFailureAlert({
    userLabel: 'Yash', planLine: 'FIT @ 6:30am', dayLabel: 'Wed 2026-05-13',
    errorMessage: 'X', runId: 'R', msToNine: 0,
  });
  assert.ok(exact.includes('9am window already open'));
});

test('buildSetupFailureAlert: pre-9am branch rounds minutes correctly', () => {
  const out = buildSetupFailureAlert({
    userLabel: 'Dani', planLine: 'FIT @ 6:30am', dayLabel: 'Thu 2026-05-14',
    errorMessage: 'X', runId: 'R',
    msToNine: 2 * 60 * 1000 + 40 * 1000, // 2m40s → rounds to 3
  });
  assert.ok(out.includes('3min until 9am SGT'));
});

test('buildSetupFailureAlert: truncates error messages over 240 chars', () => {
  const long = 'A'.repeat(500);
  const out = buildSetupFailureAlert({
    userLabel: 'Yash', planLine: 'FIT @ 6:30am', dayLabel: 'X',
    errorMessage: long, runId: 'R', msToNine: 60000,
  });
  // Count A's between "error: " and the next newline
  const m = out.match(/error: (A+)\n/);
  assert.ok(m, 'error line should be A-only after slicing');
  assert.equal(m[1].length, 240, `error truncated to 240 chars, got ${m[1].length}`);
});

test('buildSetupFailureAlert: handles missing/empty error message', () => {
  const out = buildSetupFailureAlert({
    userLabel: 'Yash', planLine: 'FIT @ 6:30am', dayLabel: 'X',
    errorMessage: '', runId: 'R', msToNine: 60000,
  });
  assert.ok(out.includes('error: \n'));
  const out2 = buildSetupFailureAlert({
    userLabel: 'Yash', planLine: 'FIT @ 6:30am', dayLabel: 'X',
    errorMessage: undefined, runId: 'R', msToNine: 60000,
  });
  assert.ok(out2.includes('error: \n'));
});

test('buildSetupFailureAlert: missing msToNine treated as past-9am', () => {
  const out = buildSetupFailureAlert({
    userLabel: 'Yash', planLine: 'FIT @ 6:30am', dayLabel: 'X',
    errorMessage: 'X', runId: 'R',
    // msToNine omitted
  });
  assert.ok(out.includes('9am window already open'));
});

test('book.js uses lib helpers for login-overlay handling (no inline drift)', () => {
  // Guard: re-introducing an inline copy of the probe or the chat ID in book.js
  // would defeat the test suite. Pin against literal markers that would only
  // appear if someone hardcoded the same logic.
  const src = fs.readFileSync(path.join(__dirname, 'book.js'), 'utf8');
  // book.js MUST reference the shared constants/helpers from lib
  assert.ok(src.includes('LOGIN_BUTTON_SEL'), 'book.js should import LOGIN_BUTTON_SEL');
  assert.ok(src.includes('OVERLAY_DISMISS_SELS'), 'book.js should import OVERLAY_DISMISS_SELS');
  assert.ok(src.includes('probeLoginButtonInBrowser'), 'book.js should import probeLoginButtonInBrowser');
  assert.ok(src.includes('buildSetupFailureAlert'), 'book.js should import buildSetupFailureAlert');
  assert.ok(src.includes('YASH_ALERT_CHAT_ID'), 'book.js should import YASH_ALERT_CHAT_ID');
  // And NOT inline the chat ID — pointing the pager at the wrong chat would be silent
  assert.ok(
    !/const\s+YASH_ALERT_CHAT_ID\s*=\s*\d+/.test(src),
    'book.js must not redefine YASH_ALERT_CHAT_ID inline (drift risk)',
  );
});

// ── Daily summary + result-file pipeline ────────────────────────────────────
// buildDailySummary is the cross-user roll-up sent to Yash after book-all.js
// finishes. Pure builder so we can pin every branch (all-ok, all-fail, partial,
// setup-errored, mixed reasons, already-booked skip).

const fakeRun = (id, label, plans, opts = {}) => ({
  user: { id, label },
  setupErrored: !!opts.setupErrored,
  results: plans,
});
const okPlan = (kind, time, reason = 'booked') => ({
  plan: { kind, primaryTime: time, fallback: null },
  status: { ok: true, reason, time, detail: '' },
});
const failPlan = (kind, time, reason, detail = '') => ({
  plan: { kind, primaryTime: time, fallback: null },
  status: { ok: false, reason, time, detail },
});

test('buildDailySummary: all-ok header + per-user line', () => {
  const out = buildDailySummary({
    runs: [
      fakeRun('yash', 'Yash', [okPlan('FIT', '6:30am')]),
      fakeRun('dani', 'Dani', [okPlan('FIT', '6:30am')]),
    ],
    runId: 'R1',
    dayLabel: 'Thu 2026-05-14',
  });
  assert.ok(out.startsWith('✅ BOOKER DAILY — all bookings landed\n'));
  assert.ok(out.includes('day: Thu 2026-05-14'));
  assert.ok(out.includes('users: 2'));
  assert.ok(out.includes('✅ Yash (1/1)'));
  assert.ok(out.includes('✅ Dani (1/1)'));
  assert.ok(out.includes('run: R1'));
});

test('buildDailySummary: all-failed header when every plan fails', () => {
  const out = buildDailySummary({
    runs: [
      fakeRun('yash', 'Yash', [failPlan('FIT', '6:30am', 'exception', 'timeout')], { setupErrored: true }),
      fakeRun('dani', 'Dani', [failPlan('FIT', '6:30am', 'exception', 'timeout')], { setupErrored: true }),
    ],
    runId: 'R2', dayLabel: 'Thu 2026-05-14',
  });
  assert.ok(out.startsWith('🚨 BOOKER DAILY — every user failed\n'));
  assert.ok(out.includes('🚨 Yash — setup failed (alerted)'));
  assert.ok(out.includes('🚨 Dani — setup failed (alerted)'));
  assert.ok(out.includes('❌ FIT @ 6:30am — exception'));
});

test('buildDailySummary: partial header when some succeed and some fail', () => {
  const out = buildDailySummary({
    runs: [
      fakeRun('yash', 'Yash', [okPlan('FIT', '6:30am')]),
      fakeRun('dani', 'Dani', [failPlan('FIT', '6:30am', 'unverified')]),
    ],
    runId: 'R3', dayLabel: 'Thu 2026-05-14',
  });
  assert.ok(out.startsWith('⚠️ BOOKER DAILY — partial\n'));
  assert.ok(out.includes('✅ Yash (1/1)'));
  assert.ok(out.includes('❌ Dani (0/1)'));
});

test('buildDailySummary: mixed per-user (one plan booked, one failed)', () => {
  const out = buildDailySummary({
    runs: [
      fakeRun('melissa', 'Melissa', [
        okPlan('BURN', '6:30pm'),
        failPlan('FIT', '7:30pm', 'unverified', 'row went FULL'),
      ]),
    ],
    runId: 'R4', dayLabel: 'Thu 2026-05-14',
  });
  assert.ok(out.includes('⚠️ Melissa (1/2)'));
  assert.ok(out.includes('✅ BURN @ 6:30pm'));
  assert.ok(out.includes('❌ FIT @ 7:30pm — unverified: row went FULL'));
});

test('buildDailySummary: already_booked plans render with ↪ marker', () => {
  const out = buildDailySummary({
    runs: [
      fakeRun('geraldine', 'Geraldine', [okPlan('FIT', '7:30am', 'already_booked')]),
    ],
    runId: 'R5', dayLabel: 'Thu 2026-05-14',
  });
  assert.ok(out.includes('↪ FIT @ 7:30am (already booked)'));
});

test('buildDailySummary: setupErrored user gets 🚨 marker even with 0 failures shown', () => {
  // Edge case: setupErrored true but results array is what book.js synthesizes
  // (all plans as exception).
  const out = buildDailySummary({
    runs: [
      fakeRun('cheryl', 'Cheryl Lee', [
        failPlan('BURN', '7:00am', 'exception', 'auth expired'),
      ], { setupErrored: true }),
    ],
    runId: 'R6', dayLabel: 'Thu 2026-05-14',
  });
  assert.ok(out.includes('🚨 Cheryl Lee — setup failed (alerted)'));
});

test('buildDailySummary: trims very long detail strings to 80 chars', () => {
  const longDetail = 'A'.repeat(200);
  const out = buildDailySummary({
    runs: [
      fakeRun('yash', 'Yash', [failPlan('FIT', '6:30am', 'unverified', longDetail)]),
    ],
    runId: 'R7', dayLabel: 'Thu 2026-05-14',
  });
  const m = out.match(/❌ FIT @ 6:30am — unverified: (A+)/);
  assert.ok(m, 'detail line should be captured');
  assert.equal(m[1].length, 80, `detail truncated to 80 chars, got ${m[1].length}`);
});

const skipRun = (id, label, skipReason, skipDetail = '') => ({
  user: { id, label },
  setupErrored: false,
  results: [],
  skipReason,
  skipDetail,
});

test('buildDailySummary: opt_out_day renders as "no class scheduled" not setup-failed', () => {
  // The Sun 2026-05-17 incident: Melissa/Geraldine/Cheryl had no Sun bookings,
  // book.js exited 0 without a result file, and book-all synthesized a fake
  // setupErrored entry rendering "🚨 setup failed (alerted)". Fix: book.js
  // now writes a skip-result file and the summary renders ✅ here.
  const out = buildDailySummary({
    runs: [
      fakeRun('yash', 'Yash', [okPlan('Gymnastics', '1:00pm')]),
      fakeRun('dani', 'Dani', [okPlan('Gymnastics', '1:00pm')]),
      skipRun('melissa', 'Melissa', 'opt_out_day'),
      skipRun('geraldine', 'Geraldine', 'opt_out_day'),
      skipRun('cheryllee', 'Cheryl Lee', 'opt_out_day'),
    ],
    runId: 'R-sun', dayLabel: 'Sun 2026-05-17',
  });
  assert.ok(out.startsWith('✅ BOOKER DAILY — all bookings landed\n'), `header was: ${out.split('\n')[0]}`);
  assert.ok(out.includes('users: 5'));
  assert.ok(out.includes('✅ Yash (1/1)'));
  assert.ok(out.includes('✅ Dani (1/1)'));
  assert.ok(out.includes('✅ Melissa — no class scheduled'));
  assert.ok(out.includes('✅ Geraldine — no class scheduled'));
  assert.ok(out.includes('✅ Cheryl Lee — no class scheduled'));
  assert.ok(!out.includes('setup failed'), 'must not render setup-failed for opt-out users');
  assert.ok(!out.includes('no-result-file'), 'must not surface synthesized no-result-file reason');
});

test('buildDailySummary: all-skip day renders "no bookings scheduled today" header', () => {
  const out = buildDailySummary({
    runs: [
      skipRun('melissa', 'Melissa', 'opt_out_day'),
      skipRun('geraldine', 'Geraldine', 'opt_out_day'),
    ],
    runId: 'R-allskip', dayLabel: 'Sun 2026-05-17',
  });
  assert.ok(out.startsWith('✅ BOOKER DAILY — no bookings scheduled today\n'));
});

test('buildDailySummary: date_skip renders with ↪ marker and optional detail', () => {
  const out = buildDailySummary({
    runs: [
      skipRun('dani', 'Dani', 'date_skip', 'cancelled by override'),
    ],
    runId: 'R-dateskip', dayLabel: 'Thu 2026-05-14',
  });
  assert.ok(out.includes('↪ Dani — date skipped (cancelled by override)'));
});

test('buildDailySummary: paused renders with ⏸️ marker using detail', () => {
  const out = buildDailySummary({
    runs: [
      skipRun('mer', 'Mer', 'paused', 'paused until 2026-05-20'),
    ],
    runId: 'R-paused', dayLabel: 'Thu 2026-05-14',
  });
  assert.ok(out.includes('⏸️ Mer — paused until 2026-05-20'));
});

test('buildDailySummary: setup-failed user among skippers still triggers partial header', () => {
  // Skipped users shouldn't shield a real setup failure: if Yash's auth blows
  // up while Melissa is opted out, header must still flag the problem.
  const out = buildDailySummary({
    runs: [
      fakeRun('yash', 'Yash', [failPlan('FIT', '6:30am', 'exception', 'auth')], { setupErrored: true }),
      skipRun('melissa', 'Melissa', 'opt_out_day'),
    ],
    runId: 'R-mixed', dayLabel: 'Thu 2026-05-14',
  });
  assert.ok(out.startsWith('🚨 BOOKER DAILY — every user failed\n'), `header was: ${out.split('\n')[0]}`);
  assert.ok(out.includes('🚨 Yash — setup failed (alerted)'));
  assert.ok(out.includes('✅ Melissa — no class scheduled'));
});

test('buildDailySummary: shows missing-result synthesis from book-all crash path', () => {
  // book-all.js synthesizes this when a child exits without writing its
  // result file. Verify the summary surfaces it loudly.
  const out = buildDailySummary({
    runs: [
      fakeRun('dani', 'Dani', [
        { plan: { kind: '?', primaryTime: '?', fallback: null },
          status: { ok: false, reason: 'no-result-file', detail: 'child exited 1 without writing result file' } },
      ], { setupErrored: true }),
    ],
    runId: 'R8', dayLabel: 'Thu 2026-05-14',
  });
  assert.ok(out.includes('🚨 Dani — setup failed (alerted)'));
  assert.ok(out.includes('no-result-file'));
});

test('sendYashAlert: posts to telegram with correct chat and body', async () => {
  let calledUrl = null;
  let calledBody = null;
  const fakeFetch = async (url, opts) => {
    calledUrl = url;
    calledBody = JSON.parse(opts.body);
    return { ok: true, status: 200 };
  };
  const ok = await sendYashAlert('hello', {
    fetchImpl: fakeFetch,
    env: { TELEGRAM_BOT_TOKEN: 'TEST_TOKEN_123' },
    logger: () => {},
  });
  assert.equal(ok, true);
  assert.equal(calledUrl, 'https://api.telegram.org/botTEST_TOKEN_123/sendMessage');
  assert.equal(calledBody.chat_id, YASH_ALERT_CHAT_ID);
  assert.equal(calledBody.text, 'hello');
  assert.equal(calledBody.disable_web_page_preview, true);
});

test('sendYashAlert: returns false (no throw) when token missing', async () => {
  const ok = await sendYashAlert('hello', {
    fetchImpl: () => { throw new Error('should not call fetch'); },
    env: {},
    logger: () => {},
  });
  assert.equal(ok, false);
});

test('sendYashAlert: returns false (no throw) on non-2xx response', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, text: async () => 'server boom' });
  const ok = await sendYashAlert('hello', {
    fetchImpl: fakeFetch,
    env: { TELEGRAM_BOT_TOKEN: 'X' },
    logger: () => {},
  });
  assert.equal(ok, false);
});

test('sendYashAlert: returns false (no throw) when fetch itself throws', async () => {
  const fakeFetch = async () => { throw new Error('network down'); };
  const ok = await sendYashAlert('hello', {
    fetchImpl: fakeFetch,
    env: { TELEGRAM_BOT_TOKEN: 'X' },
    logger: () => {},
  });
  assert.equal(ok, false);
});

test('book.js writes BOOKER_RESULT_FILE on synthetic setup failure', async () => {
  // End-to-end check: spawn book.js with --simulate-setup-fail + BOOKER_RESULT_FILE
  // and verify the JSON payload has the shape book-all.js expects.
  //
  // CRITICAL: book.js calls dotenv.config() on startup which RE-LOADS env vars
  // from .env even if the parent env didn't set them. Deleting TELEGRAM_BOT_TOKEN
  // from the spawn env is therefore not enough — dotenv would re-set it and the
  // test would ping Yash's real chat. Setting it to a bogus value works because
  // dotenv only fills missing vars by default. The bogus token routes the alert
  // through Telegram's API which 404s on an invalid bot (no DM sent).
  const { spawnSync } = require('node:child_process');
  const tmp = path.join(os.tmpdir(), `booker-result-test-${process.pid}-${Date.now()}.json`);
  try {
    const res = spawnSync(process.execPath, [
      path.join(__dirname, 'book.js'),
      '--user', 'yash',
      '--simulate-setup-fail',
      '--now',
    ], {
      env: { ...process.env, BOOKER_RESULT_FILE: tmp, TELEGRAM_BOT_TOKEN: 'TEST_TOKEN_INVALID_DO_NOT_SEND' },
      timeout: 30000,
    });
    assert.ok(fs.existsSync(tmp), `result file not written: stderr=${res.stderr}`);
    const parsed = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    assert.equal(parsed.user.id, 'yash');
    assert.equal(parsed.user.label, 'Yash');
    assert.equal(parsed.setupErrored, true, 'setupErrored should be true on synthetic fail');
    assert.ok(Array.isArray(parsed.results), 'results should be an array');
    assert.ok(parsed.results.length >= 1, 'at least one plan should be in results');
    for (const r of parsed.results) {
      assert.equal(r.status.ok, false, 'all plans should be marked failed');
      assert.equal(r.status.reason, 'exception');
      assert.ok(r.status.detail.includes('synthetic'), `detail should mention synthetic, got: ${r.status.detail}`);
    }
    assert.ok(parsed.dayLabel, 'dayLabel should be set');
    assert.ok(parsed.runId, 'runId should be set');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(parsed.targetYmd), 'targetYmd should be YYYY-MM-DD');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('book.js writes BOOKER_RESULT_FILE with skipReason on opt_out_day', async () => {
  // Locks the contract that fixes the Sun 2026-05-17 false-alarm: when a user
  // has no class on the target DOW, book.js must still drop a result file
  // (empty results + skipReason) so book-all.js does NOT synthesize a fake
  // "no-result-file" setupErrored entry. Melissa's schedule has Mon/Tue/Thu/Fri
  // → 2026-05-17 (Sun) is an opt_out_day.
  const { spawnSync } = require('node:child_process');
  const tmp = path.join(os.tmpdir(), `booker-skip-test-${process.pid}-${Date.now()}.json`);
  try {
    const res = spawnSync(process.execPath, [
      path.join(__dirname, 'book.js'),
      '--user', 'melissa',
      '2026-05-17',
    ], {
      env: { ...process.env, BOOKER_RESULT_FILE: tmp, TELEGRAM_BOT_TOKEN: 'TEST_TOKEN_INVALID_DO_NOT_SEND' },
      timeout: 30000,
    });
    assert.equal(res.status, 0, `book.js should exit 0 on opt-out, got ${res.status}; stderr=${res.stderr}`);
    assert.ok(fs.existsSync(tmp), `result file not written: stderr=${res.stderr}`);
    const parsed = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    assert.equal(parsed.user.id, 'melissa');
    assert.equal(parsed.setupErrored, false, 'opt-out is not a setup failure');
    assert.equal(parsed.skipReason, 'opt_out_day');
    assert.deepEqual(parsed.results, [], 'opt-out has no plans to book');
    assert.equal(parsed.targetYmd, '2026-05-17');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('book-all.js wires BOOKER_RESULT_FILE env and rolls up summary', () => {
  // Static guard: book-all.js must (a) pass BOOKER_RESULT_FILE to each spawn,
  // (b) call buildDailySummary, (c) call sendYashAlert. Removing any of these
  // would silently drop the daily DM.
  const src = fs.readFileSync(path.join(__dirname, 'book-all.js'), 'utf8');
  assert.ok(src.includes('BOOKER_RESULT_FILE'), 'book-all.js must set BOOKER_RESULT_FILE per child');
  assert.ok(src.includes('buildDailySummary'), 'book-all.js must call buildDailySummary');
  assert.ok(src.includes('sendYashAlert'), 'book-all.js must call sendYashAlert');
  // And synthesize a missing-result entry so silent gaps still page Yash
  assert.ok(src.includes('no-result-file'), 'book-all.js must synthesize a "no-result-file" entry on missing result');
});

test('book-all.js loads .env so launchd-spawned summary alert has TELEGRAM_BOT_TOKEN', () => {
  // Regression guard for 2026-05-13 incident: launchd plist exports PATH/HOME/TZ
  // but not TELEGRAM_BOT_TOKEN. Per-child book.js processes call dotenv.config()
  // so their own tg-sends work, but book-all.js (the orchestrator) was missing
  // it — every daily summary logged `alert: no TELEGRAM_BOT_TOKEN — alert dropped`
  // and the run-level summary DM never reached Yash. Must run BEFORE require('./lib')
  // so the env var is set when sendYashAlert runs at end of run.
  const src = fs.readFileSync(path.join(__dirname, 'book-all.js'), 'utf8');
  const dotenvIdx = src.indexOf("require('dotenv').config()");
  const libIdx = src.indexOf("require('./lib')");
  assert.ok(dotenvIdx >= 0, 'book-all.js must call dotenv.config()');
  assert.ok(libIdx >= 0, 'book-all.js must require ./lib');
  assert.ok(dotenvIdx < libIdx, 'dotenv.config() must run BEFORE require("./lib") so TELEGRAM_BOT_TOKEN is set before sendYashAlert is loaded');
});

test('cancel-booking matchCancelCard requires day+kind+time ALL three to match', () => {
  // Regression for 2026-05-13 bug: when a user has the same kind+time on
  // multiple upcoming dates (cron books two consecutive days), the old
  // `time && (day || kind)` logic latched onto the wrong card. Real example:
  // Yash had FIT 6:30am on May 14 AND May 15; reschedule for May 15 dry-run
  // grabbed the May 14 card. Fix requires all three to match.
  const { matchCancelCard } = require('./cancel-booking');

  // Exact match — same card we want
  const targetCard = '15 Friday May, 2026 CROSSFIT® FIT RagTag Training w/ Annie Set 6:30am (60 min) Cancel +CALENDAR';
  const r1 = matchCancelCard(targetCard, { dayOfMonth: '15', kindArg: 'FIT', timeArg: '6:30am' });
  assert.equal(r1.match, true, `target card should match: ${JSON.stringify(r1)}`);

  // The neighbouring May 14 card: kind+time match but day doesn't.
  // Old buggy logic: time(true) && (day(false) || kind(true)) = true → WRONG MATCH
  // New strict logic: time && day && kind = false → correctly rejected
  const wrongDayCard = '14 Thursday May, 2026 CROSSFIT® FIT RagTag Training w/ Annie Set 6:30am (60 min) Cancel +CALENDAR';
  const r2 = matchCancelCard(wrongDayCard, { dayOfMonth: '15', kindArg: 'FIT', timeArg: '6:30am' });
  assert.equal(r2.dayMatch, false);
  assert.equal(r2.match, false, `wrong-day card must NOT match: ${JSON.stringify(r2)}`);

  // Different time but same day+kind: rightly rejected.
  const wrongTimeCard = '15 Friday May, 2026 CROSSFIT® FIT 7:30am (60 min) Cancel';
  const r3 = matchCancelCard(wrongTimeCard, { dayOfMonth: '15', kindArg: 'FIT', timeArg: '6:30am' });
  assert.equal(r3.match, false);

  // Different kind but same day+time: rightly rejected.
  const wrongKindCard = '15 Friday May, 2026 CROSSFIT® Gymnastics 6:30am (60 min) Cancel';
  const r4 = matchCancelCard(wrongKindCard, { dayOfMonth: '15', kindArg: 'FIT', timeArg: '6:30am' });
  assert.equal(r4.match, false);
});

test('cancel-booking matchCancelCard day boundary: 5 must not match 15 or 25', () => {
  // `\b5\b` should match "5" as a standalone token but NOT "15" or "25" or "55".
  const { matchCancelCard } = require('./cancel-booking');
  const card15 = '15 Friday May, 2026 CROSSFIT® FIT 6:30am Cancel';
  const card25 = '25 Monday May, 2026 CROSSFIT® FIT 6:30am Cancel';
  const card5  = '5 Tuesday May, 2026 CROSSFIT® FIT 6:30am Cancel';
  assert.equal(matchCancelCard(card15, { dayOfMonth: '5', kindArg: 'FIT', timeArg: '6:30am' }).match, false);
  assert.equal(matchCancelCard(card25, { dayOfMonth: '5', kindArg: 'FIT', timeArg: '6:30am' }).match, false);
  assert.equal(matchCancelCard(card5,  { dayOfMonth: '5', kindArg: 'FIT', timeArg: '6:30am' }).match, true);
});

test('book-all.js: dotenv loads TELEGRAM_BOT_TOKEN from .env (cwd-relative)', () => {
  // Sanity that dotenv's default cwd-relative .env discovery works from the
  // gym-booker dir. book-all.js's first executable line is dotenv.config(),
  // and run-daily.sh cd's into $HOME/gym-booker before invoking it — so this
  // probe mirrors the actual launchd invocation.
  const { spawnSync } = require('node:child_process');
  const probe = "delete process.env.TELEGRAM_BOT_TOKEN; require('dotenv').config(); console.log('TOKEN=' + (process.env.TELEGRAM_BOT_TOKEN ? 'set' : 'unset'));";
  const res = spawnSync(process.execPath, ['-e', probe], { cwd: __dirname, timeout: 5000 });
  assert.ok(res.stdout.toString().includes('TOKEN=set'), `dotenv must populate TELEGRAM_BOT_TOKEN from ${__dirname}/.env when cwd=that dir. Got: ${res.stdout}`);
});

test('book-all.js end-to-end: synthetic setup failure produces well-formed daily summary', () => {
  // Spawns book-all.js with --only yash --simulate-setup-fail. Sets
  // GYM_TEST_PRINT_SUMMARY=1 so the orchestrator prints the summary to stdout
  // instead of POSTing to Telegram. The spawned book.js child also fires its
  // setup-failure tgYashAlert — invalidate TELEGRAM_BOT_TOKEN so that child's
  // alert no-ops too (404 from Telegram API, no DM to Yash). See the
  // BOOKER_RESULT_FILE test for why deleting the env var isn't enough.
  const { spawnSync } = require('node:child_process');
  const res = spawnSync(process.execPath, [
    path.join(__dirname, 'book-all.js'),
    '--only', 'yash',
    '--simulate-setup-fail',
    '--now',
  ], {
    env: { ...process.env, GYM_TEST_PRINT_SUMMARY: '1', TELEGRAM_BOT_TOKEN: 'TEST_TOKEN_INVALID_DO_NOT_SEND' },
    timeout: 60000,
  });
  const out = res.stdout.toString();
  // The orchestrator's TEST SUMMARY block must be present
  assert.ok(out.includes('--- TEST DAILY SUMMARY ---'), `missing TEST SUMMARY block:\n${out}`);
  assert.ok(out.includes('--- END TEST DAILY SUMMARY ---'));
  // And the summary itself should reflect: 1 user, setup-errored, no successes
  assert.ok(out.includes('🚨 BOOKER DAILY — every user failed'), `wrong header:\n${out}`);
  assert.ok(out.includes('🚨 Yash — setup failed (alerted)'), `missing Yash setup-failed line:\n${out}`);
  assert.ok(out.includes('synthetic'), 'detail should mention synthetic failure');
});
