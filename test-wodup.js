// Unit tests for wodup-formatter + wodup-daily-send filter logic.
// Run via: node --test test-wodup.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DOW_SHORT,
  dayOfWeekShort,
  dmyDate,
  buildHeader,
  extractPackingList,
  buildPackingBlock,
  assembleDM,
  sanitizeAssertions,
} = require('./wodup-formatter');

// ---- date helpers ----

test('dayOfWeekShort: 2026-05-21 is Thu', () => {
  assert.equal(dayOfWeekShort('2026-05-21'), 'Thu');
});

test('dayOfWeekShort: 2026-05-22 is Fri', () => {
  assert.equal(dayOfWeekShort('2026-05-22'), 'Fri');
});

test('dayOfWeekShort: every day of a week resolves correctly', () => {
  const expected = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = ['2026-05-17', '2026-05-18', '2026-05-19', '2026-05-20',
                '2026-05-21', '2026-05-22', '2026-05-23'];
  days.forEach((d, i) => {
    assert.equal(dayOfWeekShort(d), expected[i], `${d} should be ${expected[i]}`);
  });
});

test('dmyDate: zero-padded dd-mm-yyyy per Yash format rule', () => {
  assert.equal(dmyDate('2026-05-21'), '21-05-2026');
  assert.equal(dmyDate('2026-01-05'), '05-01-2026');
  assert.equal(dmyDate('2026-12-31'), '31-12-2026');
});

// ---- header ----

test('buildHeader: emoji + bold + DOW + DMY + dot + KIND', () => {
  assert.equal(buildHeader('2026-05-21', 'FIT'), '🏋️ *Thu 21-05-2026 . FIT*');
  assert.equal(buildHeader('2026-05-22', 'BURN'), '🏋️ *Fri 22-05-2026 . BURN*');
});

test('buildHeader: no em-dash (regression — old format used Tomorrow workout — FIT)', () => {
  const h = buildHeader('2026-05-21', 'FIT');
  assert.equal(h.includes('—'), false, 'header must not contain em-dash');
  assert.equal(h.includes("Tomorrow's"), false, 'header must not say Tomorrow\'s anymore');
});

// ---- packing list ----

test('extractPackingList: running variants → 👟', () => {
  assert.deepEqual(extractPackingList('400m run for time'), ['👟 Running shoes']);
  assert.deepEqual(extractPackingList('5k jog'), ['👟 Running shoes']);
  assert.deepEqual(extractPackingList('sprint 200m'), ['👟 Running shoes']);
});

test('extractPackingList: jump rope variants → 🪢', () => {
  assert.deepEqual(extractPackingList('50 double-unders'), ['🪢 Jump rope']);
  assert.deepEqual(extractPackingList('40 DU'), ['🪢 Jump rope']);
});

test('extractPackingList: gymnastics variants → 🤲', () => {
  assert.deepEqual(extractPackingList('3 muscle ups'), ['🤲 Hand grips + wrist tape']);
  assert.deepEqual(extractPackingList('strict pull-ups'), ['🤲 Hand grips + wrist tape']);
  assert.deepEqual(extractPackingList('T2B 15 reps'), ['🤲 Hand grips + wrist tape']);
  assert.deepEqual(extractPackingList('TTB/HKR'), ['🤲 Hand grips + wrist tape']);
});

test('extractPackingList: barbell variants → 🦺', () => {
  assert.deepEqual(extractPackingList('5x5 back squat'), ['🦺 Lifting belt']);
  assert.deepEqual(extractPackingList('deadlift heavy'), ['🦺 Lifting belt']);
  assert.deepEqual(extractPackingList('clusters (50/35)'), ['🦺 Lifting belt']);
  assert.deepEqual(extractPackingList('Tall Jerks'), ['🦺 Lifting belt']);
});

test('extractPackingList: kettlebell → 💪', () => {
  assert.deepEqual(extractPackingList('30 kettlebell swings'), ['💪 Kettlebell']);
});

test('extractPackingList: compound workout returns multiple items', () => {
  const r = extractPackingList('10k run, 30 double-unders, 5x5 deadlift, 3 muscle ups');
  assert.equal(r.includes('👟 Running shoes'), true);
  assert.equal(r.includes('🪢 Jump rope'), true);
  assert.equal(r.includes('🦺 Lifting belt'), true);
  assert.equal(r.includes('🤲 Hand grips + wrist tape'), true);
});

test('extractPackingList: empty workout returns []', () => {
  assert.deepEqual(extractPackingList(''), []);
  assert.deepEqual(extractPackingList('Warm up: foam roll'), []);
});

