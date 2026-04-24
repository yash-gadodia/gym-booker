const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DAY_SHORT, addDays, ymd, classPlan, normalize, rowMatches, rowStatus,
  decideNextAction, isBookingWindowErrorText, isLoginRedirectUrl,
} = require('./lib');

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

test('decideNextAction: unexpected status → fail with diagnostic', () => {
  const d = decideNextAction('WAITLIST');
  assert.equal(d.action, 'fail');
  assert.match(d.reason, /WAITLIST/);
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
