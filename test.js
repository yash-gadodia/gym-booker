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
    ['2026-05-01', { kind: 'FIT',        primaryTime: '6:30am',  fallback: '7:30am' }],
    ['2026-04-25', { kind: 'Gymnastics', primaryTime: '12:30pm', fallback: null }],
  ];
  for (const [date, expected] of cases) {
    const got = classPlan(new Date(date));
    assert.deepEqual(got, expected, `${date} (${DAY_SHORT[new Date(date).getDay()]})`);
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
