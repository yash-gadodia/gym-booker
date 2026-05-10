const fs = require('fs');
const path = require('path');
const keychain = require('./keychain');

const USERS_FILE = path.join(__dirname, 'users.json');
const AUTH_DIR = path.join(__dirname, 'users-auth');
const RUNS_ROOT = path.join(__dirname, 'runs');

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  const raw = fs.readFileSync(USERS_FILE, 'utf8');
  const j = JSON.parse(raw);
  return Array.isArray(j.users) ? j.users : [];
}

function getUser(id) {
  const u = loadUsers().find(x => x.id === id);
  if (!u) throw new Error(`user "${id}" not found in users.json`);
  return u;
}

// Resolve Mindbody creds for a user. As of 2026-05-10, creds live in the
// gym-booker custom keychain (see ./keychain.js). Plaintext fields on the
// user object are accepted as fallback during the migration window only —
// new users should never have them.
//
// Resolution order:
//   1. Keychain (service=gym-booker-mindbody, account=<chatId>-{email,password})
//   2. Plaintext user.email / user.password (deprecated; warns to stderr)
//   3. Throw — booking can't proceed without creds.
function getCreds(user) {
  const chatId = user.telegramChatId;
  if (chatId) {
    const kEmail = keychain.getCred(chatId, 'email');
    const kPassword = keychain.getCred(chatId, 'password');
    if (kEmail && kPassword) {
      return { email: kEmail, password: kPassword };
    }
  }

  if (user.email && user.password) {
    process.stderr.write(
      `[users.getCreds] WARNING: user "${user.id}" still has plaintext email/password ` +
      `in users.json. Run \`node migrate-creds-to-keychain.js\` to migrate.\n`
    );
    return { email: user.email, password: user.password };
  }

  throw new Error(
    `user "${user.id}" has no creds: keychain miss for chatId=${chatId}, ` +
    `no plaintext fallback. Run \`node migrate-creds-to-keychain.js\` or have ` +
    `Lawrence onboard this user.`
  );
}

function getAuthPath(user) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  return path.join(AUTH_DIR, `${user.id}.json`);
}

function getRunsDir(user, runId) {
  const dir = path.join(RUNS_ROOT, user.id, runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Resolve where this user's Telegram messages go.
// Returns { chatId, prefix }:
//   - if user.telegramChatId is set → send to user, no prefix
//   - else → send to env TELEGRAM_CHAT_ID with "[<label>] " prefix so Yash
//     can see whose run it is during the chat-id onboarding gap.
function getTelegramTarget(user, env = process.env) {
  if (user.telegramChatId) {
    return { chatId: String(user.telegramChatId), prefix: '' };
  }
  return { chatId: env.TELEGRAM_CHAT_ID, prefix: `[${user.label || user.id}] ` };
}

module.exports = {
  loadUsers,
  getUser,
  getCreds,
  getAuthPath,
  getRunsDir,
  getTelegramTarget,
  USERS_FILE,
  AUTH_DIR,
  RUNS_ROOT,
};
