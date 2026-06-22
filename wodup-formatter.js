// Wodup workout DM formatting helpers.
//
// Layout (approved by Yash 2026-05-20):
//   🏋️ *<Day> <DD-MM-YYYY> . <KIND>*
//
//   *<PROGRAM LABEL>*
//
//   *<SECTION HEADER>*
//     <MOVEMENT 1>
//     <MOVEMENT 2>
//
//   _📝 <one-line coach tip>_
//
//   🎒 *Packing list:*
//   <emoji> <gear label>
//
// Coach-tip + section structure is synthesized by claude-cli (-p mode);
// header/date and packing list are deterministic.

const { spawnSync } = require('child_process');

const CLAUDE_BIN = '/Users/yash/.local/bin/claude';

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayOfWeekShort(dateYmd) {
  const d = new Date(`${dateYmd}T00:00:00+08:00`);
  return DOW_SHORT[d.getDay()];
}

function dmyDate(dateYmd) {
  const [yyyy, mm, dd] = dateYmd.split('-');
  return `${dd}-${mm}-${yyyy}`;
}

function buildHeader(dateYmd, kind) {
  return `🏋️ *${dayOfWeekShort(dateYmd)} ${dmyDate(dateYmd)} . ${kind}*`;
}

// Deterministic keyword scan. Emoji + descriptive label per item, one per line.
function extractPackingList(workoutText) {
  const t = String(workoutText || '').toLowerCase();
  const gear = [];

  if (/\b(run|jog|sprint)\b|400m|800m|1\s*(mile|km)|5k|10k/.test(t)) {
    gear.push('👟 Running shoes');
  }
  if (/jump\s*rope|double[\s-]*under|\bdu\b|single[\s-]*under|\bsu\b/.test(t)) {
    gear.push('🪢 Jump rope');
  }
  if (/gymnastics|muscle[\s-]*up|\bmu\b|pull[\s-]*ups?|pullup|toes?[\s-]*to[\s-]*bar|\bt2b\b|\bttb\b|\bhkr\b|kipping|\bring\b/.test(t)) {
    gear.push('🤲 Hand grips + wrist tape');
  }
  if (/\b(squats?|deadlifts?|cleans?|snatch(es)?|jerks?|press(es)?|thrusters?|clusters?)\b|\bdl\b/.test(t)) {
    gear.push('🦺 Lifting belt');
  }
  if (/\b(kettlebell|kb)\b/.test(t)) {
    gear.push('💪 Kettlebell');
  }
  return [...new Set(gear)];
}

function buildPackingBlock(workoutText) {
  const items = extractPackingList(workoutText);
  if (items.length === 0) return '';
  return `\n\n🎒 *Packing list:*\n${items.join('\n')}`;
}

// Call claude-cli to reformat raw Wodup text into approved section/movement
// structure with one italic coach tip. Synchronous via spawnSync.
// Uses claude-cli (Claude Max sub), NOT the paid Anthropic API, per
// feedback_no_anthropic_api_for_scripts.
function reformatBodyViaClaude(rawWorkout, kind, { claudeBin = CLAUDE_BIN } = {}) {
  const prompt = `You are formatting a CrossFit workout for a Telegram DM that someone will read on their phone the night before class. Rewrite the raw Wodup text below for maximum on-phone readability.

REQUIREMENTS:
- First line: bold program label if present (e.g. *PHASE 1: W8 (Week B)*). Skip if none.
- Blank line, then sections in order (Warm Up / A / B / C / D).
- Each section header bold (e.g. *A. Strength . 4 sets, every 3 min*). Synthesize a short header from the section content.
- Each movement on its OWN indented line (two-space indent). Combine "A1." with the movement name on a single line. Reps and loads inline, e.g. "A1. 6 Shoulder Presses (3s pause)".
- Strip noise: "Show less", "Show full workout", "Log Result", "Leaderboard", "Scoring", "Time (lower is better)".
- After the last section, ONE blank line then ONE italic synthesized coach tip in _underscores_ (one sentence, under 140 chars). Synthesize from coach commentary. Start with "_📝 ".
- ABSOLUTELY NO em-dashes. Use periods, colons, or parens.
- Use Telegram Markdown: *bold*, _italic_. No headings, no other syntax.
- Keep total length under 700 chars.
- Output the formatted workout ONLY. No preamble, no trailing explanation.

KIND: ${kind}

RAW:
${rawWorkout}`;

  const r = spawnSync(claudeBin, ['--dangerously-skip-permissions', '-p', prompt], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`claude -p failed (status=${r.status}): ${r.stderr.slice(0, 300)}`);
  }
  return r.stdout.trim();
}

