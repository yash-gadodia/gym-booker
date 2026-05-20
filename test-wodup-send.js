// Test Wodup DM sending to Yash only
require('dotenv').config();
const { fetchWorkouts } = require('./wodup-client');
const { formatWorkoutDM } = require('./wodup-formatter');

const dateYmd = '2026-05-22'; // Friday with FIT workout
const yashChatId = 166637821;

(async () => {
  try {
    console.log(`Fetching workouts for ${dateYmd}...`);
    const workouts = await fetchWorkouts(dateYmd);
    
    if (!workouts.FIT) {
      console.error('No FIT workout found');
      process.exit(1);
    }
    
    const dmText = formatWorkoutDM(workouts.FIT, 'FIT', dateYmd);
    console.log('=== FORMATTED DM ===');
    console.log(dmText);
    console.log('\n=== SENDING TO YASH ===');
    
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.error('TELEGRAM_BOT_TOKEN not set');
      process.exit(1);
    }
    
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: yashChatId,
        text: dmText,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      })
    });
    
    const result = await response.json();
    console.log(`Status: ${response.status}`);
    console.log(`Result:`, JSON.stringify(result, null, 2));
    
    if (response.ok) {
      console.log('\nSent successfully to Yash!');
      process.exit(0);
    } else {
      console.error('Failed to send');
      process.exit(1);
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