test('extractPackingList: deduplicates when multiple matches in same category', () => {
  // squat + deadlift + clean should still produce ONE belt entry
  const r = extractPackingList('back squat, deadlift, clean');
  assert.equal(r.filter(x => x.includes('belt')).length, 1);
});

test('extractPackingList: items appear in canonical order (running → rope → grips → belt → kb)', () => {
  const r = extractPackingList('30 kettlebell swings, deadlift, muscle ups, double unders, 400m run');
  assert.deepEqual(r, [
    '👟 Running shoes',
    '🪢 Jump rope',
    '🤲 Hand grips + wrist tape',
    '🦺 Lifting belt',
    '💪 Kettlebell',
  ]);
});

// ---- packing block ----

test('buildPackingBlock: returns empty string if no gear matched', () => {
  assert.equal(buildPackingBlock('foam roll'), '');
});

test('buildPackingBlock: vertical layout with bold header', () => {
  const b = buildPackingBlock('5x5 deadlift, muscle ups');
  assert.equal(b.startsWith('\n\n🎒 *Packing list:*\n'), true);
  assert.equal(b.includes('\n🤲 Hand grips + wrist tape'), true);
  assert.equal(b.includes('\n🦺 Lifting belt'), true);
});

// ---- DM assembly ----

test('assembleDM: header, body, packing block in order', () => {
  const dm = assembleDM({
    dateYmd: '2026-05-21',
    kind: 'FIT',
    formattedBody: '*PHASE 1: W8*\n\n*A. Strength*\n  A1. 2 Front Squats',
    rawWorkoutForPacking: 'front squat 2x2',
  });
  assert.equal(dm.startsWith('🏋️ *Thu 21-05-2026 . FIT*'), true);
  assert.equal(dm.includes('*PHASE 1: W8*'), true);
  assert.equal(dm.includes('🎒 *Packing list:*'), true);
  assert.equal(dm.includes('🦺 Lifting belt'), true);
});

test('assembleDM: skips packing block when raw has no gear keywords', () => {
  const dm = assembleDM({
    dateYmd: '2026-05-21',
    kind: 'FIT',
    formattedBody: '*Mobility*\n\n  Foam roll 5 min',
    rawWorkoutForPacking: 'foam roll',
  });
  assert.equal(dm.includes('🎒'), false);
});

// ---- sanitize ----

test('sanitizeAssertions: clean DM has no issues', () => {
  const dm = '🏋️ *Thu 21-05-2026 . FIT*\n\n*A. Strength*\n  A1. 5 Back Squats\n\n_📝 Pace early._\n\n🎒 *Packing list:*\n🦺 Lifting belt';
  assert.deepEqual(sanitizeAssertions(dm), []);
});

test('sanitizeAssertions: catches em-dash regression', () => {
  const dm = '🏋️ *Tomorrow — FIT*\n\nA1. squats';
  assert.equal(sanitizeAssertions(dm).some(i => i.includes('em-dash')), true);
});

test('sanitizeAssertions: catches Show full workout artifact leak', () => {
  const dm = '🏋️ *Thu*\n\nA1. squats\n\nShow less';
  assert.equal(sanitizeAssertions(dm).some(i => i.includes('Show less')), true);
});

// ---- schedule filter (extracted logic from wodup-daily-send) ----

// Inlined here to test the same way the sender uses it.
function dayOfWeekFor(dateYmd) {
  const d = new Date(`${dateYmd}T00:00:00+08:00`);
  return DOW_SHORT[d.getDay()];
}
function scheduledClasses(user, dateYmd) {
  if (!user || !user.schedule) return [];
  const dow = dayOfWeekFor(dateYmd);
  const day = user.schedule[dow];
  if (!day) return [];
  if (!Array.isArray(day)) return [day];
  return day;
}

test('scheduledClasses: user with null schedule returns []', () => {
  assert.deepEqual(scheduledClasses({ id: 'yash', schedule: null }, '2026-05-21'), []);
});

test('scheduledClasses: user with no entry for that day returns []', () => {
  const user = { id: 'cheryl', schedule: { Mon: [{ kind: 'FIT' }] } };
  assert.deepEqual(scheduledClasses(user, '2026-05-21'), []); // Thu
});

