// One-shot: apology + fix update to Dani after the 2026-06-23 09:00 miss.
// FIT @ 6:30am Thu 25-06 was lost to pipeline latency, not a full class: the
// /orders "create cart" first call spiked to 6.4s for her, so her booking
// committed at +10.6s and the class had already filled (Chew Yien won at +5.9s).
// Fix: pre-create the order + warm the socket BEFORE 9am so the sprint starts
// at the seat-grab. Verified live e2e (orders:0, total 2.7s).
// Default-safe: PREVIEW unless SEND=1.
//   Preview:  node announce-dani-latency-fix-20260623.js
//   Send:     SEND=1 node announce-dani-latency-fix-20260623.js
require('dotenv').config();

const RECIPIENTS = [
  {
    id: 'dani', chatId: '80151943',
    msg:
`Morning Dani 🙏

Update on this morning's miss — FIT @ 6:30am Thu 25-06 got away from you, and I dug into exactly why.

It wasn't that the class was already full when we tried — it's that we were too SLOW. The booker fires the instant 9am hits, but the very first step (setting up the order) randomly took 6+ seconds for you today, so by the time it actually grabbed the seat the class had filled. Chew Yien's went through in ~6s and got in; yours took ~10s and missed by a hair.

Fixed it: all that slow setup now happens BEFORE 9am, so the moment it's 9:00:00 the booker goes straight for the seat — no wasted seconds. Tested it live end-to-end and the slow step is completely gone now (the bit that took you 6s is now zero).

You're on the waitlist watch for the 6:30am in the meantime and I'll ping you the second a spot frees. Sorry for the miss 💪`,
  },
];

const SEND = process.env.SEND === '1';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function main() {
  if (!TOKEN) { console.error('NO TELEGRAM_BOT_TOKEN in env'); process.exit(1); }
  console.log(SEND ? '=== SENDING FOR REAL ===' : '=== PREVIEW (set SEND=1 to actually send) ===');
  for (const r of RECIPIENTS) {
    if (!SEND) { console.log(`\n----- ${r.id} (chat ${r.chatId}) -----\n${r.msg}`); continue; }
    try {
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: r.chatId, text: r.msg, disable_web_page_preview: true }),
      });
      const j = await res.json();
      console.log(`${r.id} (${r.chatId}): ${j.ok ? 'SENT ok (msg ' + j.result.message_id + ')' : 'FAILED: ' + JSON.stringify(j)}`);
    } catch (e) {
      console.log(`${r.id} (${r.chatId}): ERROR ${e.message}`);
    }
  }
}
main();
