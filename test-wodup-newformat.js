// One-shot test: pull tomorrow's FIT workout from Wodup, reformat per
// the new product spec (pack on top, indented moves, italic coach tip),
// DM Yash only (166637821). NO state file written, no other recipients.

require('dotenv').config();
const { spawnSync } = require('child_process');
const { fetchWorkouts } = require('./wodup-client');

const YASH_CHAT_ID = 166637821;
const DATE = process.argv[2] || '2026-05-21';
const KIND = (process.argv[3] || 'FIT').toUpperCase();

function packingList(text) {
  const t = text.toLowerCase();
  const gear = [];
  if (/\b(run|jog|sprint)\b|400m|800m|1\s*(mile|km)|5k|10k/.test(t)) gear.push('running shoes');
  if (/jump\s*rope|double[\s-]*under|\bdu\b|single[\s-]*under|\bsu\b/.test(t)) gear.push('jump rope');
  if (/gymnastics|muscle[\s-]*up|\bmu\b|pull[\s-]*ups?|pullup|toes?[\s-]*to[\s-]*bar|\bt2b\b|\bttb\b|\bhkr\b|kipping|ring/.test(t)) gear.push('grips, tape');
  if (/\b(squat|deadlift|cleans?|snatch|jerk|press|thruster|cluster)\b|\bdl\b/.test(t)) gear.push('belt');
  if (/\b(kettlebell|kb)\b/.test(t)) gear.push('grips');
  return [...new Set(gear)];
}

function reformatWithClaude(rawWorkout, kind) {
  const prompt = `You are formatting a CrossFit workout for a Telegram DM that someone will read on their phone the night before class. Rewrite the raw Wodup text below for maximum on-phone readability.

REQUIREMENTS:
- First line: bold program label if present (e.g. *PHASE 1: W8 (Week B)*). Skip if none.
- Blank line, then sections in order (Warm Up / A / B / C / D).
- Each section header bold (e.g. *A. Strength . 4 sets, every 3 min*). Synthesize a short header from the section content.
- Each movement on its OWN indented line (two-space indent). Combine "A1." with the movement name on a single line. Reps and loads inline, e.g. "A1. 6 Shoulder Presses (3s pause)".
- Strip noise: "Show less", "Show full workout", "Log Result", "Leaderboard", "Scoring", "Time (lower is better)".
- After the last section, ONE blank line then ONE italic synthesized coach tip in _underscores_ (one sentence, kept under 140 chars). Synthesize from coach commentary. Start with "_📝 ".
- ABSOLUTELY NO em-dashes (—). Use periods, colons, or parens.
- Use Telegram Markdown: *bold*, _italic_. No headings, no other syntax.
- Keep total length under 700 chars.
- Output the formatted workout ONLY. No preamble, no trailing explanation.

KIND: ${kind}

RAW:
${rawWorkout}`;

  const r = spawnSync('/Users/yash/.local/bin/claude', ['--dangerously-skip-permissions', '-p', prompt], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error('claude -p failed: ' + r.stderr);
  }
  return r.stdout.trim();
}

async function send(text) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: YASH_CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
  const j = await r.json();
  return { status: r.status, body: j };
}

(async () => {
  console.log(`fetching Wodup workouts for ${DATE} ...`);
  const workouts = await fetchWorkouts(DATE);
  const raw = workouts[KIND];
  if (!raw) {
    console.error(`No ${KIND} workout for ${DATE}. Available: ${Object.keys(workouts).join(', ')}`);
    process.exit(1);
  }
  console.log(`raw ${KIND} workout (${raw.length} chars):\n${raw}\n---`);

  console.log('reformatting via claude -p ...');
  const formatted = reformatWithClaude(raw, KIND);
  console.log(`formatted:\n${formatted}\n---`);

  const pack = packingList(raw);
  const packLine = pack.length ? `🎒 Bring: ${pack.join(', ')}\n` : '';

  const [yyyy, mm, dd] = DATE.split('-');
  const dow = new Date(`${DATE}T00:00:00+08:00`).toLocaleDateString('en-SG', {
    weekday: 'short', timeZone: 'Asia/Singapore',
  });
  const header = `🏋️ *${dow} ${dd}-${mm}-${yyyy} . ${KIND}*`;

  const dm = `${header}\n${packLine}\n${formatted}`;

  console.log(`\nfinal DM (${dm.length} chars):\n${dm}\n---`);

  const r = await send(dm);
  console.log(`TG: HTTP ${r.status}, ok=${r.body && r.body.ok}, message_id=${r.body && r.body.result && r.body.result.message_id}`);
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
