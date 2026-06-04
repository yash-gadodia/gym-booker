// Edit the 5 waitlist announcement DMs to remove the "Tell Yash" system leak.
// Telegram bots can editMessageText within 48h of original send.

require('dotenv').config();

const NEW_MSG = `Heads up, old sport. 🔔 New service.

If a class you want is FULL, I can watch it for you. The moment a slot opens (someone cancels) or the waitlist queue activates, I'll DM you. I keep pinging every minute until you grab it, so you can't sleep through it.

DM me the class (day + time + kind) and I'll babysit it. Currently watching Fri 7:30am FIT for Mer.`;

// (chat_id, message_id) pairs from the original send (announce-waitlist.js run, msg_ids 4162-4166)
const TARGETS = [
  { id: 'yash',      chatId: 166637821, msgId: 4162 },
  { id: 'dani',      chatId: 80151943,  msgId: 4163 },
  { id: 'melissa',   chatId: 109578819, msgId: 4164 },
  { id: 'geraldine', chatId: 376127516, msgId: 4165 },
  { id: 'cheryllee', chatId: 457143103, msgId: 4166 },
];

(async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.error('TELEGRAM_BOT_TOKEN missing'); process.exit(1); }
  for (const t of TARGETS) {
    const r = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: t.chatId,
        message_id: t.msgId,
        text: NEW_MSG,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    const j = await r.json().catch(() => null);
    console.log(`  ${t.id} chat=${t.chatId} msg_id=${t.msgId} ok=${j && j.ok} status=${r.status}${j && j.description ? ' desc=' + j.description : ''}`);
  }
})();
