// One-shot: post-verification all-clear to every user (follow-up to
// announce-rebuild-20260610.js). Sent 10-06-2026 after the scheduled-trigger
// trial passed.
require('dotenv').config();
const { sendTelegram } = require('./lib');
const { loadUsers } = require('./users');

const byId = Object.fromEntries(loadUsers().map(u => [u.id, u.telegramChatId]));

const MSGS = {
  yash: '🏁 Sir Lawrence, final word for today: the rebuilt booking engine passed its full live trial this afternoon. Real trigger, real booking, perfect timing. Mornings are back to clockwork from tomorrow. Your FIT 7:30am this Friday 12-06 is locked, and Thursday 6:30am will auto-promote you off the waitlist if a spot frees. 💪',
  dani: '🏁 Dani, good news to cap the day: the booking engine passed its full live trial this afternoon, so the morning gremlins are officially history. Your FIT 6:30am this Friday 12-06 is locked in. See you at the bar. 💪',
  melissa: '🏁 Melissa, final update: the rebuilt engine passed its full live trial this afternoon, mornings are back to clockwork. Your Friday 12-06 FIT 7:30am is locked, and tomorrow evening’s BURN and FIT are right where they should be. 💪',
  geraldine: '🏁 Geraldine, capping off today: the engine passed its full live trial this afternoon, so bookings run like clockwork from here. I am still glued to Friday’s 7:15am Lift for you and will shout the second a spot frees. The 8:30am Steam or 12:15pm Burn offers still stand, just reply if you fancy one. 💪',
  cheryllee: '🏁 Cheryl, last note from me today: the booking engine passed its full live trial this afternoon, everything verified working. Nothing needed from you, your future bookings will simply run like clockwork. 💪',
};

(async () => {
  for (const [id, text] of Object.entries(MSGS)) {
    const chatId = byId[id];
    if (!chatId) { console.log(`${id}: NO CHAT ID — skipped`); continue; }
    const ok = await sendTelegram(String(chatId), text);
    console.log(`${id} (${chatId}): ${ok ? 'SENT' : 'FAILED'}`);
    await new Promise(r => setTimeout(r, 1500));
  }
})();
