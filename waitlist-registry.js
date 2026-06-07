// Multi-watch registry runner. Fans waitlist-watch.js out over every active
// entry in runs/waitlist-registry.json, exactly like book-all.js fans book.js
// out over users.json. book-all.js auto-enrolls failed bookings here; this
// process (one LaunchAgent, every ~2 min) polls each one and lets the existing
// one-shot watcher do the DMing. Pruning + userBooked detection retire entries
// so the registry stays self-cleaning.
//
// This is ADDITIVE: the original single-target watcher (run-waitlist.sh /
// com.voltade.gym-waitlist) is untouched and still serves any hand-armed slot.
//
// Run: node waitlist-registry.js          # one poll cycle over all entries
require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pruneWatchRegistry, sendYashAlert } = require('./lib');

const REGISTRY_PATH = process.env.GYM_WAITLIST_REGISTRY || path.join(__dirname, 'runs', 'waitlist-registry.json');
const WATCH_JS = path.join(__dirname, 'waitlist-watch.js');
const NODE_BIN = process.execPath;
const DRY = process.argv.includes('--dry'); // list what would be polled; spawn nothing
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

function loadWatches() {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const j = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
      if (Array.isArray(j.watches)) return j.watches;
    }
  } catch (e) { log(`registry read failed: ${e.message}`); }
  return [];
}

function saveWatches(watches) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ updated: new Date().toISOString(), watches }, null, 2));
}

// Mirror waitlist-watch.js's per-user watchId so we can read its state file.
function stateFileFor(w) {
  const watchId = `${w.date}_${String(w.time).replace(':', '')}-${w.user}`;
  return path.join(__dirname, 'runs', `waitlist-state-${watchId}.json`);
}

function isUserBooked(w) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFileFor(w), 'utf8'));
    return !!(s.userBooked || s.promoted);
  } catch { return false; }
}

// Run one poll of one watch by invoking the proven one-shot watcher with the
// entry's env. Resolves on child exit (never rejects — one bad watch must not
// abort the cycle).
function pollOne(w) {
  return new Promise(resolve => {
    if (!w.chatIds) { log(`skip ${w.user} ${w.kind}@${w.time}: no chatIds`); return resolve(); }
    const env = {
      ...process.env,
      WAITLIST_USER: w.user,
      WAITLIST_NAME: w.name || w.user,
      WAITLIST_KIND: w.kind,
      TELEGRAM_CHAT_ID: w.chatIds,
    };
    log(`poll ${w.user} ${w.kind} @ ${w.time} on ${w.date} (→ ${w.chatIds})`);
    const proc = spawn(NODE_BIN, [WATCH_JS, w.date, w.time], { stdio: 'inherit', env });
    proc.on('exit', code => { if (code) log(`watcher for ${w.user} exited ${code}`); resolve(); });
    proc.on('error', e => { log(`watcher spawn failed for ${w.user}: ${e.message}`); resolve(); });
  });
}

(async () => {
  const nowMs = Date.now();
  // Active set = future classes the user has not yet gotten into.
  let watches = pruneWatchRegistry(loadWatches(), nowMs).filter(w => !isUserBooked(w));
  saveWatches(watches);

  if (!watches.length) { log('no active watches'); process.exit(0); }
  log(`${DRY ? 'would poll' : 'polling'} ${watches.length} watch(es): ${watches.map(w => `${w.user}:${w.kind}@${w.time}`).join(', ')}`);

  if (DRY) { log('--dry: not spawning watchers'); process.exit(0); }

  // Sequential: N concurrent Chromium launches thrash the Mac Mini (the same
  // lesson book-all learned in the 2026-06-06 wipeout). Watch counts are small.
  for (const w of watches) {
    await pollOne(w);
  }

  // Reload (a concurrent book-all run may have enrolled someone mid-cycle),
  // then drop anyone who just got in or whose class started during polling.
  const after = pruneWatchRegistry(loadWatches(), Date.now()).filter(w => !isUserBooked(w));
  saveWatches(after);
  log(`cycle done; ${after.length} watch(es) remain`);
  process.exit(0);
})().catch(async (e) => {
  log(`FATAL ${e.message}`);
  try { await sendYashAlert(`🚨 gym waitlist-registry runner crashed: ${e.message}`); } catch {}
  process.exit(1);
});
