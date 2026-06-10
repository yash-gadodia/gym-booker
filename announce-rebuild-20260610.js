require('dotenv').config();
const { sendTelegram } = require('./lib');
const { loadUsers } = require('./users');

const byId = Object.fromEntries(loadUsers().map(u => [u.id, u.telegramChatId]));

const MSGS = {
  yash: '🎩 Sir Lawrence, service report: the booking engine got its full rebuild today and passed a live dress rehearsal. The odd "Open Gym booked, then cancelled" pings earlier were me testing, nothing is wrong. You are locked in for FIT 7:30am this Friday 12-06. Heads up: Thursday 6:30am FIT has you WAITLISTED, Mindbody bumps you in automatically if a spot frees. The team is being notified now. 💪',
  dani: '🎩 Dani, Sir Lawrence with an apology: the morning booking engine has been embarrassingly flaky this week, and you caught a scary failure alert this morning. That gremlin got a complete rebuild today and passed every test, so mornings are back to clockwork. The important bit: your FIT 6:30am this Friday 12-06 is locked in. If anything odd pinged you today, that was controlled testing, all is well. 💪',
  melissa: '🎩 Melissa, Sir Lawrence here, hat in hand: this week’s morning bookings have been unreliable and this morning’s failure note was the last straw. The engine got a full rebuild today and passed a live end-to-end rehearsal. You are all set: FIT 7:30am this Friday 12-06 is booked, and tomorrow’s BURN 6:30pm + FIT 7:30pm are on your schedule as usual. Any strange message today was planned testing, nothing to worry about. 💪',
  geraldine: '🎩 Geraldine, one more from me today, mostly an apology: this morning’s failure was entirely the engine’s fault, and it has now been fully rebuilt and tested. As mentioned earlier, Friday’s morning Lift actually runs at 7:15am (my notes wrongly said 7:30). It is full right now, and I am watching it with eagle eyes: the second a spot frees, you will hear from me. Steam 8:30am or Burn 12:15pm on Friday are open if you would rather lock something in today, just say the word. 💪',
  cheryllee: '🎩 Cheryl, quick service note from Sir Lawrence: the booking engine had a rough patch this week and received a full rebuild today, tested end to end. Your schedule was not affected, and future bookings will run like clockwork. If any odd message reached you recently, that was the gremlin being fixed, nothing you need to act on. 💪',
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
