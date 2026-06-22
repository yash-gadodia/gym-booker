// Daily CrossFit tip for the night-before workout DM, tailored to the actual
// movements in tomorrow's session. LLM-generated (claude-cli) when available for
// a sharp, specific cue; falls back to a curated movement->cue library so a
// genuinely useful tip ALWAYS lands even when the LLM is down (same reliability
// lesson as the workout-body fallback). Used by wodup-daily-send.js.
const { spawnSync } = require('child_process');
const { looksLikeError } = require('./wodup-formatter');

const CLAUDE_BIN = '/Users/yash/.local/bin/claude';

// Ordered by priority: most technical / injury-prone movements first, so a mixed
// workout surfaces the cue that matters most. First match wins.
const MOVEMENT_TIPS = [
  { key: 'snatch',        re: /\bsnatch/i,                              tip: 'Snatch: keep the bar close and finish your hips before you pull under. Patience off the floor beats yanking it up.' },
  { key: 'clean',         re: /\bclean/i,                               tip: 'Cleans: drive through the heels and meet the bar with fast elbows. A loud catch usually means you cut the pull short.' },
  { key: 'deadlift',      re: /\bdead\s?lift/i,                         tip: 'Deadlifts: set your lats and brace HARD before the bar moves. Push the floor away instead of lifting with your lower back.' },
  { key: 'overhead_squat',re: /\boverhead squat|\bohs\b/i,             tip: 'Overhead squats: push UP into the bar (active shoulders) and screw your feet into the floor for a stable bottom.' },
  { key: 'front_squat',   re: /\bfront squat/i,                         tip: 'Front squats: elbows high, big breath into the belly, hit depth before you stand. Let the legs work, not the back.' },
  { key: 'back_squat',    re: /\bback squat/i,                          tip: 'Back squats: brace before you unrack, sit between your hips, and drive the whole foot through the floor.' },
  { key: 'thruster',      re: /\bthruster/i,                            tip: 'Thrusters: ride the bounce out of the squat to launch the bar. Let leg drive do the overhead work so your arms last.' },
  { key: 'wall_ball',     re: /\bwall ?ball/i,                          tip: 'Wall balls: full squat then hip-drive the throw. Aim just above the line so you catch in rhythm and avoid no-reps.' },
  { key: 'box_jump',      re: /\bbox jump/i,                            tip: 'Box jumps: land soft with hips back, stand tall to finish. If reps are high, step down to protect your achilles.' },
  { key: 'kb_swing',      re: /\b(kettlebell|kb) swing/i,               tip: 'KB swings: it is a hip snap, not a squat or an arm raise. Float the bell with your hips, do not muscle it up.' },
  { key: 'goblet_squat',  re: /\bgoblet squat/i,                        tip: 'Goblet squats: elbows inside the knees at the bottom, chest tall. Control the way down, drive up hard.' },
  { key: 'pull_up',       re: /\b(pull[ -]?ups?|c2b|chest[ -]?to[ -]?bar)\b/i, tip: 'Pull-ups: break into planned sets BEFORE failure. Small sets with short rest beat one big set then a long stall.' },
  { key: 'toes_to_bar',   re: /\b(toes[ -]?to[ -]?bar|t2b|ttb)\b/i,     tip: 'Toes-to-bar: drive a kip rhythm and push down on the bar. Break early to save your grip for later rounds.' },
  { key: 'hspu',          re: /\b(handstand push|hspu)\b/i,             tip: 'HSPU: hands stacked under shoulders, tight midline, and use a leg kip once reps get heavy.' },
  { key: 'muscle_up',     re: /\bmuscle[ -]?up/i,                       tip: 'Muscle-ups: fast turnover and a tight false grip. Singles with a clean transition beat missed reps in a row.' },
  { key: 'burpee',        re: /\bburpee/i,                              tip: 'Burpees: lock ONE steady pace from rep 1. Consistent breathing is faster than sprint-then-stall.' },
  { key: 'double_under',  re: /\b(double[ -]?unders?|du\b)/i,           tip: 'Double-unders: relax the shoulders and spin from the wrists, stay tall. Most trip-ups come from piking at the hips.' },
  { key: 'row',           re: /\brow(ing|er|erg)?\b/i,                  tip: 'Rowing: legs > lean > arms, then arms > hips > legs back. Power per stroke beats a frantic stroke rate.' },
  { key: 'ski',           re: /\bski[ -]?erg|\bskierg\b/i,              tip: 'SkiErg: drive with the hips and lats, not just arms. Long powerful pulls beat short choppy ones.' },
  { key: 'bike_erg',      re: /\b(bike ?erg|assault bike|echo bike|\bbike\b)/i, tip: 'BikeErg: settle into a sustainable cadence early. Going 100% on the bike first is the classic blow-up.' },
  { key: 'run',           re: /\b(\d+\s?m(eter)? run|running|\brun\b)/i, tip: 'Running: hold a pace you can repeat. Negative-split if anything, do not sprint the first interval.' },
  { key: 'press',         re: /\b(push press|shoulder press|strict press|push jerk|\bjerk\b)/i, tip: 'Presses: brace the belly and squeeze the glutes so power transfers up. Do not let your ribs flare.' },
  { key: 'lunge',         re: /\b(lunge|split squat)/i,                 tip: 'Lunges: long step, tall torso, drive through the front heel. Keep the knee tracking out, do not let it cave.' },
];

