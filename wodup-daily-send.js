// Send Wodup workout DMs to users with booked classes tomorrow.
// Usage: node wodup-daily-send.js YYYY-MM-DD STATE_FILE
// Idempotent: checks STATE_FILE to avoid duplicate sends.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { loadUsers } = require('./users');
const { formatWorkoutDM } = require('./wodup-formatter');

const dateYmd = process.argv[2];
const stateFile = process.argv[3];

if (!dateYmd || !/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
  console.error('Usage: node wodup-daily-send.js YYYY-MM-DD STATE_FILE');
  process.exit(1);
}

if (!stateFile) {
  console.error('STATE_FILE required');
  process.exit(1);
}

// Load workouts from temp file
const runsDir = path.join(__dirname, 'runs');
const workoutsFile = path.join(runsDir, `.wodup-workouts-${dateYmd}.json`);
if (!fs.existsSync(workoutsFile)) {
  console.error(`Workouts file not found: ${workoutsFile}`);
  process.exit(1);
}

const { workouts } = JSON.parse(fs.readFileSync(workoutsFile, 'utf8'));

// Load state
let state = { date: dateYmd, sentTo: {}, completed: false };
if (fs.existsSync(stateFile)) {
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

console.log(`State: ${JSON.stringify(state, null, 2)}`);

// Send DMs
(async () => {
  try {
    const users = loadUsers();
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.error('TELEGRAM_BOT_TOKEN not set');
      process.exit(1);
    }
    
    const sendTgMessage = async (chatId, text) => {
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
      });
      return response.ok;
    };
    
    // For each user, check if they have a booked class tomorrow
    // For now, a simple check: if they have a schedule, assume booked
    // (In production, would check actual booking via fetchMyUpcomingBookings)
    for (const user of users) {
      const userId = user.id;
      
      // Skip if already sent
      if (state.sentTo[userId]) {
        console.log(`Skipping ${userId} - already sent`);
        continue;
      }
      
      // Skip if no Telegram chat ID
      if (!user.telegramChatId) {
        console.log(`Skipping ${userId} - no Telegram chat ID`);
        continue;
      }
      
      // For MVP: send to users with a schedule (they're likely booked)
      // TODO: check actual booking status via book.js fetchMyUpcomingBookings
      if (!user.schedule) {
        console.log(`Skipping ${userId} - no schedule`);
        continue;
      }
      
      // Find matching workout kind for this user
      // For now, just pick FIT if available (would need to check actual class kind)
      const kindPreference = ['FIT', 'BURN', 'LIFT', 'STEAM'];
      let workoutText = '';
      let workoutKind = '';
      for (const kind of kindPreference) {
        if (workouts[kind]) {
          workoutText = workouts[kind];
          workoutKind = kind;
          break;
        }
      }
      
      if (!workoutText) {
        console.log(`Skipping ${userId} - no workouts available`);
        continue;
      }
      
      // Format DM with emojis and packing list
      const dmText = formatWorkoutDM(workoutText, workoutKind, dateYmd);
      
      console.log(`Sending to ${user.label} (${user.telegramHandle})...`);
      const ok = await sendTgMessage(user.telegramChatId, dmText);
      if (!ok) {
        console.error(`Failed to send to ${user.id}`);
        continue;
      }
      
      // Also send Yash a copy with user prefix
      const yashChatId = 166637821;
      const yashText = `[${user.label}] ${dmText}`;
      console.log(`Sending copy to Yash...`);
      await sendTgMessage(yashChatId, yashText);
      
      state.sentTo[userId] = { timestamp: new Date().toISOString(), kind: workoutKind };
      console.log(`Sent to ${userId}`);
    }
    
    state.completed = true;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    console.log(`State saved to ${stateFile}`);
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
