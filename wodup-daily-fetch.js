// Fetch workouts for a given date from Wodup.
// Usage: node wodup-daily-fetch.js YYYY-MM-DD
// Output: writes to stdout (used by run-wodup-daily.sh)

const { fetchWorkouts } = require('./wodup-client');

const dateYmd = process.argv[2];
if (!dateYmd || !/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
  console.error('Usage: node wodup-daily-fetch.js YYYY-MM-DD');
  process.exit(1);
}

(async () => {
  try {
    console.log(`Fetching workouts for ${dateYmd}...`);
    const workouts = await fetchWorkouts(dateYmd);
    
    if (Object.keys(workouts).length === 0) {
      console.log('No workouts found for', dateYmd);
    } else {
      console.log('Workouts found:');
      Object.entries(workouts).forEach(([kind, text]) => {
        console.log(`  ${kind}: ${text.split('\n')[0]}`);
      });
    }
    
    // Write to a temporary file for sharing with send script
    const fs = require('fs');
    const path = require('path');
    const tmpFile = path.join(__dirname, 'runs', `.wodup-workouts-${dateYmd}.json`);
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, JSON.stringify({ date: dateYmd, workouts }, null, 2));
    
    console.log('Workouts saved to temp file');
    process.exit(0);
  } catch (e) {
    console.error('Error fetching workouts:', e.message);
    process.exit(1);
  }
})();