// Deterministic, no-LLM cleanup of the raw Wodup text. Used as the fallback
// when claude-cli is unavailable (auth wedge / outage) or returns an error
// string — so the night-before workout DM ALWAYS goes out instead of being
// silently skipped (the 2026-06-22 "not really working" symptom: the reformat
// depended on the same claude-cli that was 401'ing). The raw is already quite
// readable; we just strip UI noise and em-dashes.
const WODUP_NOISE = /^(view warm up|view cool down|show less|show full workout|show more|log result|leaderboard|scoring|score|time \(lower is better\)|view results?|results?|comments?|like|share)$/i;
function cleanRawBody(raw) {
  return String(raw || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !WODUP_NOISE.test(l))
    .join('\n')
    .replace(/—/g, '-')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// True if the "formatted" text is actually a claude-cli error leaking through
// (it can exit 0 yet print "API Error: 401" / "Overloaded" to stdout) or is
// implausibly short to be a real workout.
function looksLikeError(text) {
  const t = String(text || '').trim();
  if (t.length < 20) return true;
  return /(api error|failed to authenticate|invalid authentication|overloaded|usage limit|rate limit|\b401\b|\b429\b|\b529\b)/i.test(t);
}

// Format a workout body for the DM: try claude-cli for the pretty version, but
// fall back to the cleaned raw on any failure or error-looking output. Returns
// { body, source }. Never throws.
function formatBody(raw, kind, opts = {}) {
  try {
    const out = reformatBodyViaClaude(raw, kind, opts);
    if (!looksLikeError(out)) return { body: out, source: 'claude' };
  } catch (_) { /* fall through to deterministic fallback */ }
  return { body: cleanRawBody(raw), source: 'raw-fallback' };
}

function assembleDM({ dateYmd, kind, formattedBody, rawWorkoutForPacking }) {
  const header = buildHeader(dateYmd, kind);
  const packing = buildPackingBlock(rawWorkoutForPacking || formattedBody);
  return `${header}\n\n${formattedBody}${packing}`;
}

function sanitizeAssertions(dm) {
  const issues = [];
  if (dm.includes('—')) issues.push('contains em-dash');
  if (/show (less|full workout)/i.test(dm)) issues.push('contains Show less / Show full workout artifact');
  if (dm.length > 1500) issues.push(`dm length ${dm.length} > 1500`);
  return issues;
}

// Backwards-compat shim for any caller still importing formatWorkoutDM.
// Returns a DM assembled with the OLD (non-LLM) layout — used only if the
// caller hasn't migrated yet. New code should call assembleDM directly.
function formatWorkoutDM(workoutText, workoutKind, dateYmd) {
  return assembleDM({
    dateYmd,
    kind: workoutKind,
    formattedBody: workoutText,
    rawWorkoutForPacking: workoutText,
  });
}

module.exports = {
  DOW_SHORT,
  dayOfWeekShort,
  dmyDate,
  buildHeader,
  extractPackingList,
  buildPackingBlock,
  reformatBodyViaClaude,
  cleanRawBody,
  looksLikeError,
  formatBody,
  assembleDM,
  sanitizeAssertions,
  formatWorkoutDM,
};
