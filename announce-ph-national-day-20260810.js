// One-shot: tell all users Monday 10-08 is National Day (observed), gym has
// no classes, so this morning's "couldn't book" pings were a false alarm.
// Sent 2026-08-08 after the booker fired a failure DM to every user for what
// was just an empty holiday schedule (booker is now holiday-aware).
//
// Default-safe: PREVIEW unless SEND=1.
//   Preview:  node announce-ph-national-day-20260810.js
//   Send:     SEND=1 node announce-ph-national-day-20260810.js
require('dotenv').config();
const { loadUsers } = require('./users');

const MSG = (first) =>
`Morning ${first}! 🇸🇬

False alarm earlier, nothing is broken. Monday 10-08 is a public holiday (National Day, observed), so RagTag's regular classes are off that day. Your usual class not existing is what set off my scary failure ping this morning. That's on me, I've learnt my holidays now.

The gym isn't fully closed though. Monday has two Public Holiday Open Gym sessions:
• 8:30am - 10:30am
• 10:30am - 12:30pm

Want in on one? Reply here and I'll get you booked.

Happy National Day! Enjoy the long weekend, rest up, and regular programming resumes Tuesday 💪`;

const SEND = process.env.SEND === '1';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function main() {
  if (!TOKEN) { console.error('NO TELEGRAM_BOT_TOKEN in env'); process.exit(1); }
  const users = loadUsers().filter(u => u.telegramChatId);
  console.log(SEND ? '=== SENDING FOR REAL ===' : '=== PREVIEW (set SEND=1 to actually send) ===');
  for (const u of users) {
    const first = (u.label || u.id).split(' ')[0];
    const msg = MSG(first);
    if (!SEND) { console.log(`\n----- ${u.id} (chat ${u.telegramChatId}) -----\n${msg}`); continue; }
    try {
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: u.telegramChatId, text: msg, disable_web_page_preview: true }),
      });
      const j = await res.json();
      console.log(`${u.id} (${u.telegramChatId}): ${j.ok ? 'SENT ok (msg ' + j.result.message_id + ')' : 'FAILED: ' + JSON.stringify(j)}`);
    } catch (e) {
      console.log(`${u.id} (${u.telegramChatId}): ERROR ${e.message}`);
    }
  }
}
main();
