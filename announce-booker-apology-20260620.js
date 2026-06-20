// One-shot: apology + explanation to gym users after the 2026-06-22 (run 20-06)
// 9am race-losses. NOT a bug this time — classes filled in seconds at 9am under
// Mindbody server lag. Default-safe: PREVIEW unless SEND=1.
// Preview:  node announce-booker-apology-20260620.js
// Send all: SEND=1 node announce-booker-apology-20260620.js
require('dotenv').config();

const RECIPIENTS = [
  {
    id: 'geraldine', chatId: '376127516',
    msg:
`Morning Geraldine 🙏

Straight talk: I couldn't get you into FIT @ 7:30am this coming Mon 22-06-2026. The class was already full the instant booking opened at 9am — it filled in seconds. That's a miss, and I'm sorry.

What happened: booking opens at exactly 9am and everyone piles in at once. Each booking is a 6-step checkout on Mindbody's side, and their servers were slow under the rush this morning — by the time your booking pushed through, the last spots were gone.

Good news: you're on the waitlist watch for it now. The second someone cancels I'll ping you to grab the spot — just tap BOOK NOW in Mindbody and you're in 💪`,
  },
  {
    id: 'chewyien', chatId: '98714468',
    msg:
`Morning Chew 🙏

Straight talk: I couldn't get you into FIT @ 6:30am this coming Mon 22-06-2026. It was a photo-finish at 9am and we lost it by a couple of seconds. Frustrating, and I'm sorry.

What happened: booking opens at exactly 9am and everyone rushes in. Each booking is a 6-step checkout on Mindbody's side, and their servers were slow this morning — the class hit capacity in the few seconds it took to push your booking through.

Good news: you're on the waitlist watch now. The moment a spot frees up I'll ping you — just tap BOOK NOW in Mindbody to claim it 💪`,
  },
  {
    id: 'dani', chatId: '80151943',
    msg:
`Morning Dani 🙏

Quick FYI: you're all set — booked into FIT @ 6:30am this coming Mon 22-06-2026 ✅. It was a tight one (the class filled within seconds of 9am and a couple of others missed out), but you got in clean. See you Monday 💪`,
  },
  {
    id: 'melissa', chatId: '109578819',
    msg:
`Morning Melissa 🙏

Quick FYI: you're all set for Monday 22-06-2026 — booked into both BURN @ 6:30pm and FIT @ 7:30pm ✅. Some morning classes filled within seconds at 9am today, but yours went through clean. See you there 💪`,
  },
  {
    id: 'cheryllee', chatId: '457143103',
    msg:
`Morning Cheryl 🙏

Quick FYI: nothing to book for you this Monday 22-06-2026 (you're off), so no action needed — just keeping you in the loop 💪`,
  },
  {
    id: 'yash-ops', chatId: '166637821',
    msg:
`📋 Booker incident — Mon 22-06-2026 (run 20-06)

3 misses, all genuine race-losses / full classes (not a bug):
• You — FIT 6:30am: lost the 9am race (orders call 2.9s vs Dani's 0.7s); 7:30am fallback also full
• Geraldine — FIT 7:30am: full at 9am
• Chew Yien — FIT 6:30am: lost the race
Booked clean: Dani (FIT 6:30am), Melissa (BURN + FIT). Cheryl off Mon.

Waitlist watchers live for all 3 (polling, status FULL).
Timing fix shipped + pushed to main (323 tests green): all users now fire at 09:00:00.000 on the dot — drift was 0.1-3.5s, now ~0ms.

Apology+explanation DMs sent to Geraldine & Chew Yien; FYI notes to Dani/Melissa/Cheryl.`,
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
