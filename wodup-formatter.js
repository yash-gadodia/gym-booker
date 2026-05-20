// Workout formatting utilities

function extractPackingList(workoutText) {
  const gear = [];
  const lower = workoutText.toLowerCase();

  // Running
  if (/\b(run|jog|sprint)\b|400m|800m|(1\s*(mile|km))|5k|10k/.test(lower)) {
    gear.push('👟 Running shoes');
  }

  // Jump rope
  if (/jump\s*rope|double[\s-]*under|du|single[\s-]*under|su/.test(lower)) {
    gear.push('🪢 Jump rope');
  }

  // Gymnastics (muscle up, pull-up, toes-to-bar, etc)
  if (/gymnastics|muscle[\s-]*up|mu|pull[\s-]*up|pullup|toes?[\s-]*to[\s-]*bar|t2b|kipping|ring/.test(lower)) {
    gear.push('🤲 Hand grips + wrist tape');
  }

  // Barbell
  if (/\b(squat|deadlift|cleans?|snatch|jerk|press|thruster)\b|dl\b/.test(lower)) {
    gear.push('🦺 Lifting belt');
  }

  // Kettlebell
  if (/\b(kettlebell|kb)\b/.test(lower)) {
    gear.push('💪 Kettlebell');
  }

  // Remove duplicates
  return [...new Set(gear)];
}

function formatWorkoutDM(workoutText, workoutKind, dateYmd) {
  const [yyyy, mm, dd] = dateYmd.split('-');
  const dateStr = `${dd}-${mm}-${yyyy}`;
  const dayOfWeek = new Date(`${dateYmd}T00:00:00Z`).toLocaleDateString('en-SG', { weekday: 'short' }).toUpperCase();

  const packingList = extractPackingList(workoutText);
  const packingText = packingList.length > 0 ? `\n\n🎒 *Packing list:*\n${packingList.join('\n')}` : '';

  return `🏋️ *Tomorrow's workout — ${workoutKind}*\n📅 ${dayOfWeek} ${dateStr}\n\n${workoutText}${packingText}`;
}

module.exports = {
  extractPackingList,
  formatWorkoutDM
};
