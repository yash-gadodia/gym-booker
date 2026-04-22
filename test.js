const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DAY_SHORT, addDays, ymd, classPlan, normalize, rowMatches, rowStatus } = require('./lib');

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
    ['2026-04-26', { kind: 'Gymnastics', primaryTime: '1:00pm',  fallback: null }],   // Sun
    ['2026-04-27', { kind: 'FIT',        primaryTime: '6:30am',  fallback: '7:30am' }], // Mon
    ['2026-04-28', { kind: 'FIT',        primaryTime: '6:30am',  fallback: '7:30am' }], // Tue
    ['2026-04-29', { kind: 'FIT',        primaryTime: '6:30am',  fallback: '7:30am' }], // Wed
    ['2026-04-30', { kind: 'FIT',        primaryTime: '6:30am',  fallback: '7:30am' }], // Thu
    ['2026-05-01', { kind: 'FIT',        primaryTime: '6:30am',  fallback: '7:30am' }], // Fri
    ['2026-04-25', { kind: 'Gymnastics', primaryTime: '12:30pm', fallback: null }],   // Sat
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
