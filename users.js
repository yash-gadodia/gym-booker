const fs = require('fs');
const path = require('path');

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

function getCreds(user) {
  if (!user.email || !user.password) {
    throw new Error(`user "${user.id}" missing email/password in users.json`);
  }
  return { email: user.email, password: user.password };
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
