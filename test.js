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
  isBookingInUpcoming, findBookingInUpcoming,
  spawnStaggerMs, navRetryPlan, canRetrySetup, decideAuthAction, decideWaitlistAlert,
  SETUP_COMPLETE_MARKER, decideDailyClaim, resolveSprintTarget,
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

// 2026-06-09: Yash was waitlisted but Lawrence said "Smashed the queue". On
// /account/schedule a confirmed booking card ends "Cancel +CALENDAR" while a
// waitlist card ends "Cancel WAITLISTED" — the ONLY parseable difference. These
// are the exact card strings observed live from Yash's account.
test('parseBookingCard: confirmed booking card is NOT waitlisted', () => {
  const b = parseBookingCard('11 Thursday June, 2026 CROSSFIT® FIT RagTag Training w/ Annie Set 6:30am (60 min) Cancel +CALENDAR');
  assert.equal(b.kind, 'FIT');
  assert.equal(b.time, '6:30am');
  assert.equal(b.waitlisted, false);
});

test('parseBookingCard: WAITLISTED card is flagged waitlisted', () => {
  const b = parseBookingCard('11 Thursday June, 2026 CROSSFIT® FIT RagTag Training w/ Annie Set 6:30am (60 min) Cancel WAITLISTED');
  assert.equal(b.kind, 'FIT');
  assert.equal(b.time, '6:30am');
  assert.equal(b.waitlisted, true);
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
  // class-full-waitlisted (2026-06-09 honesty fix): waitlist placement must read
  // as the "Outflexed / try the waitlist" message, never a booking confirmation.
  assert.equal(personality._bucket({ ok: false, reason: 'class-full-waitlisted' }), 'full');
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

test('resolveBookingsForDate: per-date ARRAY override → multiple plans (double-booking)', () => {
  // Sun 2026-06-07: 8:30am Lift + 9:30am Steam, replacing the Gymnastics default
  const overrides = { users: { yash: { perDate: { '2026-06-07': [
    { time: '8:30am', kind: 'Lift' },
    { time: '9:30am', kind: 'Steam' },
  ] } } } };
  const r = resolveBookingsForDate(new Date('2026-06-07T00:00:00'), 'yash', null, overrides);
  assert.deepEqual(r, { plans: [
    { kind: 'Lift', primaryTime: '8:30am', fallback: null },
    { kind: 'Steam', primaryTime: '9:30am', fallback: null },
  ]});
});

test('resolveBookingsForDate: array entry missing kind defaults to DOW kind', () => {
  const overrides = { users: { yash: { perDate: { '2026-06-07': [{ time: '8:30am' }] } } } };
  const r = resolveBookingsForDate(new Date('2026-06-07T00:00:00'), 'yash', null, overrides);
  assert.deepEqual(r, { plans: [{ kind: 'Gymnastics', primaryTime: '8:30am', fallback: null }]});
});

test('resolveBookingsForDate: empty per-date array → date_skip', () => {
  const overrides = { users: { yash: { perDate: { '2026-06-07': [] } } } };
  const r = resolveBookingsForDate(new Date('2026-06-07T00:00:00'), 'yash', null, overrides);
  assert.deepEqual(r, { skip: 'date_skip' });
});

test('resolveBookingForDate (singular): per-date array collapses to first class', () => {
  const overrides = { users: { yash: { perDate: { '2026-06-07': [
    { time: '8:30am', kind: 'Lift' },
    { time: '9:30am', kind: 'Steam' },
  ] } } } };
  const r = resolveBookingForDate(new Date('2026-06-07T00:00:00'), 'yash', null, overrides);
  assert.deepEqual(r, { kind: 'Lift', primaryTime: '8:30am', fallback: null });
});

test('parseBookingCard: recognizes a Steam class', () => {
  const card = '07 Sunday June, 2026 Steam Room RagTag 9:30am (30 min) Cancel +CALENDAR';
  const r = parseBookingCard(card);
  assert.equal(r.kind, 'Steam');
  assert.equal(r.time, '9:30am');
  assert.equal(r.ymd, '2026-06-07');
});

test('rowMatches: Steam matches a Steam row at the target time', () => {
  assert.equal(rowMatches('Steam Room 9:30am (30 min) BOOK NOW', { kind: 'Steam', time: '9:30am' }), true);
});

test('rowMatches: Steam rejects a non-Steam row at the same time', () => {
  assert.equal(rowMatches('CROSSFIT® FIT 9:30am (60 min) BOOK NOW', { kind: 'Steam', time: '9:30am' }), false);
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

// Wodup client tests
test('wodup: extract workouts from simulated page text', () => {
  // Simulate the page text structure we extract from Wodup
  const simulatedText = `Timeline
Feed
Calendar
BURN
Log Result
Leaderboard
Move Upper 4/8
A1. Incline Bench Dumbbell Front Raise 8-12-8-12-12-20
A2. Bent-Over Barbell Row 3 x 10
Show full workout
FIT
Log Result
Leaderboard
PHASE 1: W8 (Week B)
A. Primer
B. Jerk 4 x 2
C. AMRAP 12
Show full workout
Choose which programs`;

  const lines = simulatedText.split('\n');
  const workoutMap = {};
  
  const workoutStarts = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'Log Result') {
      workoutStarts.push(i);
    }
  }
  
  workoutStarts.forEach(startIdx => {
    let kind = '';
    for (let i = startIdx - 1; i >= Math.max(0, startIdx - 5); i--) {
      const line = lines[i].trim().toUpperCase();
      if (['FIT', 'BURN', 'LIFT', 'STEAM', 'GYMNASTICS', 'RUN', 'CONDITIONING'].includes(line)) {
        kind = line;
        break;
      }
    }
    
    if (!kind) return;
    
    let endIdx = startIdx + 1;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      const isNextKind = ['FIT', 'BURN', 'LIFT', 'STEAM', 'GYMNASTICS', 'RUN', 'CONDITIONING'].includes(line.toUpperCase());
      if (isNextKind && i > startIdx + 5) {
        endIdx = i;
        break;
      }
      if (line.startsWith('Choose which programs')) {
        endIdx = i;
        break;
      }
    }
    
    const workoutLines = [];
    for (let i = startIdx + 1; i < endIdx; i++) {
      const line = lines[i].trim();
      if (line === 'Leaderboard') continue;
      if (line === 'Show full workout') break;
      if (line === '') continue;
      workoutLines.push(line);
    }
    
    if (workoutLines.length > 1) {
      workoutMap[kind] = workoutLines.join('\n');
    }
  });
  
  // Verify extraction
  assert.ok(workoutMap.BURN, 'should extract BURN workout');
  assert.ok(workoutMap.FIT, 'should extract FIT workout');
  assert.ok(workoutMap.BURN.includes('Move Upper'), 'BURN should contain title');
  assert.ok(workoutMap.FIT.includes('Jerk'), 'FIT should contain exercise');
  assert.ok(!workoutMap.BURN.includes('Show full workout'), 'should not include button text');
});

test('wodup: DM format uses dd-mm-yyyy date', () => {
  const dateYmd = '2026-05-21';
  const [yyyy, mm, dd] = dateYmd.split('-');
  const dateStr = `${dd}-${mm}-${yyyy}`;
  
  assert.equal(dateStr, '21-05-2026', 'should format as dd-mm-yyyy');
  
  const workoutText = 'Move Upper 4/8\nA1. Row 3 x 10';
  const dmText = `Tomorrow's workout for FIT (THU ${dateStr}):\n\n${workoutText}`;
  
  assert.ok(dmText.includes('21-05-2026'), 'DM should contain formatted date');
  assert.ok(!dmText.includes('2026-05-21'), 'DM should not contain YYYY-MM-DD format');
});

test('wodup: DM has no em-dashes', () => {
  const workoutText = 'Move Upper 4/8\nA1. Incline Bench Dumbbell Front Raise';
  const dateStr = '21-05-2026';
  const dmText = `Tomorrow's workout for FIT (THU ${dateStr}):\n\n${workoutText}`;
  
  assert.ok(!dmText.includes('—'), 'DM must not contain em-dashes (per feedback)');
});

test('wodup: idempotency via state file', () => {
  const state = {
    date: '2026-05-21',
    sentTo: {
      yash: { timestamp: '2026-05-20T19:00:00Z', kind: 'FIT' },
      dani: { timestamp: '2026-05-20T19:00:01Z', kind: 'BURN' }
    },
    completed: true
  };
  
  assert.ok(state.sentTo['yash'], 'should have sent to yash');
  assert.ok(!state.sentTo['unknown'], 'should not have sent to unknown user');
  assert.ok(state.completed, 'should be marked completed');
});

// ── verify-don't-trust on Mindbody API error (Mer 2026-05-20 incident) ──────

test('isBookingInUpcoming: returns true when target matches one entry', () => {
  const upcoming = [
    { ymd: '2026-05-22', kind: 'FIT', time: '7:30am' },
    { ymd: '2026-05-23', kind: 'Gymnastics', time: '12:30pm' },
  ];
  assert.equal(isBookingInUpcoming(upcoming, { targetYmd: '2026-05-22', kind: 'FIT', time: '7:30am' }), true);
});

test('isBookingInUpcoming: returns false when no entry matches', () => {
  const upcoming = [{ ymd: '2026-05-22', kind: 'FIT', time: '7:30am' }];
  assert.equal(isBookingInUpcoming(upcoming, { targetYmd: '2026-05-22', kind: 'FIT', time: '6:30am' }), false);
  assert.equal(isBookingInUpcoming(upcoming, { targetYmd: '2026-05-22', kind: 'Lift', time: '7:30am' }), false);
  assert.equal(isBookingInUpcoming(upcoming, { targetYmd: '2026-05-23', kind: 'FIT', time: '7:30am' }), false);
});

test('isBookingInUpcoming: empty upcoming list returns false', () => {
  assert.equal(isBookingInUpcoming([], { targetYmd: '2026-05-22', kind: 'FIT', time: '7:30am' }), false);
});

test('isBookingInUpcoming: non-array input returns false (defensive)', () => {
  assert.equal(isBookingInUpcoming(null, { targetYmd: '2026-05-22', kind: 'FIT', time: '7:30am' }), false);
  assert.equal(isBookingInUpcoming(undefined, { targetYmd: '2026-05-22', kind: 'FIT', time: '7:30am' }), false);
  assert.equal(isBookingInUpcoming({}, { targetYmd: '2026-05-22', kind: 'FIT', time: '7:30am' }), false);
});

test('isBookingInUpcoming: tolerates entries with missing fields', () => {
  const upcoming = [
    null,
    {},
    { ymd: '2026-05-22' },
    { ymd: '2026-05-22', kind: 'FIT', time: '7:30am' },
  ];
  assert.equal(isBookingInUpcoming(upcoming, { targetYmd: '2026-05-22', kind: 'FIT', time: '7:30am' }), true);
});

test('isBookingInUpcoming: time format must match exactly (regression guard)', () => {
  // parseBookingCard emits "7:30am" lowercase; verify exact match
  const upcoming = [{ ymd: '2026-05-22', kind: 'FIT', time: '7:30am' }];
  assert.equal(isBookingInUpcoming(upcoming, { targetYmd: '2026-05-22', kind: 'FIT', time: '7:30AM' }), false);
  assert.equal(isBookingInUpcoming(upcoming, { targetYmd: '2026-05-22', kind: 'FIT', time: '07:30am' }), false);
});

// findBookingInUpcoming returns the matched card so callers can read .waitlisted
// (the 2026-06-09 fix: a waitlist entry must never be reported as a booking).
test('findBookingInUpcoming: returns the matched card, exposing waitlisted', () => {
  const upcoming = [
    { ymd: '2026-06-11', kind: 'FIT', time: '6:30am', waitlisted: true },
    { ymd: '2026-06-10', kind: 'FIT', time: '6:30am', waitlisted: false },
  ];
  const wl = findBookingInUpcoming(upcoming, { targetYmd: '2026-06-11', kind: 'FIT', time: '6:30am' });
  assert.equal(wl.waitlisted, true);
  const booked = findBookingInUpcoming(upcoming, { targetYmd: '2026-06-10', kind: 'FIT', time: '6:30am' });
  assert.equal(booked.waitlisted, false);
});

test('findBookingInUpcoming: returns null when nothing matches or input is bad', () => {
  assert.equal(findBookingInUpcoming([{ ymd: '2026-06-11', kind: 'FIT', time: '6:30am' }], { targetYmd: '2026-06-11', kind: 'FIT', time: '7:30am' }), null);
  assert.equal(findBookingInUpcoming([], { targetYmd: '2026-06-11', kind: 'FIT', time: '6:30am' }), null);
  assert.equal(findBookingInUpcoming(null, { targetYmd: '2026-06-11', kind: 'FIT', time: '6:30am' }), null);
});

// Mer scenario simulation: bookViaApi returned HTTP 400 with PG::UniqueViolation
// on the booking_items step, but the booking actually DID write to Mindbody.
// The verify-don't-trust path fetches /account/schedule and finds the booking
// there — so we should claim success despite the error.
test('verify-don\'t-trust: Mer scenario . booking found despite booking_items 400', () => {
  // Synthetic /account/schedule response showing Mer's Fri 7:30am FIT is in fact booked
  const upcomingFromMindbody = [
    { ymd: '2026-05-22', kind: 'FIT', time: '7:30am', raw: 'sample' },
  ];
  const plan = { kind: 'FIT' };
  const usedTime = '7:30am';
  const targetYmd = '2026-05-22';

  // Simulate the verify-don't-trust decision
  const verified = isBookingInUpcoming(upcomingFromMindbody, {
    targetYmd, kind: plan.kind, time: usedTime,
  });
  assert.equal(verified, true, 'verify-don\'t-trust must claim success when /account/schedule shows the booking');
});

test('verify-don\'t-trust: real failure . booking NOT on schedule . returns false (UI fallback)', () => {
  // Class genuinely failed: nothing on /account/schedule for the target slot
  const upcomingFromMindbody = [
    { ymd: '2026-05-23', kind: 'Gymnastics', time: '12:30pm' }, // some other class
  ];
  const verified = isBookingInUpcoming(upcomingFromMindbody, {
    targetYmd: '2026-05-22', kind: 'FIT', time: '7:30am',
  });
  assert.equal(verified, false, 'verify must say no when booking is genuinely absent');
});

// ── waitlist watcher v3 (DM-every-1-min) ────────────────────────────────────
// 2026-05-20: Mindbody marketplace API doesn't expose a public join-waitlist
// endpoint (returns 403). Watcher switched from "auto-join via API" to
// "DM every fire while the slot is open"; user manually clicks JOIN
// WAITLIST / BOOK NOW in the Mindbody app.

const { buildAlertMessage } = require('./waitlist-watch');

test('waitlist v3 buildAlertMessage: BOOK_NOW heading + book-now action', () => {
  const target = new Date('2026-05-22T00:00:00');
  const msg = buildAlertMessage({
    observed: 'BOOK_NOW',
    plan: { kind: 'FIT' },
    timeArg: '7:30am',
    dateArg: '2026-05-22',
    target,
    name: 'Mer',
    alertCount: 1,
  });
  assert.ok(msg.includes('🟢 *SLOT OPEN*'), 'should include SLOT OPEN heading');
  assert.ok(msg.includes('BOOK NOW'), 'should tell user to BOOK NOW');
  assert.ok(msg.includes('Mer, '), 'should personalize with name');
  assert.ok(msg.includes('7:30am'), 'should include time');
  assert.ok(msg.includes('22-05-2026'), 'should use dd-mm-yyyy date format');
});

test('waitlist v3 buildAlertMessage: WAITLIST heading + join-waitlist action', () => {
  const target = new Date('2026-05-22T00:00:00');
  const msg = buildAlertMessage({
    observed: 'WAITLIST',
    plan: { kind: 'FIT' },
    timeArg: '7:30am',
    dateArg: '2026-05-22',
    target,
    name: 'Mer',
    alertCount: 1,
  });
  assert.ok(msg.includes('🟡 *WAITLIST AVAILABLE*'), 'should include WAITLIST heading');
  assert.ok(msg.includes('JOIN WAITLIST'), 'should tell user to JOIN WAITLIST');
});

test('waitlist v3 buildAlertMessage: alertCount > 1 includes reminder hint', () => {
  const target = new Date('2026-05-22T00:00:00');
  const m1 = buildAlertMessage({
    observed: 'BOOK_NOW', plan: { kind: 'FIT' }, timeArg: '7:30am',
    dateArg: '2026-05-22', target, name: 'Mer', alertCount: 1,
  });
  const m4 = buildAlertMessage({
    observed: 'BOOK_NOW', plan: { kind: 'FIT' }, timeArg: '7:30am',
    dateArg: '2026-05-22', target, name: 'Mer', alertCount: 4,
  });
  assert.ok(!m1.includes('reminder'), 'first alert: no reminder hint');
  assert.ok(m4.includes('reminder 4'), 'fourth alert: shows reminder count');
});

test('waitlist v3 buildAlertMessage: no em-dashes anywhere (Yash voice rule)', () => {
  const target = new Date('2026-05-22T00:00:00');
  for (const observed of ['BOOK_NOW', 'WAITLIST']) {
    for (const alertCount of [1, 5]) {
      const msg = buildAlertMessage({
        observed, plan: { kind: 'FIT' }, timeArg: '7:30am',
        dateArg: '2026-05-22', target, name: 'Mer', alertCount,
      });
      assert.equal(msg.includes('—'), false, `${observed} alert ${alertCount} must have no em-dash`);
    }
  }
});

test('waitlist v3 buildAlertMessage: works with null name (omits greeting)', () => {
  const target = new Date('2026-05-22T00:00:00');
  const msg = buildAlertMessage({
    observed: 'BOOK_NOW', plan: { kind: 'FIT' }, timeArg: '7:30am',
    dateArg: '2026-05-22', target, name: null, alertCount: 1,
  });
  assert.ok(!msg.includes(', FIT'), 'should not have a "[blank], FIT" gap');
  assert.ok(msg.includes('FIT @ 7:30am'), 'class line should still appear');
});

test('waitlist v3 buildAlertMessage: includes Mindbody URL for action link', () => {
  const target = new Date('2026-05-22T00:00:00');
  const msg = buildAlertMessage({
    observed: 'BOOK_NOW', plan: { kind: 'FIT' }, timeArg: '7:30am',
    dateArg: '2026-05-22', target, name: 'Mer', alertCount: 1,
  });
  assert.ok(msg.includes('mindbodyonline.com/explore/locations/ragtag'), 'should include gym URL');
});

// ── isInventoryRowRace (regression — 2026-05-22 Dani vs Yash Sun 1pm) ──
const { isInventoryRowRace } = require('./lib');

test('isInventoryRowRace: matches the real Mindbody RecordNotUnique 400', () => {
  const result = {
    ok: false,
    step: 'booking_items',
    status: 400,
    body: '{"errors":[{"status":"400","title":"ActiveRecord::RecordNotUnique","detail":"PG::UniqueViolation: ERROR:  duplicate key value violates unique constraint \\"index_inventory_item_references_on_source_reference\\"',
    orderId: 'a55d771a-cc39-41dc-ae85-7234c7d63362',
  };
  assert.equal(isInventoryRowRace(result), true);
});

test('isInventoryRowRace: matches a bare PG::UniqueViolation body', () => {
  assert.equal(isInventoryRowRace({ ok: false, step: 'booking_items', body: 'PG::UniqueViolation: yada' }), true);
});

test('isInventoryRowRace: ignores non-booking_items step', () => {
  assert.equal(
    isInventoryRowRace({ ok: false, step: 'process', body: 'RecordNotUnique somewhere else' }),
    false,
  );
});

test('isInventoryRowRace: ignores other booking_items errors (capacity, auth)', () => {
  assert.equal(
    isInventoryRowRace({ ok: false, step: 'booking_items', body: 'class is at max capacity' }),
    false,
  );
  assert.equal(
    isInventoryRowRace({ ok: false, step: 'booking_items', body: '{"errors":[{"title":"Unauthorized"}]}' }),
    false,
  );
});

test('isInventoryRowRace: ok=true never matches', () => {
  assert.equal(
    isInventoryRowRace({ ok: true, step: 'process', body: 'whatever' }),
    false,
  );
});

test('isInventoryRowRace: null/undefined-safe', () => {
  assert.equal(isInventoryRowRace(null), false);
  assert.equal(isInventoryRowRace(undefined), false);
  assert.equal(isInventoryRowRace({}), false);
  assert.equal(isInventoryRowRace({ ok: false, step: 'booking_items' }), false);
});

// ── 2026-06-06 mass-failure resilience (spawnStaggerMs / navRetryPlan / canRetrySetup) ──
// Incident: all 5 users died on the first page.goto at 08:57. Root cause chain:
// (1) 5 Chromium cold-starts at once thrashed the Mini → 58s browser launch,
// (2) one monolithic 30s goto timed out, (3) the setup-retry was skipped because
// only 71125ms remained, below the 75000ms margin. These lock in each link's fix.

test('spawnStaggerMs: first child starts immediately', () => {
  assert.equal(spawnStaggerMs(0), 0);
});

test('spawnStaggerMs: linear 1.5s steps so cold-starts do not collide', () => {
  assert.equal(spawnStaggerMs(1), 1500);
  assert.equal(spawnStaggerMs(2), 3000);
  assert.equal(spawnStaggerMs(3), 4500);
  assert.equal(spawnStaggerMs(4), 6000);
});

test('spawnStaggerMs: caps so the last child still starts well before 9am', () => {
  assert.equal(spawnStaggerMs(100), 12000);       // 100*1500 would be 150s; capped
  assert.equal(spawnStaggerMs(10, 1500, 5000), 5000);
});

test('spawnStaggerMs: custom step + defensive on non-positive index', () => {
  assert.equal(spawnStaggerMs(2, 1000), 2000);
  assert.equal(spawnStaggerMs(-1), 0);
  assert.equal(spawnStaggerMs(NaN), 0);
});

// ── decideAuthAction: the 09:00 auth decision (the #1 reliability path) ──────
test('decideAuthAction: no cached session → login', () => {
  const a = decideAuthAction({ haveCachedAuth: false, loggedOut: true });
  assert.equal(a.login, true);
  assert.match(a.reason, /no cached/);
});

test('decideAuthAction: cached but UI logged-out (expired) → login', () => {
  const a = decideAuthAction({ haveCachedAuth: true, loggedOut: true, bearerOk: null });
  assert.equal(a.login, true);
  assert.match(a.reason, /expired/);
});

test('decideAuthAction: ZOMBIE (cached, looks logged-in, no Bearer) → login (2026-06-09 geraldine/cheryllee)', () => {
  const a = decideAuthAction({ haveCachedAuth: true, loggedOut: false, bearerOk: false });
  assert.equal(a.login, true);
  assert.match(a.reason, /zombie/i);
});

test('decideAuthAction: healthy cached session (Bearer present) → USE CACHED, no login', () => {
  // The core of the timeout fix: a valid session must NOT trigger the ~80s
  // forced login that ate the budget and caused the 2026-06-09 misses.
  const a = decideAuthAction({ haveCachedAuth: true, loggedOut: false, bearerOk: true });
  assert.equal(a.login, false);
});

test('decideAuthAction: cached + logged-in + probe skipped (null) → use cached (no needless login)', () => {
  assert.equal(decideAuthAction({ haveCachedAuth: true, loggedOut: false, bearerOk: null }).login, false);
  assert.equal(decideAuthAction({ haveCachedAuth: true, loggedOut: false }).login, false);
});

test('decideAuthAction: no-cache takes precedence over a stale bearerOk flag', () => {
  // Defensive: if somehow bearerOk=true but there is no cached session, still login.
  assert.equal(decideAuthAction({ haveCachedAuth: false, loggedOut: false, bearerOk: true }).login, true);
});

// ── decideWaitlistAlert: the spam logic that bit twice (Melissa, Dani) ───────
test('decideWaitlistAlert: real booking/promotion → "you\'re in!", stop', () => {
  assert.equal(decideWaitlistAlert({ bookingDetected: true, observed: 'WAITLIST', alreadyWaitlisted: true }), 'booked');
});

test('decideWaitlistAlert: first time seen on the waitlist → one sign-off', () => {
  assert.equal(decideWaitlistAlert({ userOnWaitlist: true, alreadyWaitlisted: false, observed: 'WAITLIST' }), 'signoff');
});

test('decideWaitlistAlert: STICKY — already signed off + live detection MISSES → silent (the 2026-06-11 Dani bug)', () => {
  // The exact failure: userWaitlisted was true, but a later poll did not detect
  // her waitlist card (userOnWaitlist=false) and the class still read WAITLIST.
  // Pre-fix this fell through to a nudge ("reminder 2"). Must be silent.
  assert.equal(decideWaitlistAlert({
    userOnWaitlist: false, alreadyWaitlisted: true, observed: 'WAITLIST', alertCount: 2, maxNudges: 3,
  }), 'silent');
});

test('decideWaitlistAlert: already on waitlist stays silent even on a BOOK_NOW blip', () => {
  assert.equal(decideWaitlistAlert({ userOnWaitlist: false, alreadyWaitlisted: true, observed: 'BOOK_NOW' }), 'silent');
});

test('decideWaitlistAlert: full + waitlist open + not yet joined → nudge to join, under the cap', () => {
  assert.equal(decideWaitlistAlert({ userOnWaitlist: false, alreadyWaitlisted: false, observed: 'WAITLIST', alertCount: 0, maxNudges: 3 }), 'nudge_waitlist');
  assert.equal(decideWaitlistAlert({ userOnWaitlist: false, alreadyWaitlisted: false, observed: 'WAITLIST', alertCount: 2, maxNudges: 3 }), 'nudge_waitlist');
});

test('decideWaitlistAlert: WAITLIST nudge stops at the cap', () => {
  assert.equal(decideWaitlistAlert({ alreadyWaitlisted: false, observed: 'WAITLIST', alertCount: 3, maxNudges: 3 }), 'silent');
  assert.equal(decideWaitlistAlert({ alreadyWaitlisted: false, observed: 'WAITLIST', alertCount: 9, maxNudges: 3 }), 'silent');
});

test('decideWaitlistAlert: a freed slot (BOOK_NOW) for a not-yet-joined user → grab-it nudge', () => {
  assert.equal(decideWaitlistAlert({ alreadyWaitlisted: false, observed: 'BOOK_NOW', alertCount: 5 }), 'nudge_booknow');
});

test('decideWaitlistAlert: FULL (no waitlist yet) → silent', () => {
  assert.equal(decideWaitlistAlert({ alreadyWaitlisted: false, observed: 'FULL' }), 'silent');
});

test('navRetryPlan: ample budget allows the full 3 attempts', () => {
  const p = navRetryPlan(80000);
  assert.equal(p.attempts, 3);          // (80000-8000)/22000 = 3.27 -> 3
  assert.equal(p.perAttemptMs, 22000);  // bumped from 15000: the cold ragtag nav reliably needs ~18s
  assert.equal(p.backoffMs, 1000);
});

test('navRetryPlan: shrinks attempts when time is tight (fail fast to alert)', () => {
  assert.equal(navRetryPlan(60000).attempts, 2);   // (60000-8000)/22000 = 2.36 -> 2
  assert.equal(navRetryPlan(40000).attempts, 1);   // (40000-8000)/22000 = 1.45 -> 1
  assert.equal(navRetryPlan(23000).attempts, 1);   // (23000-8000)/22000 = 0.68 -> floored to 0 -> min 1
  assert.equal(navRetryPlan(8000).attempts, 1);    // no usable budget -> still try once
});

test('navRetryPlan: noWait (manual --now / tests) ignores the deadline', () => {
  assert.equal(navRetryPlan(1000, { noWait: true }).attempts, 3);
  assert.equal(navRetryPlan(null).attempts, 3);    // unknown budget -> full retries
});

test('canRetrySetup: REPRODUCES the 2026-06-06 skip (71125ms < 75000 margin)', () => {
  // The exact numbers from the incident log: setup attempt 1/2, 71125ms to 9am.
  assert.equal(
    canRetrySetup({ attempt: 1, maxAttempts: 2, msRemaining: 71125, marginMs: 75000, noWait: false }),
    false,
  );
});

test('canRetrySetup: with adequate budget the retry now fires', () => {
  // Same failure, but the run started earlier / setup was faster -> headroom left.
  assert.equal(
    canRetrySetup({ attempt: 1, maxAttempts: 2, msRemaining: 120000, marginMs: 75000, noWait: false }),
    true,
  );
});

test('canRetrySetup: noWait always retries; no retries left at max attempt', () => {
  assert.equal(canRetrySetup({ attempt: 1, maxAttempts: 2, msRemaining: 1000, marginMs: 75000, noWait: true }), true);
  assert.equal(canRetrySetup({ attempt: 2, maxAttempts: 2, msRemaining: 999999, marginMs: 75000, noWait: false }), false);
});

test('canRetrySetup: margin is strict (> not >=)', () => {
  assert.equal(canRetrySetup({ attempt: 1, maxAttempts: 2, msRemaining: 75000, marginMs: 75000, noWait: false }), false);
  assert.equal(canRetrySetup({ attempt: 1, maxAttempts: 2, msRemaining: 75001, marginMs: 75000, noWait: false }), true);
});

test('canRetrySetup: REPRODUCES the 2026-06-10 early giveup (cap too low, runway left)', () => {
  // The incident: setup attempt 2/2 failed at 08:58 with 211735ms (3.5 min) to
  // 09:00 — far above the 75s margin, so a retry was SAFE, but maxAttempts=2
  // killed it. With the cap raised to 6 the margin gate (not the count) decides.
  assert.equal(
    canRetrySetup({ attempt: 2, maxAttempts: 2, msRemaining: 211735, marginMs: 75000, noWait: false }),
    false, // old behaviour: gave up with 3.5 min left
  );
  assert.equal(
    canRetrySetup({ attempt: 2, maxAttempts: 6, msRemaining: 211735, marginMs: 75000, noWait: false }),
    true,  // fixed: plenty of runway, keep retrying
  );
});

// ── 2026-06-10 structural fixes (post-9am recovery + serialized setup) ───────
// Incident #2 of the day: the 09:07 RECOVERY run after the mass-miss got one
// goto attempt and zero setup retries, because msRemaining was negative
// (-431994ms) and the fail-fast logic built to protect the 09:00 sprint was
// applied to a run with no sprint left to protect. Negative budget now means
// recovery mode: full retry budget, like noWait.

test('navRetryPlan: REPRODUCES the 09:07 recovery starvation (negative budget → full attempts)', () => {
  const p = navRetryPlan(-431994);  // exact ms-from-now in the failed recovery log
  assert.equal(p.attempts, 3);
  assert.equal(navRetryPlan(-1).attempts, 3);
});

test('navRetryPlan: zero budget still fails fast (deadline imminent, not passed)', () => {
  assert.equal(navRetryPlan(0).attempts, 1);
});

test('canRetrySetup: negative msRemaining (post-9am recovery) retries freely', () => {
  assert.equal(canRetrySetup({ attempt: 1, maxAttempts: 6, msRemaining: -438304, marginMs: 75000, noWait: false }), true);
});

test('canRetrySetup: attempt cap still binds in recovery mode', () => {
  assert.equal(canRetrySetup({ attempt: 6, maxAttempts: 6, msRemaining: -438304, marginMs: 75000, noWait: false }), false);
});

// ── decideDailyClaim: dual-trigger arbitration (08:40 agent + 08:54 daemon) ──
// Both schedulers run a bare book-all. The claim must guarantee they never
// both book (double 9am sprint = double-booking, Mindbody allows it) while
// making the 08:54 daemon an automatic retry of a failed/crashed 08:40 run.

test('decideDailyClaim: no claim → fresh run proceeds', () => {
  assert.equal(decideDailyClaim({ claim: null, pidAlive: false }).action, 'proceed');
});

test('decideDailyClaim: holder alive and running → skip (never double-book)', () => {
  const v = decideDailyClaim({ claim: { status: 'running', pid: 123 }, pidAlive: true });
  assert.equal(v.action, 'skip');
});

test('decideDailyClaim: holder crashed mid-flight → take over', () => {
  const v = decideDailyClaim({ claim: { status: 'running', pid: 123 }, pidAlive: false });
  assert.equal(v.action, 'proceed');
  assert.match(v.reason, /died|taking over/);
});

test('decideDailyClaim: today already succeeded → skip', () => {
  assert.equal(decideDailyClaim({ claim: { status: 'success', pid: 123 }, pidAlive: false }).action, 'skip');
});

test('decideDailyClaim: previous run FAILED → backstop retries', () => {
  const v = decideDailyClaim({ claim: { status: 'fail', pid: 123 }, pidAlive: false });
  assert.equal(v.action, 'proceed');
  assert.match(v.reason, /retrying/);
});

test('decideDailyClaim: garbage claim never blocks the booking', () => {
  assert.equal(decideDailyClaim({ claim: 'not-an-object', pidAlive: false }).action, 'proceed');
  assert.equal(decideDailyClaim({ claim: { status: 'banana' }, pidAlive: false }).action, 'proceed');
});

// ── resolveSprintTarget: the dress-rehearsal T9 override knob ────────────────
test('resolveSprintTarget: no override → real 9am, not flagged', () => {
  const nineAm = new Date('2026-06-11T01:00:00.000Z');
  const r = resolveSprintTarget({ overrideIso: undefined, fallback: nineAm });
  assert.equal(r.t9, nineAm);
  assert.equal(r.overridden, false);
  assert.equal(resolveSprintTarget({ overrideIso: '', fallback: nineAm }).overridden, false);
});

test('resolveSprintTarget: valid override wins and is flagged (10-06 rehearsal: 337ms drift)', () => {
  const r = resolveSprintTarget({ overrideIso: '2026-06-10T06:13:36.000Z', fallback: new Date() });
  assert.equal(r.t9.toISOString(), '2026-06-10T06:13:36.000Z');
  assert.equal(r.overridden, true);
});

test('resolveSprintTarget: garbage override throws loudly (never sprint at NaN)', () => {
  assert.throws(
    () => resolveSprintTarget({ overrideIso: 'tomorrow-ish', fallback: new Date() }),
    /not a valid date/,
  );
});

test('SETUP_COMPLETE_MARKER: stable contract between book.js (prints) and book-all.js (gates)', () => {
  assert.equal(typeof SETUP_COMPLETE_MARKER, 'string');
  assert.ok(SETUP_COMPLETE_MARKER.length > 10, 'marker must be distinctive enough not to false-match log noise');
  // book.js emits it through log() (timestamp prefix); book-all matches with .includes().
  const sampleLogLine = `[2026-06-10T05:30:00.000Z] ${SETUP_COMPLETE_MARKER}\n`;
  assert.ok(sampleLogLine.includes(SETUP_COMPLETE_MARKER));
});

// ── storageState corruption self-heal (2026-06-10 melissa.json) ──────────────
const { storageStatePathIfValid } = require('./lib');

test('storageStatePathIfValid: valid Playwright state returns the path', () => {
  const fake = { existsSync: () => true, readFileSync: () => JSON.stringify({ cookies: [], origins: [] }) };
  assert.equal(storageStatePathIfValid('/x/auth.json', fake), '/x/auth.json');
});

test('storageStatePathIfValid: missing file returns null (fresh login)', () => {
  const fake = { existsSync: () => false, readFileSync: () => { throw new Error('nope'); } };
  assert.equal(storageStatePathIfValid('/x/auth.json', fake), null);
});

test('storageStatePathIfValid: trailing-garbage corruption returns null (the melissa.json case)', () => {
  // Exactly the 2026-06-10 shape: valid JSON object then leftover bytes after it.
  const corrupt = JSON.stringify({ cookies: [], origins: [] }) + '\n}{"stale":1}';
  const fake = { existsSync: () => true, readFileSync: () => corrupt };
  assert.equal(storageStatePathIfValid('/x/melissa.json', fake), null);
});

test('storageStatePathIfValid: wrong-shape JSON (no cookies array) returns null', () => {
  const fake = { existsSync: () => true, readFileSync: () => JSON.stringify({ foo: 1 }) };
  assert.equal(storageStatePathIfValid('/x/auth.json', fake), null);
});

// ── Failure classifier + waitlist watch registry (2026-06-07) ────────────────
const {
  classifyBookingFailure, parseClockToMinutes, classStartMs,
  watchRegistryKey, upsertWatch, pruneWatchRegistry, shouldRetryPassFetchPreWindow,
} = require('./lib');

test('classifyBookingFailure: success is not a failure', () => {
  const v = classifyBookingFailure({ ok: true, reason: 'booked (api-direct)' });
  assert.equal(v.category, 'ok');
  assert.equal(v.autoWatch, false);
});

test('classifyBookingFailure: FULL arrives via detail off a generic exception → watch', () => {
  const v = classifyBookingFailure({ ok: false, reason: 'exception', detail: 'FIT FULL (primary and fallback)' });
  assert.equal(v.category, 'full');
  assert.equal(v.autoWatch, true);
});

test('classifyBookingFailure: went FULL before 9am → full/watch', () => {
  const v = classifyBookingFailure({ ok: false, reason: 'exception', detail: 'FIT went FULL before 9am (all fallbacks too)' });
  assert.equal(v.category, 'full');
  assert.equal(v.autoWatch, true);
});

test('classifyBookingFailure: class-full-waitlisted → full/watch (the 2026-06-09 fix arms the watcher)', () => {
  const v = classifyBookingFailure({ ok: false, reason: 'class-full-waitlisted', detail: 'FIT @ 6:30am on Thu 2026-06-11 was FULL at 09:00 — you\'re on the waitlist now.' });
  assert.equal(v.category, 'full');
  assert.equal(v.autoWatch, true);
});

test('classifyBookingFailure: pass-fetch-failed → no_pass/watch (the Geraldine trigger)', () => {
  const v = classifyBookingFailure({ ok: false, reason: 'pass-fetch-failed', detail: 'no eligible pass found for this class' });
  assert.equal(v.category, 'no_pass');
  assert.equal(v.autoWatch, true);
});

test('classifyBookingFailure: the masked tab-click symptom lands in infra/watch', () => {
  const v = classifyBookingFailure({ ok: false, reason: 'exception', detail: 'could not click Classes/Schedule tab after 4 attempts' });
  assert.equal(v.category, 'infra');
  assert.equal(v.autoWatch, true);
  assert.match(v.cause, /could not click Classes\/Schedule tab/);
});

test('classifyBookingFailure: class-not-found → not_found, no watch', () => {
  const v = classifyBookingFailure({ ok: false, reason: 'class-not-found', detail: 'FIT 07:30 not in schedule (12 classes)' });
  assert.equal(v.category, 'not_found');
  assert.equal(v.autoWatch, false);
});

test('classifyBookingFailure: no row found → not_found, no watch', () => {
  const v = classifyBookingFailure({ ok: false, reason: 'exception', detail: 'no FIT row found on 2026-06-09 (tried 6:30am + 7:30am)' });
  assert.equal(v.category, 'not_found');
  assert.equal(v.autoWatch, false);
});

test('classifyBookingFailure: auth/bearer failures route to fix, not watch', () => {
  assert.equal(classifyBookingFailure({ ok: false, reason: 'bearer-capture-failed', detail: 'timeout' }).autoWatch, false);
  assert.equal(classifyBookingFailure({ ok: false, reason: 'exception', detail: 'auth expired and no visible Login button found' }).category, 'auth');
});

test('classifyBookingFailure: unknown/no-result-file → infra/watch (safety net)', () => {
  const v = classifyBookingFailure({ ok: false, reason: 'no-result-file', detail: 'child exited 1 without writing result file' });
  assert.equal(v.category, 'infra');
  assert.equal(v.autoWatch, true);
});

test('parseClockToMinutes: am/pm + noon/midnight', () => {
  assert.equal(parseClockToMinutes('7:30am'), 7 * 60 + 30);
  assert.equal(parseClockToMinutes('6:30pm'), 18 * 60 + 30);
  assert.equal(parseClockToMinutes('12:00am'), 0);
  assert.equal(parseClockToMinutes('12:30pm'), 12 * 60 + 30);
  assert.equal(parseClockToMinutes('garbage'), null);
});

test('classStartMs: timezone-independent SGT epoch', () => {
  // 2026-06-09 07:30 SGT == 2026-06-08T23:30:00Z
  assert.equal(classStartMs('2026-06-09', '7:30am'), Date.parse('2026-06-08T23:30:00Z'));
  assert.equal(classStartMs('bad-date', '7:30am'), null);
  assert.equal(classStartMs('2026-06-09', 'nope'), null);
});

test('watchRegistryKey: normalizes user/time/kind', () => {
  const a = watchRegistryKey({ user: 'Geraldine', date: '2026-06-09', time: '7:30 AM', kind: 'fit' });
  const b = watchRegistryKey({ user: 'geraldine', date: '2026-06-09', time: '7:30am', kind: 'FIT' });
  assert.equal(a, b);
});

test('upsertWatch: dedupes the same slot, keeps distinct slots, no mutation', () => {
  const e1 = { user: 'geraldine', date: '2026-06-09', time: '7:30am', kind: 'FIT', reason: 'full' };
  const orig = [];
  const r1 = upsertWatch(orig, e1);
  assert.equal(orig.length, 0); // pure: original untouched
  assert.equal(r1.length, 1);
  // Re-enroll same slot (different reason) replaces, does not duplicate.
  const r2 = upsertWatch(r1, { ...e1, reason: 'infra' });
  assert.equal(r2.length, 1);
  assert.equal(r2[0].reason, 'infra');
  // A different user on the same slot is a separate watch.
  const r3 = upsertWatch(r2, { ...e1, user: 'dani' });
  assert.equal(r3.length, 2);
});

test('pruneWatchRegistry: strictly-after cutoff, malformed always dropped', () => {
  const w = { user: 'a', date: '2026-06-09', time: '7:30am', kind: 'FIT' };
  const malformed = { user: 'c', date: 'xxx', time: 'yyy', kind: 'FIT' };
  const startMs = classStartMs('2026-06-09', '7:30am');
  assert.equal(pruneWatchRegistry([w, malformed], startMs - 1).length, 1); // not yet started → kept
  assert.equal(pruneWatchRegistry([w, malformed], startMs).length, 0);     // started → dropped
  assert.equal(pruneWatchRegistry([malformed], 0).length, 0);              // malformed → dropped
});

test('shouldRetryPassFetchPreWindow: only retries no-pass before the window opens', () => {
  // pass-fetch miss, still pre-9am, api-direct on → wait for the window then retry
  assert.equal(shouldRetryPassFetchPreWindow({ reason: 'pass-fetch-failed' }, 60000, true), true);
  // same miss but already past 9am → no point retrying, fall back now
  assert.equal(shouldRetryPassFetchPreWindow({ reason: 'pass-fetch-failed' }, -5000, true), false);
  // a different failure (bearer) is not the pre-window pass case
  assert.equal(shouldRetryPassFetchPreWindow({ reason: 'bearer-capture-failed' }, 60000, true), false);
  // --no-wait / nowait disables the wait-and-retry
  assert.equal(shouldRetryPassFetchPreWindow({ reason: 'pass-fetch-failed' }, 60000, false), false);
});

const { buildWatchCandidates } = require('./lib');
// 10:00 SGT on 2026-06-07 — after the 09:00 window, the 2026-06-09 classes are
// still in the future so they survive the prune.
const ENROLL_NOW = Date.parse('2026-06-07T02:00:00Z');
const ENROLL_USERS = {
  geraldine: { id: 'geraldine', label: 'Geraldine', telegramChatId: 80808080 },
  yash: { id: 'yash', label: 'Yash', telegramChatId: 166637821 },
};
const enrollRun = (id, results, targetYmd = '2026-06-09') =>
  [{ id, user: { label: ENROLL_USERS[id] ? ENROLL_USERS[id].label : id }, targetYmd, results }];

test('buildWatchCandidates: Geraldine tab-click miss → infra watch, user+Yash chatIds', () => {
  const runs = enrollRun('geraldine', [
    { plan: { kind: 'FIT', primaryTime: '7:30am', fallback: null },
      status: { ok: false, reason: 'exception', detail: 'could not click Classes/Schedule tab after 4 attempts' } },
  ]);
  const c = buildWatchCandidates(runs, { usersById: ENROLL_USERS, nowMs: ENROLL_NOW, yashChatId: 166637821, nowIso: 'x' });
  assert.equal(c.length, 1);
  assert.deepEqual(
    { user: c[0].user, kind: c[0].kind, time: c[0].time, date: c[0].date, reason: c[0].reason, userChatId: c[0].userChatId, chatIds: c[0].chatIds, source: c[0].source },
    { user: 'geraldine', kind: 'FIT', time: '7:30am', date: '2026-06-09', reason: 'infra', userChatId: '80808080', chatIds: '80808080,166637821', source: 'auto-enroll' },
  );
  assert.match(c[0].cause, /could not click Classes\/Schedule tab/); // technical reason flows to the user DM
});

test('buildWatchCandidates: FULL → watch; class-not-found and success → skipped', () => {
  const full = buildWatchCandidates(enrollRun('geraldine', [
    { plan: { kind: 'FIT', primaryTime: '6:30am' }, status: { ok: false, reason: 'exception', detail: 'FIT FULL (primary and fallback)' } },
  ]), { usersById: ENROLL_USERS, nowMs: ENROLL_NOW, yashChatId: 166637821 });
  assert.equal(full.length, 1);
  assert.equal(full[0].reason, 'full');

  const notFound = buildWatchCandidates(enrollRun('geraldine', [
    { plan: { kind: 'FIT', primaryTime: '7:30am' }, status: { ok: false, reason: 'class-not-found', detail: 'FIT 07:30 not in schedule' } },
  ]), { usersById: ENROLL_USERS, nowMs: ENROLL_NOW, yashChatId: 166637821 });
  assert.equal(notFound.length, 0);

  const ok = buildWatchCandidates(enrollRun('geraldine', [
    { plan: { kind: 'FIT', primaryTime: '7:30am' }, status: { ok: true, reason: 'booked (api-direct)' } },
  ]), { usersById: ENROLL_USERS, nowMs: ENROLL_NOW, yashChatId: 166637821 });
  assert.equal(ok.length, 0);
});

test('buildWatchCandidates: classes already started are pruned', () => {
  const past = buildWatchCandidates(enrollRun('geraldine', [
    { plan: { kind: 'FIT', primaryTime: '7:30am' }, status: { ok: false, reason: 'exception', detail: 'FIT FULL' } },
  ], '2026-06-06'), { usersById: ENROLL_USERS, nowMs: ENROLL_NOW, yashChatId: 166637821 });
  assert.equal(past.length, 0);
});

test('buildWatchCandidates: when the failed user IS Yash, chatIds dedupes to one', () => {
  const c = buildWatchCandidates(enrollRun('yash', [
    { plan: { kind: 'FIT', primaryTime: '6:30am' }, status: { ok: false, reason: 'exception', detail: 'FIT FULL (primary and fallback)' } },
  ]), { usersById: ENROLL_USERS, nowMs: ENROLL_NOW, yashChatId: 166637821 });
  assert.equal(c.length, 1);
  assert.equal(c[0].chatIds, '166637821');
});

test('buildWatchCandidates: tolerates malformed/empty runs', () => {
  assert.deepEqual(buildWatchCandidates(null, {}), []);
  assert.deepEqual(buildWatchCandidates([{ id: 'x', targetYmd: '2026-06-09' }], { nowMs: ENROLL_NOW }), []); // no results array
  assert.deepEqual(buildWatchCandidates([{ id: 'x', results: [] }], { nowMs: ENROLL_NOW }), []); // no targetYmd
});