test('scheduledClasses: Mer Thu BURN+FIT returns both', () => {
  const user = {
    id: 'melissa',
    schedule: {
      Thu: [
        { kind: 'BURN', primaryTime: '6:30pm' },
        { kind: 'FIT',  primaryTime: '7:30pm' },
      ],
    },
  };
  const got = scheduledClasses(user, '2026-05-21');
  assert.equal(got.length, 2);
  assert.equal(got[0].kind, 'BURN');
  assert.equal(got[1].kind, 'FIT');
});

test('scheduledClasses: Cheryl Thu single BURN returns [BURN]', () => {
  const user = {
    id: 'cheryllee',
    schedule: { Thu: { kind: 'BURN', primaryTime: '7:00am' } },
  };
  const got = scheduledClasses(user, '2026-05-21');
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'BURN');
});

// ── classesFor: manifest precedence (regression — 2026-05-22 Yash skipped) ──
// The real exported function reads runs/bookings-<date>.json. Write a fixture
// file with a sentinel date and assert that schedule:null users get classes
// from the manifest, while users with a schedule still get theirs.

const fs = require('node:fs');
const path = require('node:path');
const realSender = require('./wodup-daily-send');

const FIXTURE_DATE = '2099-01-15';
const FIXTURE_PATH = path.join(__dirname, 'runs', `bookings-${FIXTURE_DATE}.json`);

function writeManifest(bookings) {
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify({
    date: FIXTURE_DATE,
    updated: new Date().toISOString(),
    runId: 'test-fixture',
    bookings,
  }));
}
function cleanupManifest() { try { fs.unlinkSync(FIXTURE_PATH); } catch {} }

test('manifestClasses: returns [] when no manifest exists', () => {
  cleanupManifest();
  const got = realSender.manifestClasses({ id: 'yash' }, FIXTURE_DATE);
  assert.deepEqual(got, []);
});

test('manifestClasses: returns booked classes for the right user', () => {
  writeManifest({
    yash: [{ kind: 'Gymnastics', time: '1:00pm' }],
    dani: [{ kind: 'Gymnastics', time: '1:00pm' }],
  });
  const got = realSender.manifestClasses({ id: 'yash' }, FIXTURE_DATE);
  assert.deepEqual(got, [{ kind: 'Gymnastics', primaryTime: '1:00pm' }]);
  cleanupManifest();
});

test('manifestClasses: returns [] for user not in manifest', () => {
  writeManifest({ yash: [{ kind: 'Gymnastics', time: '1:00pm' }] });
  const got = realSender.manifestClasses({ id: 'cheryllee' }, FIXTURE_DATE);
  assert.deepEqual(got, []);
  cleanupManifest();
});

test('classesFor: schedule:null user gets manifest entries (the actual bug)', () => {
  writeManifest({ yash: [{ kind: 'FIT', time: '6:30am' }] });
  const got = realSender.classesFor({ id: 'yash', schedule: null }, FIXTURE_DATE);
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'FIT');
  assert.equal(got[0].primaryTime, '6:30am');
  cleanupManifest();
});

test('classesFor: with schedule AND manifest, both surface (de-duped)', () => {
  writeManifest({
    cheryllee: [
      { kind: 'BURN', time: '7:00am' },        // matches schedule, de-duped
      { kind: 'FIT',  time: '8:30am' },        // extra
    ],
  });
  const user = { id: 'cheryllee', schedule: { Wed: { kind: 'BURN', primaryTime: '7:00am' } } };
  // 2099-01-15 is a Thursday in real life, but for the schedule test we want
  // a day with a hit — use a Wed by adjusting fixture date.
  const wedFixture = '2099-01-14'; // Wed
  const wedPath = path.join(__dirname, 'runs', `bookings-${wedFixture}.json`);
  fs.writeFileSync(wedPath, JSON.stringify({
    date: wedFixture,
    updated: new Date().toISOString(),
    runId: 'test-fixture',
    bookings: { cheryllee: [{ kind: 'BURN', time: '7:00am' }, { kind: 'FIT', time: '8:30am' }] },
  }));
  const got = realSender.classesFor(user, wedFixture);
  // De-dupe means BURN@7:00am appears once even though both sources have it.
  const keys = got.map(c => `${c.kind}|${c.primaryTime}`).sort();
  assert.deepEqual(keys, ['BURN|7:00am', 'FIT|8:30am']);
  try { fs.unlinkSync(wedPath); } catch {}
  cleanupManifest();
});

test('classesFor: returns [] when neither schedule nor manifest has the user', () => {
  cleanupManifest();
  const got = realSender.classesFor({ id: 'ghost', schedule: null }, FIXTURE_DATE);
  assert.deepEqual(got, []);
});
