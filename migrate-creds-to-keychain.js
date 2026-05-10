// One-shot migration: copy plaintext email/password from users.json into the
// gym-booker custom keychain, then optionally scrub the plaintext.
//
// Safety:
//   - Default mode is dry-run + verify (no users.json mutation).
//   - Pass --apply to actually scrub plaintext from users.json AFTER verifying
//     the keychain has the same value. Verify-or-bail: if the read-back value
//     doesn't match the original, we abort and leave plaintext in place.
//   - Idempotent: re-running on already-migrated users is a no-op.
//
// Usage:
//   node migrate-creds-to-keychain.js          # dry-run, prints plan
//   node migrate-creds-to-keychain.js --apply  # writes keychain, scrubs json

const fs = require('node:fs');
const path = require('node:path');
const keychain = require('./keychain');

const APPLY = process.argv.includes('--apply');

const USERS_FILE = path.join(__dirname, 'users.json');

function load() {
  const raw = fs.readFileSync(USERS_FILE, 'utf8');
  return { raw, doc: JSON.parse(raw) };
}

function save(doc) {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

function summarizeUser(u) {
  return `${u.id}/${u.label} (chat ${u.telegramChatId || 'unset'})`;
}

function main() {
  const { doc } = load();
  if (!Array.isArray(doc.users)) {
    console.error('users.json: missing .users array');
    process.exit(2);
  }

  const candidates = doc.users.filter(u => u.email && u.password && u.telegramChatId);
  const skipped = doc.users.filter(u => !candidates.includes(u));

  console.log(`MODE: ${APPLY ? 'APPLY (will mutate keychain + users.json)' : 'DRY-RUN (read-only)'}`);
  console.log(`users with plaintext creds + chatId: ${candidates.length}`);
  console.log(`users skipped (already migrated or incomplete): ${skipped.length}`);
  console.log();

  let migrated = 0;
  let alreadyOk = 0;
  let failed = 0;

  for (const u of candidates) {
    const tag = summarizeUser(u);
    const kEmail = keychain.getCred(u.telegramChatId, 'email');
    const kPassword = keychain.getCred(u.telegramChatId, 'password');

    const emailMatches = kEmail === u.email;
    const passwordMatches = kPassword === u.password;

    if (emailMatches && passwordMatches) {
      console.log(`✓ ${tag}: keychain already in sync`);
      alreadyOk++;
      continue;
    }

    console.log(`→ ${tag}: needs migration`);
    if (!APPLY) {
      console.log(`    [dry-run] would set keychain ${u.telegramChatId}-email + ${u.telegramChatId}-password`);
      continue;
    }

    try {
      keychain.setCred(u.telegramChatId, 'email', u.email);
      keychain.setCred(u.telegramChatId, 'password', u.password);
      // Verify-or-bail
      const verifyEmail = keychain.getCred(u.telegramChatId, 'email');
      const verifyPassword = keychain.getCred(u.telegramChatId, 'password');
      if (verifyEmail !== u.email || verifyPassword !== u.password) {
        throw new Error(
          `verify failed: keychain read-back differs from source ` +
          `(email match=${verifyEmail === u.email}, password match=${verifyPassword === u.password})`
        );
      }
      console.log(`    ✓ wrote + verified keychain for ${tag}`);
      migrated++;
    } catch (e) {
      console.error(`    ✗ ${tag}: ${e.message}`);
      failed++;
    }
  }

  console.log();
  console.log(`migrated: ${migrated}, already-ok: ${alreadyOk}, failed: ${failed}`);

  if (!APPLY) {
    console.log();
    console.log('Re-run with --apply to write keychain + scrub plaintext from users.json.');
    return;
  }

  if (failed > 0) {
    console.error();
    console.error(`refusing to scrub plaintext: ${failed} user(s) failed migration`);
    process.exit(3);
  }

  // Scrub plaintext from users.json. Only for users whose keychain is in sync.
  const { doc: docFresh } = load();
  let scrubbed = 0;
  for (const u of docFresh.users) {
    if (!u.telegramChatId) continue;
    const kEmail = keychain.getCred(u.telegramChatId, 'email');
    const kPassword = keychain.getCred(u.telegramChatId, 'password');
    if (kEmail && kPassword && (u.email || u.password)) {
      delete u.email;
      delete u.password;
      scrubbed++;
    }
  }
  if (scrubbed > 0) {
    save(docFresh);
    console.log(`scrubbed plaintext from ${scrubbed} user(s) in users.json`);
  } else {
    console.log('no plaintext to scrub');
  }
}

main();
