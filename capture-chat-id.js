// Onboard a new user's Telegram chat_id.
//
// Telegram bots cannot DM a @username cold — they need the user's numeric
// chat_id, which is only obtainable after the user has sent a message TO the
// bot. So onboarding flow:
//
//   1. New user sends any message (e.g. /start) to the gym-booker bot.
//   2. Run this script with their @username.
//   3. Script polls /getUpdates, finds their message, prints chat_id.
//   4. Paste chat_id into users.json under that user's `telegramChatId`.
//
// Usage:
//   node capture-chat-id.js --username danielleee
//   node capture-chat-id.js --username danielleee --watch    # poll until found
//
// Env: TELEGRAM_BOT_TOKEN (read from .env, same bot used by book.js)
require('dotenv').config();

const args = process.argv.slice(2);
function getOpt(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}
const username = getOpt('username');
const watch = args.includes('--watch');

if (!username) {
  console.error('usage: node capture-chat-id.js --username <handle> [--watch]');
  process.exit(2);
}
const handle = username.replace(/^@/, '').toLowerCase();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN missing from .env');
  process.exit(2);
}

async function getMe() {
  const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const j = await r.json();
  if (!j.ok) throw new Error(`getMe failed: ${JSON.stringify(j)}`);
  return j.result;
}

async function getUpdates() {
  const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=100`);
  const j = await r.json();
  if (!j.ok) throw new Error(`getUpdates failed: ${JSON.stringify(j)}`);
  return j.result || [];
}

function findMatch(updates) {
  for (const u of updates) {
    const msg = u.message || u.edited_message || u.channel_post;
    if (!msg) continue;
    const from = msg.from || msg.chat;
    const u_handle = (from && from.username) ? from.username.toLowerCase() : null;
    if (u_handle === handle) {
      return {
        chat_id: msg.chat.id,
        user_id: from.id,
        username: from.username,
        first_name: from.first_name || '',
        last_name: from.last_name || '',
        text_preview: (msg.text || msg.caption || '').slice(0, 80),
      };
    }
  }
  return null;
}

(async () => {
  const me = await getMe();
  console.log(`bot: @${me.username} (${me.first_name})`);
  console.log(`looking for messages from @${handle}`);
  console.log(`(if no message found: ask the user to DM @${me.username} first, then re-run)`);

  const tryOnce = async () => {
    const updates = await getUpdates();
    console.log(`getUpdates: ${updates.length} pending update(s)`);
    return findMatch(updates);
  };

  let m = await tryOnce();
  if (!m && watch) {
    console.log('--watch: polling every 5s until @' + handle + ' DMs the bot...');
    while (!m) {
      await new Promise(r => setTimeout(r, 5000));
      m = await tryOnce();
    }
  }

  if (!m) {
    console.error(`\nno message from @${handle} found in pending updates.`);
    console.error('next steps:');
    console.error(`  1. ask @${handle} to open https://t.me/${me.username} and tap Start`);
    console.error(`  2. re-run: node capture-chat-id.js --username ${handle}`);
    console.error(`     (or run with --watch to auto-poll)`);
    console.error(`note: getUpdates only returns messages from the last ~24h that no other`);
    console.error(`      receiver has consumed. If the bot has a webhook or a separate poller,`);
    console.error(`      messages may be drained — ask the user to send a fresh one.`);
    process.exit(1);
  }

  console.log('\nMATCH:');
  console.log(`  chat_id      ${m.chat_id}`);
  console.log(`  user_id      ${m.user_id}`);
  console.log(`  username     @${m.username}`);
  console.log(`  name         ${m.first_name} ${m.last_name}`.trim());
  console.log(`  msg preview  "${m.text_preview}"`);
  console.log(`\npaste into users.json:`);
  console.log(`  "telegramChatId": ${m.chat_id},`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
