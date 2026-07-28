// One-shot: apology + root cause + fix to Dani after the 2026-07-28 miss.
// FIT @ 6:30am Thu 30-07 was lost because Mindbody's identity provider (2.100.0)
// started routing accounts that were ORIGINALLY created with Google to
// /signin/external — Google-only, no password field anywhere in the flow. Her
// stored password worked every single day through 26-07 and became unreachable
// on 27-07 with nothing changed on her side.
//
// Compounding failure (the part worth apologising for): our own auth probe DID
// catch this at 11:19 SGT on 27-07 and DM'd Yash. The 21:00 evening probe, whose
// whole job is to warn ~12h before booking day, then went SILENT because of a
// 20h fixed re-alert window. And Dani was never told at all, despite being the
// only person who can unlink an SSO account.
//
// Default-safe: PREVIEW unless SEND=1.
//   Preview:  node announce-dani-sso-20260728.js
//   Send:     SEND=1 node announce-dani-sso-20260728.js
require('dotenv').config();

const RECIPIENTS = [
  {
    id: 'dani', chatId: '80151943',
    msg:
`Morning Dani 🙏

Your FIT @ 6:30am on Thu 30-07 didn't get booked this morning, and I owe you a proper explanation because you're right, you changed nothing.

What actually happened: Mindbody changed how sign-in works on 27-07. Your account was originally created with "Sign in with Google" way back when. Their new sign-in now spots that and forces the Google-only route, so when I enter your email it jumps straight to a "Continue with Google" screen and never shows a password box at all. Your password still exists and is still correct. Mindbody just stopped accepting it. That flipped overnight between Sun and Mon, which is why it worked every single day up to 26-07 and then didn't.

The part that's genuinely my fault: my checker actually caught this yesterday morning. It should then have warned you again last night, in time to sort it before the 9am window, and it should have told YOU and not just Yash, since it's your account and only you can change it. A bug in my alerting muted both. So you found out by losing a class. Sorry, that's on me.

The one-time fix, takes about 30 seconds:
1. Go to mindbodyonline.com and hit Log in
2. Type your email, tap Continue
3. On the "Google Account" screen, tap "Disconnect here" (small link under "Prefer not to sign-in with Google?")
4. Sign in once with your normal password to confirm

Nothing else about your account changes and your password stays the same. It just stops forcing the Google-only route, and I can book for you again like normal.

In the meantime I've put both classes on the waitlist watcher, Lift @ 7:15am tomorrow and FIT @ 6:30am Thu, so the second your login works again it grabs them automatically. Google sign-in still works fine for you personally, so you can also just book them yourself in the app right now if you'd rather not wait.

I've also fixed the alerting so a broken login always reaches you the evening before, never silently. Sorry again 💪`,
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
