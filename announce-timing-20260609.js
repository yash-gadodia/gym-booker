// Follow-up to all gym users: how the 9am timing works (user-voice, no system
// leak). Default-safe: PREVIEW unless SEND=1.
require('dotenv').config();
const fs = require('fs');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const users = JSON.parse(fs.readFileSync(__dirname + '/users.json', 'utf8'));
const list = Array.isArray(users) ? users : (users.users || Object.values(users));
const first = (label, id) => (label || id).split(/\s+/)[0];

function msgFor(name) {
  return `Quick one on the timing, ${name}, since it's the crux of it. ⏰

I don't roll up at 9am cold. I get myself signed in and ready a few minutes early, so the instant booking opens at 9:00am sharp I can grab your spot in the same breath. Booking's a land-grab, the popular classes go in seconds, so being ready on the dot is the whole game.

Where I'd been tripping: getting signed in was taking too long and eating that head start, so some mornings I'd run out of road right at 9am and miss it. That's sorted now, I stay signed in between days and start my prep earlier, so I'm ready with minutes to spare, not seconds. Sharper than ever, old sport. 💪`;
}

const RECIPIENTS = list.filter(u => u && u.telegramChatId)
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
  console.log(`${SEND ? 'SENDING' : 'PREVIEW'} to ${RECIPIENTS.length}: ${RECIPIENTS.map(r => r.id).join(', ')}\n`);
  if (!SEND) { console.log(msgFor('{Name}')); console.log('\n(preview only — SEND=1 to broadcast)'); return; }
  for (const r of RECIPIENTS) console.log(`${r.id} (${r.chatId}): ${await send(r.chatId, msgFor(r.name))}`);
})();
