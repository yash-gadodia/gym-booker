// One-shot Lawrence-voice "back from MC" announcement DM to all booker users.
// Sent to every users.json entry with a telegramChatId. Uniform Sir Lawrence voice.

require('dotenv').config();
const { loadUsers } = require('./users');

const MSG = `Right then, gentlemen. 🎩💪

Sir Lawrence, back from the MC. Bit of a knock and the doctor signed me off, but I'm out the sick bay and the booking boots are laced again.

Normal service resumes: back on the *9am sharp* watch, locking your classes in two days out. No full class shall defeat us, no slot left on the table.

Rest's over. We eating tonight? Send it. 🏋️`;

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
  console.log(`announcing "back from MC" to ${users.length} users:`);
  for (const u of users) {
    const r = await sendTg(u.telegramChatId, MSG, token);
    console.log(`  ${u.id} (${u.label}) chat=${u.telegramChatId} ok=${r.ok} status=${r.status} msg_id=${r.body && r.body.result && r.body.result.message_id}`);
  }
})();