// Day-varied general cues for the rare workout with no recognised movement.
const GENERIC_TIPS = [
  'Warm up properly. The first round of the workout is not your warm-up.',
  'Pick your scaling BEFORE the clock starts so you can move with intent.',
  'Breathe on a rhythm. Held breath under fatigue is wasted energy.',
  'Hydrate tonight and in the morning. You perform how you prep.',
  'Set up your station and spacing before "3, 2, 1" so you are not scrambling.',
];

function detectMovements(text) {
  const t = String(text || '');
  return MOVEMENT_TIPS.filter((m) => m.re.test(t)).map((m) => m.key);
}

// Deterministic tip: the highest-priority detected movement, else a generic tip
// chosen by genericIndex (date-seeded by the caller) so it rotates day to day.
function pickTip(text, { genericIndex = 0 } = {}) {
  const t = String(text || '');
  for (const m of MOVEMENT_TIPS) {
    if (m.re.test(t)) return { tip: m.tip, source: 'movement', movement: m.key };
  }
  const n = GENERIC_TIPS.length;
  const idx = (((genericIndex % n) + n) % n);
  return { tip: GENERIC_TIPS[idx], source: 'generic', movement: null };
}

function tipViaClaude(text, kind, { claudeBin = CLAUDE_BIN } = {}) {
  const prompt = `You are an experienced CrossFit coach. Based ONLY on the movements in tomorrow's ${kind} workout below, give ONE genuinely useful coaching cue (technique, pacing, breathing, or scaling) that names a specific movement from the workout. One sentence, under 160 characters. No em-dashes. No preamble or sign-off. Output the cue only.

WORKOUT:
${text}`;
  const r = spawnSync(claudeBin, ['--dangerously-skip-permissions', '-p', prompt], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`claude tip failed (status=${r.status})`);
  return (r.stdout || '').trim();
}

// Build the tip: try the LLM for a sharp movement-specific cue, fall back to the
// curated library. Never throws. Returns { tip, source, movement? }.
function buildTip(text, kind, { genericIndex = 0, claudeBin } = {}) {
  try {
    const out = tipViaClaude(text, kind, claudeBin ? { claudeBin } : {});
    const clean = out.replace(/—/g, '-').replace(/^["']|["']$/g, '').trim();
    if (clean.length >= 15 && clean.length <= 280 && !looksLikeError(clean)) {
      return { tip: clean, source: 'claude', movement: null };
    }
  } catch (_) { /* fall through to deterministic library */ }
  return pickTip(text, { genericIndex });
}

// Stable per-day seed from a YYYY-MM-DD string (for rotating generic tips).
function dateSeed(dateYmd) {
  return parseInt(String(dateYmd || '').replace(/-/g, ''), 10) || 0;
}

module.exports = { MOVEMENT_TIPS, GENERIC_TIPS, detectMovements, pickTip, tipViaClaude, buildTip, dateSeed };
