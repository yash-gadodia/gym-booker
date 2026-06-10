// One-shot: apologise + fix-summary to gym users after the 2026-06-06 08:57
// load-spike wipeout. Default-safe: PREVIEW unless SEND=1 (per no-prod-sends rule).
// Run preview:  node announce-booker-apology-20260606.js
// Run for real: SEND=1 node announce-booker-apology-20260606.js
require('dotenv').config();

const RECIPIENTS = [
  {
    id: 'dani', chatId: '80151943',
    msg:
`Morning Dani 🙏

Straight talk: this morning's auto-booking for your FIT @ 6:30am on Mon 08-06-2026 didn't go through. The booking system got overloaded right at 9am and missed the window, and by the time it recovered the class had filled. That one's on me, and I'm sorry.

Good news: you're on the waitlist watch for it (and your 7:30am fallback too). The moment a spot frees up I'll ping you to grab it. Just tap BOOK NOW in Mindbody and it'll let you in.

And I've fixed the cause: spaced out the system's startup so it can't overload itself, taught it to retry through any slowdown instead of giving up, and added tests so this exact thing can't sneak back. Won't happen again 💪`,
  },
  {
    id: 'geraldine', chatId: '376127516',
    msg:
`Morning Geraldine 🙏

Straight talk: this morning's auto-booking for your FIT @ 7:30am on Mon 08-06-2026 didn't go through. The booking system got overloaded right at 9am and missed the window, and the class filled before it could recover. That's on me, and I'm sorry.

Good news: you're on the waitlist watch for it now. The second someone cancels I'll ping you to grab the spot. Just tap BOOK NOW in Mindbody and you're in.

And I've fixed the cause: spaced out the system's startup so it can't overload itself, taught it to retry through slowdowns instead of giving up, and added tests so it can't happen again 💪`,
  },
  {
    id: 'melissa', chatId: '109578819',
    msg:
`Morning Melissa 🙏

Quick heads up, just to be upfront: the auto-booker hit a snag this morning and missed the 9am window for Monday's classes. You're unaffected. You were already booked for both your Monday sessions (BURN @ 6:30pm and FIT @ 7:30pm), so nothing's changed for you.

I've already fixed the underlying issue and added safeguards so it doesn't recur. See you Monday 💪`,
  },
  {
    id: 'cheryl', chatId: '457143103',
    msg:
`Morning Cheryl 🙏

Heads up so you're in the loop: the auto-booker had a wobble this morning and missed Monday's 9am booking window. It didn't affect you (you're off this Monday), but I'd rather be straight with you than quiet about it.

Issue's fixed and safeguarded so it won't happen again 💪`,
  },
  {
    id: 'yash-ops', chatId: '166637821',
    msg:
`📋 Booker incident comms sent (Mon 08-06-2026)

Apology + fix summary delivered to:
• Dani — missed FIT 6:30am, on waitlist (6:30 + 7:30)
• Geraldine — missed FIT 7:30am, on waitlist
• Melissa — unaffected (already booked both evening classes)
• Cheryl — unaffected (off Monday)

Waitlist watchers live (60s poll). Fix pushed, 265 tests green.`,
  },
];

const SEND = process.env.SEND === '1';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function main() {
  if (!TOKEN) { console.error('NO TELEGRAM_BOT_TOKEN in env'); process.exit(1); }
  console.log(SEND ? '=== SENDING FOR REAL ===' : '=== PREVIEW (set SEND=1 to actually send) ===');
  for (const r of RECIPIENTS) {
    console.log(`\n----- ${r.id} (chat ${r.chatId}) -----\n${r.msg}`);
    if (!SEND) continue;
    try {
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: r.chatId, text: r.msg, disable_web_page_preview: true }),
      });
      const j = await res.json();
      console.log(`  -> ${j.ok ? 'SENT ok (msg ' + j.result.message_id + ')' : 'FAILED: ' + JSON.stringify(j)}`);
    } catch (e) {
      console.log(`  -> ERROR: ${e.message}`);
    }
  }
}
main();
