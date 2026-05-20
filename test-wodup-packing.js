const { extractPackingList } = require('./wodup-formatter');

const tests = [
  {
    name: '5k run for time',
    text: '5k run for time',
    expected: ['👟 Running shoes']
  },
  {
    name: '50 double-unders',
    text: '50 double-unders',
    expected: ['🪢 Jump rope']
  },
  {
    name: '3 muscle ups',
    text: '3 muscle ups',
    expected: ['🤲 Hand grips + wrist tape']
  },
  {
    name: '5x5 back squat',
    text: '5 x 5 back squat',
    expected: ['🦺 Lifting belt']
  },
  {
    name: 'warm up foam roll',
    text: 'Warm up: foam roll',
    expected: []
  },
  {
    name: 'complex workout',
    text: '10k run then 20 muscle ups, 5x5 deadlift',
    expected: ['👟 Running shoes', '🤲 Hand grips + wrist tape', '🦺 Lifting belt']
  },
  {
    name: 'kettlebell workout',
    text: '30 kettlebell swings, 20 KB cleans',
    expected: ['💪 Kettlebell', '🦺 Lifting belt']
  }
];

let passed = 0;
let failed = 0;

tests.forEach(test => {
  const result = extractPackingList(test.text);
  const resultStr = JSON.stringify(result.sort());
  const expectedStr = JSON.stringify(test.expected.sort());
  
  if (resultStr === expectedStr) {
    console.log(`✓ ${test.name}`);
    passed++;
  } else {
    console.log(`✗ ${test.name}`);
    console.log(`  Expected: ${expectedStr}`);
    console.log(`  Got: ${resultStr}`);
    failed++;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
