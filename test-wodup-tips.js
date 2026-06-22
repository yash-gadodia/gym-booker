// Tests for the movement-based daily CrossFit tip (2026-06-22 feature).
const { test } = require('node:test');
const assert = require('node:assert');
const { detectMovements, pickTip, buildTip, dateSeed, GENERIC_TIPS } = require('./wodup-tips');

const RAW_FIT = `PHASE 2: W1 (A)
4 alternating sets of:
A1. 5 Front Squats
A2. 12 Barbell Hip Thrusts
B. EMOM 90s for 30 min:
6 Burpees Over Kettlebell
12 Goblet Squats @ 32/24 kg
Max calorie BikeErg`;

test('detectMovements finds the movements present', () => {
  const found = detectMovements(RAW_FIT);
  assert.ok(found.includes('front_squat'), 'front squat');
  assert.ok(found.includes('burpee'), 'burpee');
  assert.ok(found.includes('goblet_squat'), 'goblet squat');
  assert.ok(found.includes('bike_erg'), 'bikeerg');
});

test('pickTip returns a movement cue mentioning a real movement (priority order)', () => {
  const { tip, source, movement } = pickTip(RAW_FIT);
  assert.strictEqual(source, 'movement');
  // front_squat outranks burpee/goblet/bike in MOVEMENT_TIPS order
  assert.strictEqual(movement, 'front_squat');
  assert.match(tip, /front squat/i);
});

test('pickTip falls back to a generic cue when no movement recognised', () => {
  const { tip, source } = pickTip('rest day / mobility flow');
  assert.strictEqual(source, 'generic');
  assert.ok(GENERIC_TIPS.includes(tip));
});

test('generic tip rotates with the date seed', () => {
  const a = pickTip('xyz', { genericIndex: dateSeed('2026-06-23') }).tip;
  const b = pickTip('xyz', { genericIndex: dateSeed('2026-06-24') }).tip;
  assert.notStrictEqual(a, b, 'consecutive days give different generic tips');
});

test('no tip contains an em-dash (Telegram sanitize guard)', () => {
  const { MOVEMENT_TIPS } = require('./wodup-tips');
  for (const m of MOVEMENT_TIPS) assert.ok(!m.tip.includes('—'), `${m.key} has em-dash`);
  for (const g of GENERIC_TIPS) assert.ok(!g.includes('—'), 'generic has em-dash');
});

test('buildTip falls back to the library when claude-cli is down (never throws)', () => {
  let res;
  assert.doesNotThrow(() => { res = buildTip(RAW_FIT, 'FIT', { claudeBin: '/usr/bin/false' }); });
  assert.ok(['movement', 'generic'].includes(res.source), `got ${res.source}`);
  assert.ok(res.tip.length >= 15);
});

test('dateSeed is stable and numeric', () => {
  assert.strictEqual(dateSeed('2026-06-24'), 20260624);
  assert.strictEqual(dateSeed(''), 0);
});
