// One-shot: apology + fixes update after the 2026-06-22 09:00 incident.
// This time it WAS a bug (not just a race): the proactive re-login broke for
// users whose session was still logged in -> "no visible Login button" ->
// setup failed for Yash + Chew Yien. Separately, the assistant (Lawrence)
// went unresponsive to chat for a stretch (LLM auth wedge) so watch/DM
// requests got no reply. Both fixed + tested; bookings recovered.
// Default-safe: PREVIEW unless SEND=1.
//   Preview:  node announce-booker-apology-20260622.js
//   Send all: SEND=1 node announce-booker-apology-20260622.js
require('dotenv').config();

const RECIPIENTS = [
  {
    id: 'chewyien', chatId: '98714468',
    msg:
`Morning Chew 🙏

Owning this one: at 9am today the booker hit a real bug and failed to even log in for you (and me) — it missed FIT @ 6:30am Wed 24-06-2026 on the first attempt. That was on my side, not a class-is-full race.

The good news: I caught it, fixed it, and re-ran — you ARE booked into FIT @ 6:30am Wed 24-06-2026 ✅. See you there 💪

What broke: a change I made yesterday tried to "refresh" your login before 9am, but for already-logged-in accounts it couldn't find the login button and gave up. Fixed, tested, and locked so it can't happen again.`,
  },
  {
    id: 'dani', chatId: '80151943',
    msg:
`Morning Dani 🙏

Two things, and thank you for flagging it:

1) You were right — Lawrence went quiet overnight (a backend auth hiccup meant I couldn't reply to messages for a stretch). That's fixed now, and I've added a check that pings the system every 30 min and auto-recovers it, so it won't sit dead silently again.

2) FIT @ 6:30am Wed 24-06-2026 filled up the instant booking opened, so I couldn't lock it in — you're on the waitlist watch now (saw you joined manually too 🙌). The second a spot frees I'll ping you to grab it.

Sorry for the noise this morning 💪`,
  },
  {
    id: 'melissa', chatId: '109578819',
    msg:
`Morning Mer 🙏

I owe you an apology — you messaged to watch your 6:30pm Monday BURN a few times and got total silence. That wasn't you being ignored: the assistant had a backend hiccup overnight and couldn't reply. It's fixed now (and I've added an auto-recovery check every 30 min so it won't go dark like that again).

It's back and listening — just re-send your "watch …" and I'll set it up and confirm right away 💪`,
  },
  {
    id: 'geraldine', chatId: '376127516',
    msg:
`Morning Geraldine 🙏

Quick FYI + heads-up: there was a glitch in this morning's 9am run (a login bug that hit a couple of accounts, plus the assistant going quiet for a bit) — both fixed now.

You're unaffected and all set for Wed 24-06-2026: booked into FIT @ 7:30am and Lift @ 12:15pm ✅. See you there 💪`,
  },
  {
    id: 'cheryllee', chatId: '457143103',
    msg:
`Morning Cheryl 🙏

Just keeping you in the loop: there was a hiccup in this morning's booker run (now fixed). Nothing was scheduled for you on Wed 24-06-2026, so no action needed on your end 💪`,
  },
  {
    id: 'yash-ops', chatId: '166637821',
    msg:
`📋 Booker + Lawrence incident — 2026-06-22 09:00 (recovered)

ROOT CAUSE (booking): the 21-06 "proactive fresh login" change assumed a logged-OUT page. For accounts whose cached session was still logged IN there's no Login button -> "auth expired and no visible Login button found" -> setup failed 6/6 for You + Chew Yien.
FIX: mb-login.js now tears down the stale session (cookies+storage) + reloads so the Login button reappears, then logs in fresh. Committed + pushed. Regression test added (370 tests green). Manually re-ran -> You + Chew Yien BOOKED FIT 6:30am Wed 24-06 ✅.

ROOT CAUSE (Lawrence silent): every LLM call 401'd — wedged/flapping gateway. daemon restart fixed it (agents reply again).
FIX: new com.voltade.agent-health-probe-core LaunchAgent pings main/lawrence/clawrence every 30 min; on 2 consecutive fails auto-restarts the daemon (3h cooldown) + DMs you. 8 unit tests green.

Wed 24-06 status: You ✅ FIT 6:30am · Chew Yien ✅ FIT 6:30am · Geraldine ✅ FIT 7:30am + Lift 12:15pm · Dani ⏳ FIT 6:30am full→waitlist watch · Melissa — none scheduled (her BURN watch DM went unanswered while Lawrence was down; asked her to re-send) · Cheryl off.`,
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
