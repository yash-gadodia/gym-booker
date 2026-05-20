// One-shot Lawrence-voice announcement DM for the waitlist watcher feature.
// Sent to all booker users in users.json with a telegramChatId.

require('dotenv').config();
const { loadUsers } = require('./users');

const MSG = `Heads up, old sport. 🔔 New service.

If a class you want is FULL, I can watch it for you. The moment a slot opens (someone cancels) or the waitlist queue activates, I'll DM you. I keep pinging every minute until you grab it, so you can't sleep through it.

Tell Yash the class (day + time + kind) and I'll babysit it. Currently watching Fri 7:30am FIT for Mer.`;

async function sendTg(chatId, text, token) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
  const j = await r.json().catch(() => null);
  return { ok: r.ok && j && j.ok, status: r.status, body: j };
}

(async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN missing');
    process.exit(1);
  }
  const users = loadUsers().filter(u => u.telegramChatId);
  console.log(`announcing waitlist watcher to ${users.length} users:`);
  for (const u of users) {
    const r = await sendTg(u.telegramChatId, MSG, token);
    console.log(`  ${u.id} (${u.label}) chat=${u.telegramChatId} ok=${r.ok} status=${r.status} msg_id=${r.body && r.body.result && r.body.result.message_id}`);
  }
})();
