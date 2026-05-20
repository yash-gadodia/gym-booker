const { chromium } = require('playwright');
const fs = require('fs');

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: '/Users/yash/gym-booker/wodup-auth.json'
  });
  const page = await context.newPage();
  
  const fetchWorkouts = async (dateStr) => {
    console.log(`\nFetching workouts for ${dateStr}...`);
    await page.goto(`https://www.wodup.com/timeline?date=${dateStr}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    
    const workouts = await page.evaluate(() => {
      const workoutMap = {};
      
      // Strategy: Find sections with Log Result + Leaderboard buttons
      // Each workout card has these buttons, followed by the workout content, then "Show full workout"
      
      const allText = document.body.innerText;
      const lines = allText.split('\n');
      
      // Find indices of "Log Result" (marks start of workout content)
      const workoutStarts = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === 'Log Result') {
          workoutStarts.push(i);
        }
      }
      
      console.log(`Found ${workoutStarts.length} workouts`);
      
      workoutStarts.forEach(startIdx => {
        // Work backwards to find the kind (FIT, BURN, LIFT, etc)
        let kind = '';
        for (let i = startIdx - 1; i >= Math.max(0, startIdx - 5); i--) {
          const line = lines[i].trim().toUpperCase();
          if (['FIT', 'BURN', 'LIFT', 'STEAM', 'GYMNASTICS', 'RUN', 'CONDITIONING'].includes(line)) {
            kind = line;
            break;
          }
        }
        
        if (!kind) return;
        
        // Work forwards to find where this workout ends (next kind or "Choose which programs")
        let endIdx = startIdx + 1;
        for (let i = startIdx + 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (['FIT', 'BURN', 'LIFT', 'STEAM', 'GYMNASTICS', 'RUN', 'CONDITIONING'].includes(line.toUpperCase()) && i > startIdx + 5) {
            endIdx = i;
            break;
          }
          if (line.startsWith('Choose which programs')) {
            endIdx = i;
            break;
          }
        }
        
        // Extract workout lines (from after "Log Result" to before "Show full workout")
        const workoutLines = [];
        for (let i = startIdx + 1; i < endIdx; i++) {
          const line = lines[i].trim();
          if (line === 'Leaderboard') continue;
          if (line === 'Show full workout') break;
          if (line === '') continue;
          workoutLines.push(line);
        }
        
        if (workoutLines.length > 2) {
          workoutMap[kind] = workoutLines.join('\n');
        }
      });
      
      return workoutMap;
    });
    
    return workouts;
  };
  
  // Fetch for multiple dates
  const dates = ['2026-05-21', '2026-05-22', '2026-05-23'];
  const allWorkouts = {};
  
  for (const date of dates) {
    allWorkouts[date] = await fetchWorkouts(date);
  }
  
  console.log('\n=== FINAL RESULTS ===');
  console.log(JSON.stringify(allWorkouts, null, 2));
  
  fs.writeFileSync('/Users/yash/gym-booker/recon-wodup/all-workouts.json', JSON.stringify(allWorkouts, null, 2));
  
  await browser.close();
  console.log('\nDone');
}

main().catch(e => { console.error(e); process.exit(1); });
