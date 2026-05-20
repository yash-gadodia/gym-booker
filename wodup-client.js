// Wodup client — fetch workouts by date.
// Uses Playwright to login and scrape workouts from https://www.wodup.com/timeline?date=YYYY-MM-DD

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');

const WODUP_URL = 'https://www.wodup.com';
const WODUP_LOGIN_URL = 'https://www.wodup.com/login';
const WODUP_TIMELINE_URL = 'https://www.wodup.com/timeline';
const AUTH_STATE_PATH = path.join(__dirname, 'wodup-auth.json');
const SECURITY = '/usr/bin/security';
const KEYCHAIN_PATH = path.join(os.homedir(), 'Library', 'Keychains', 'gym-booker.keychain-db');
const KEYCHAIN_PW_FILE = path.join(os.homedir(), '.openclaw', 'credentials', 'gym-booker-keychain-pw');

// Retrieve credential from keychain
function getKeychainCred(account) {
  try {
    const keychainPw = fs.readFileSync(KEYCHAIN_PW_FILE, 'utf8').replace(/\n$/, '');
    const r = spawnSync(SECURITY, ['unlock-keychain', '-p', keychainPw, KEYCHAIN_PATH], { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`unlock failed: ${r.stderr}`);
    }
    
    const result = spawnSync(SECURITY, [
      'find-generic-password', '-s', 'gym-booker-wodup', '-a', account, '-w', KEYCHAIN_PATH
    ], { encoding: 'utf8' });
    
    if (result.status !== 0) {
      return null;
    }
    return result.stdout.replace(/\n$/, '');
  } catch (e) {
    console.error('wodup-client: keychain error:', e.message);
    return null;
  }
}

// Login to Wodup and save auth state
async function login() {
  const email = getKeychainCred('email');
  const password = getKeychainCred('password');
  
  if (!email || !password) {
    throw new Error('wodup-client: missing credentials in keychain (email or password)');
  }
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  try {
    console.log('wodup-client: logging in to Wodup...');
    await page.goto(WODUP_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    
    await page.fill('input[name="username"]', email);
    const pwInput = await page.$('input[type="password"]');
    if (!pwInput) {
      throw new Error('password input not found');
    }
    await pwInput.fill(password);
    
    const submitBtn = await page.$('button[type="submit"]');
    if (!submitBtn) {
      throw new Error('submit button not found');
    }
    
    await submitBtn.click();
    
    // Wait for redirect to timeline or dashboard
    await page.waitForURL(`${WODUP_URL}/**`, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    
    // Verify we're logged in
    const pageText = await page.evaluate(() => document.body.innerText);
    if (!pageText.includes('Timeline') && !pageText.includes('FIT') && !pageText.includes('BURN')) {
      throw new Error('login failed: page does not contain expected content');
    }
    
    // Save auth state (cookies + storage)
    const storageState = await context.storageState();
    fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify(storageState, null, 2), { mode: 0o600 });
    console.log('wodup-client: auth state saved');
    
    await browser.close();
    return { storageStatePath: AUTH_STATE_PATH };
  } catch (e) {
    await browser.close();
    throw e;
  }
}

// Fetch workouts for a given date (YYYY-MM-DD format)
async function fetchWorkouts(dateYmd) {
  // Ensure auth state exists and is recent
  let authExists = fs.existsSync(AUTH_STATE_PATH);
  if (!authExists) {
    console.log('wodup-client: auth state missing, logging in...');
    await login();
    authExists = true;
  }
  
  const browser = await chromium.launch({ headless: true });
  
  try {
    // Load auth state
    const storageState = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf8'));
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    
    const url = `${WODUP_TIMELINE_URL}?date=${dateYmd}`;
    console.log(`wodup-client: fetching ${url}...`);
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500);
    
    // Extract workouts by kind
    const workouts = await page.evaluate(() => {
      const workoutMap = {};
      const allText = document.body.innerText;
      const lines = allText.split('\n');
      
      // Find indices of "Log Result" (marks start of workout content)
      const workoutStarts = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === 'Log Result') {
          workoutStarts.push(i);
        }
      }
      
      workoutStarts.forEach(startIdx => {
        // Work backwards to find the kind
        let kind = '';
        for (let i = startIdx - 1; i >= Math.max(0, startIdx - 5); i--) {
          const line = lines[i].trim().toUpperCase();
          if (['FIT', 'BURN', 'LIFT', 'STEAM', 'GYMNASTICS', 'RUN', 'CONDITIONING'].includes(line)) {
            kind = line;
            break;
          }
        }
        
        if (!kind) return;
        
        // Work forwards to find where this workout ends
        let endIdx = startIdx + 1;
        for (let i = startIdx + 1; i < lines.length; i++) {
          const line = lines[i].trim();
          const isNextKind = ['FIT', 'BURN', 'LIFT', 'STEAM', 'GYMNASTICS', 'RUN', 'CONDITIONING'].includes(line.toUpperCase());
          if (isNextKind && i > startIdx + 5) {
            endIdx = i;
            break;
          }
          if (line.startsWith('Choose which programs')) {
            endIdx = i;
            break;
          }
        }
        
        // Extract workout lines
        const workoutLines = [];
        for (let i = startIdx + 1; i < endIdx; i++) {
          const line = lines[i].trim();
          if (line === 'Leaderboard') continue;
          if (line === 'Show full workout') break;
          if (line === '') continue;
          workoutLines.push(line);
        }
        
        if (workoutLines.length > 1) {
          workoutMap[kind] = workoutLines.join('\n');
        }
      });
      
      return workoutMap;
    });
    
    await context.close();
    return workouts;
  } catch (e) {
    if (e.message && e.message.includes('401')) {
      // Session expired, try re-login
      console.log('wodup-client: session expired, re-logging in...');
      await browser.close();
      await login();
      return fetchWorkouts(dateYmd);
    }
    throw e;
  } finally {
    await browser.close();
  }
}

module.exports = {
  login,
  fetchWorkouts,
};
