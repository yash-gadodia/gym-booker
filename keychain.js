// Keychain helper for Mindbody credentials.
//
// Why a custom keychain (not login.keychain-db):
//   The login keychain is locked when there's no GUI session (e.g. SSH or
//   LaunchAgent without UI), so `security add-generic-password` fails with
//   "User interaction is not allowed." We need creds available headlessly
//   from the 09:00 SGT booking cron and from Lawrence's Telegram-driven
//   onboarding tools, neither of which has UI.
//
//   Solution: a dedicated keychain (~/Library/Keychains/gym-booker.keychain-db)
//   created with a random password stored at 0600 in
//   ~/.openclaw/credentials/gym-booker-keychain-pw. Set to never auto-lock.
//   Same threat model as macOS native keychain (encrypted-at-rest under that
//   master password), but operates without GUI.
//
//   Threat-model improvement vs plaintext-in-users.json:
//     before: read users.json → get passwords
//     after:  read users.json → get nothing useful; you'd need
//             ~/.openclaw/credentials/gym-booker-keychain-pw AND
//             ~/Library/Keychains/gym-booker.keychain-db together
//
// Layout: each cred is one keychain item with
//   service = "gym-booker-mindbody"
//   account = "<chatId>-<field>"  (e.g. "80151943-email", "80151943-password")
//   secret  = the value
//
// All operations go through /usr/bin/security via spawnSync (synchronous,
// explicit error surfaces, no swallowed failures).

const { spawnSync, spawnSync: _spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const SERVICE = 'gym-booker-mindbody';
const KEYCHAIN_PATH = path.join(os.homedir(), 'Library', 'Keychains', 'gym-booker.keychain-db');
const KEYCHAIN_PW_FILE = path.join(os.homedir(), '.openclaw', 'credentials', 'gym-booker-keychain-pw');
const SECURITY = '/usr/bin/security';

// Item-not-found exit code from /usr/bin/security
const NOT_FOUND = 44;

let _keychainEnsured = false;

function _readPw() {
  return fs.readFileSync(KEYCHAIN_PW_FILE, 'utf8').replace(/\n$/, '');
}

function _generatePw() {
  return crypto.randomBytes(32).toString('base64');
}

function _ensureKeychain() {
  if (_keychainEnsured) return;

  const pwExists = fs.existsSync(KEYCHAIN_PW_FILE);
  // The actual on-disk file is gym-booker.keychain-db (suffix added by macOS),
  // but `security` accepts either form for ops; we check both for existence.
  const kcExists = fs.existsSync(KEYCHAIN_PATH) || fs.existsSync(KEYCHAIN_PATH.replace(/-db$/, ''));

  if (pwExists && kcExists) {
    // Both present — just ensure unlocked (cheap if already unlocked)
    const pw = _readPw();
    const r = spawnSync(SECURITY, ['unlock-keychain', '-p', pw, KEYCHAIN_PATH], { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`keychain: unlock failed: ${r.stderr.trim()}`);
    }
    _keychainEnsured = true;
    return;
  }

  if (pwExists !== kcExists) {
    throw new Error(
      `keychain: inconsistent state — pwFile=${pwExists}, keychain=${kcExists}. ` +
      `Either both must exist or neither. Resolve manually before retrying.`
    );
  }

  // Bootstrap: generate password, write to file, create keychain, set never-lock
  const credsDir = path.dirname(KEYCHAIN_PW_FILE);
  fs.mkdirSync(credsDir, { recursive: true, mode: 0o700 });
  const pw = _generatePw();
  fs.writeFileSync(KEYCHAIN_PW_FILE, pw + '\n', { mode: 0o600 });

  const create = spawnSync(SECURITY, ['create-keychain', '-p', pw, KEYCHAIN_PATH], { encoding: 'utf8' });
  if (create.status !== 0) {
    throw new Error(`keychain: create-keychain failed: ${create.stderr.trim()}`);
  }
  // Note: we deliberately skip `security set-keychain-settings -t 0` (never
  // auto-lock) because it requires a UI session ("User interaction is not
  // allowed" over SSH). Instead we unlock on every operation — adds ~10ms
  // and keeps the bootstrap entirely headless.
  const unlock = spawnSync(SECURITY, ['unlock-keychain', '-p', pw, KEYCHAIN_PATH], { encoding: 'utf8' });
  if (unlock.status !== 0) {
    throw new Error(`keychain: post-create unlock failed: ${unlock.stderr.trim()}`);
  }
  _keychainEnsured = true;
}

function _unlockBeforeOp() {
  // Cheap re-unlock before each op. Inexpensive (~10ms) and shields against
  // the keychain re-locking itself on idle/sleep.
  if (!_keychainEnsured) _ensureKeychain();
  const pw = _readPw();
  const r = spawnSync(SECURITY, ['unlock-keychain', '-p', pw, KEYCHAIN_PATH], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`keychain: re-unlock failed: ${r.stderr.trim()}`);
  }
}

function _account(chatId, field) {
  if (chatId === undefined || chatId === null || chatId === '') {
    throw new Error('keychain: chatId required');
  }
  if (!field) throw new Error('keychain: field required');
  return `${chatId}-${field}`;
}

function getCred(chatId, field) {
  _unlockBeforeOp();
  const account = _account(chatId, field);
  const r = spawnSync(SECURITY, [
    'find-generic-password', '-s', SERVICE, '-a', account, '-w', KEYCHAIN_PATH,
  ], { encoding: 'utf8' });
  if (r.status === 0) {
    return r.stdout.replace(/\n$/, '');
  }
  if (r.status === NOT_FOUND) {
    return null;
  }
  throw new Error(
    `keychain: find-generic-password failed (status=${r.status}) for ${account}: ${r.stderr.trim()}`
  );
}

function hasCred(chatId, field) {
  return getCred(chatId, field) !== null;
}

function setCred(chatId, field, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`keychain: refusing to store empty value for ${chatId}-${field}`);
  }
  _unlockBeforeOp();
  const account = _account(chatId, field);
  const r = spawnSync(SECURITY, [
    'add-generic-password',
    '-s', SERVICE,
    '-a', account,
    '-w', value,
    '-U',
    KEYCHAIN_PATH,
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(
      `keychain: add-generic-password failed (status=${r.status}) for ${account}: ${r.stderr.trim()}`
    );
  }
}

function deleteCred(chatId, field) {
  _unlockBeforeOp();
  const account = _account(chatId, field);
  const r = spawnSync(SECURITY, [
    'delete-generic-password', '-s', SERVICE, '-a', account, KEYCHAIN_PATH,
  ], { encoding: 'utf8' });
  if (r.status === 0) return true;
  if (r.status === NOT_FOUND) return false;
  throw new Error(
    `keychain: delete-generic-password failed (status=${r.status}) for ${account}: ${r.stderr.trim()}`
  );
}

module.exports = {
  SERVICE,
  KEYCHAIN_PATH,
  KEYCHAIN_PW_FILE,
  getCred,
  hasCred,
  setCred,
  deleteCred,
};
