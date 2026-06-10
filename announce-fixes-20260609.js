// One-shot: "here's what I fixed" summary to all gym users after the 2026-06-09
// reliability overhaul. Default-safe: PREVIEW unless SEND=1 (no-prod-sends rule).
// Preview:  node announce-fixes-20260609.js
// Send all: SEND=1 node announce-fixes-20260609.js
require('dotenv').config();
const fs = require('fs');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const users = JSON.parse(fs.readFileSync(__dirname + '/users.json', 'utf8'));
const list = Array.isArray(users) ? users : (users.users || Object.values(users));
const first = (label, id) => (label || id).split(/\s+/)[0];

function msgFor(name) {
  return `Right then, ${name}. 📋 A word from your gym booking spotter.

Straight talk: I've been unreliable these past couple of weeks. Some mornings I missed the 9am booking window, and a couple of my messages were plain wrong. Not good enough, and I'm sorry. I spent today getting properly sorted, and here's what's better now:

🏋️ Quicker and steadier at 9am. I was sometimes too slow getting logged in and missed the window while classes filled. Sorted, so I grab your slot the moment booking opens.

✅ Honest about booked vs waitlist. If you're booked, I'll say booked. If a class is full and you're on the waitlist, I'll say exactly that. No more telling you you're in when you're not.

🔕 No more waitlist spam. If a class is full you get one clear heads-up to join the waitlist, then I go quiet and only shout the second a real spot opens.

🔑 Reconnected everyone's account so a silent login drop can't quietly cost you a booking.

All tested and verified. Back to my one job: getting you in the room. See you there 💪`;
}

const RECIPIENTS = list
  .filter(u => u && u.telegramChatId)
  .map(u => ({ id: u.id, chatId: String(u.telegramChatId), name: first(u.label, u.id) }));

const SEND = process.env.SEND === '1';

async function send(chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const j = await r.json();
  return j.ok ? `OK msg_id=${j.result.message_id}` : `FAIL ${JSON.stringify(j)}`;
}

(async () => {
  console.log(`${SEND ? 'SENDING' : 'PREVIEW'} to ${RECIPIENTS.length} users: ${RECIPIENTS.map(r => r.id).join(', ')}\n`);
  for (const r of RECIPIENTS) {
    if (SEND) {
      const res = await send(r.chatId, msgFor(r.name));
      console.log(`${r.id} (${r.chatId}): ${res}`);
    } else {
      console.log(`──────── ${r.id} (${r.chatId}) ────────\n${msgFor(r.name)}\n`);
    }
  }
  if (!SEND) console.log('(preview only — re-run with SEND=1 to broadcast)');
})();
