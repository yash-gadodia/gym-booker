// Tests for the WODUP no-LLM fallback (2026-06-22): the night-before workout DM
// must still go out when claude-cli is down. formatBody must never throw and
// must fall back to the cleaned raw workout on reformat failure / error output.
const { test } = require('node:test');
const assert = require('node:assert');
const { cleanRawBody, looksLikeError, formatBody } = require('./wodup-formatter');

const RAW_FIT = `PHASE 2: W1 (A)
Warm Up
View Warm Up
4 alternating sets of:
A1.
5 Front Squats
Show less
A2.
12 Barbell Hip Thrusts
Log Result`;

test('cleanRawBody strips UI noise and keeps the workout', () => {
  const out = cleanRawBody(RAW_FIT);
  assert.ok(out.includes('5 Front Squats'), 'keeps movements');
  assert.ok(out.includes('PHASE 2: W1 (A)'), 'keeps program label');
  assert.ok(!/view warm up/i.test(out), 'strips View Warm Up');
  assert.ok(!/show less/i.test(out), 'strips Show less');
  assert.ok(!/log result/i.test(out), 'strips Log Result');
});

test('cleanRawBody removes em-dashes (sanitizeAssertions guard)', () => {
  assert.ok(!cleanRawBody('do this — then that').includes('—'));
});

test('looksLikeError flags claude-cli auth/overload leaks', () => {
  assert.strictEqual(looksLikeError('Failed to authenticate. API Error: 401 Invalid authentication credentials'), true);
  assert.strictEqual(looksLikeError('API Error: 529 Overloaded'), true);
  assert.strictEqual(looksLikeError(''), true);
  assert.strictEqual(looksLikeError('ok'), true, 'too short');
});

test('looksLikeError accepts a real workout body', () => {
  assert.strictEqual(looksLikeError(RAW_FIT), false);
});

test('formatBody falls back to cleaned raw when claude binary fails', () => {
  const { body, source } = formatBody(RAW_FIT, 'FIT', { claudeBin: '/usr/bin/false' });
  assert.strictEqual(source, 'raw-fallback');
  assert.ok(body.includes('5 Front Squats'), 'fallback still contains the workout');
  assert.ok(!/show less/i.test(body), 'fallback is cleaned');
});

test('formatBody never throws even with a bogus binary path', () => {
  assert.doesNotThrow(() => formatBody(RAW_FIT, 'FIT', { claudeBin: '/no/such/bin' }));
  const { source } = formatBody(RAW_FIT, 'FIT', { claudeBin: '/no/such/bin' });
  assert.strictEqual(source, 'raw-fallback');
});
