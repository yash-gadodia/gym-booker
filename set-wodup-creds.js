// One-time script to store Wodup credentials in keychain.
// Run once: node set-wodup-creds.js
// Then delete the password from this script.

const keychain = require('./keychain.js');

const SERVICE = 'gym-booker-wodup';
const WODUP_EMAIL = 'pirsquare.yash@gmail.com';
const WODUP_PASSWORD = '***REDACTED***';

// Note: keychain.js uses a hardcoded account format "chatId-field"
// For Wodup (no per-user), we'll use a sentinel chatId like "wodup-default"
const WODUP_ACCOUNT_PREFIX = 'wodup-default';

try {
  console.log('Setting Wodup credentials in keychain...');
  
  // We need to extend the keychain to support custom services.
  // For now, let's use the existing gym-booker-mindbody service with a special key prefix.
  const emailAccount = 'wodup-email';
  const passwordAccount = 'wodup-password';
  
  // Monkey-patch keychain module to use custom service
  const originalSetCred = keychain.setCred;
  keychain.setCred = function(chatId, field, value) {
    // Redirect wodup-* calls to a different approach
    if (chatId === 'wodup-default') {
      const { spawnSync } = require('child_process');
      const path = require('path');
      const os = require('os');
      const SECURITY = '/usr/bin/security';
      const KEYCHAIN_PATH = path.join(os.homedir(), 'Library', 'Keychains', 'gym-booker.keychain-db');
      const KEYCHAIN_PW_FILE = path.join(os.homedir(), '.openclaw', 'credentials', 'gym-booker-keychain-pw');
      
      // Unlock keychain first
      const pw = require('fs').readFileSync(KEYCHAIN_PW_FILE, 'utf8').replace(/\n$/, '');
      const unlock = spawnSync(SECURITY, ['unlock-keychain', '-p', pw, KEYCHAIN_PATH], { encoding: 'utf8' });
      
      const r = spawnSync(SECURITY, [
        'add-generic-password',
        '-s', 'gym-booker-wodup',
        '-a', field,
        '-w', value,
        '-U',
        KEYCHAIN_PATH,
      ], { encoding: 'utf8' });
      
      if (r.status !== 0) {
        throw new Error(`keychain: add-generic-password failed for wodup-${field}: ${r.stderr}`);
      }
      return;
    }
    
    // Fall back to original for other credentials
    return originalSetCred.call(this, chatId, field, value);
  };
  
  // Store credentials
  keychain.setCred('wodup-default', 'email', WODUP_EMAIL);
  keychain.setCred('wodup-default', 'password', WODUP_PASSWORD);
  
  console.log('Credentials stored successfully in keychain service: gym-booker-wodup');
  console.log('\nVerifying...');
  
  // Verify by reading back
  const { spawnSync } = require('child_process');
  const path = require('path');
  const os = require('os');
  const SECURITY = '/usr/bin/security';
  const KEYCHAIN_PATH = path.join(os.homedir(), 'Library', 'Keychains', 'gym-booker.keychain-db');
  
  const r = spawnSync(SECURITY, ['find-generic-password', '-s', 'gym-booker-wodup', '-a', 'email', '-w', KEYCHAIN_PATH], { encoding: 'utf8' });
  if (r.status === 0) {
    console.log('Email verified:', r.stdout.trim());
  }
  
  const rp = spawnSync(SECURITY, ['find-generic-password', '-s', 'gym-booker-wodup', '-a', 'password', '-w', KEYCHAIN_PATH], { encoding: 'utf8' });
  if (rp.status === 0) {
    console.log('Password verified: [stored securely]');
  }
  
  console.log('\nDone! Credentials are now in keychain.');
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
