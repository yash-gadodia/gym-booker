// Multi-user fan-out wrapper. Spawns one child per user defined in users.json.
// ONE shared Chromium server backs the whole fleet (children connect() and get
// an isolated context each), and setups run one-at-a-time gated on the previous
// child being staged — five simultaneous browser cold-starts thrashed the mini
// into the 2026-06-06 and 2026-06-10 mass-misses. Every child still busy-waits
// to 09:00:00.000 SGT with its own auth and Bearer token, so the booking sprint
// itself stays simultaneous and popular slots are not lost to scheduling delay.
//
// Pass-through flags: any args other than --only/--skip are forwarded to every
// child (e.g. --dry-run, --now, a YYYY-MM-DD date, --no-api-direct).
//
// Usage:
//   node book-all.js                     # all users + Yash
//   node book-all.js --dry-run --now     # all, dry-run smoke
//   node book-all.js --only dani         # just one user
//   node book-all.js --only dani,yash    # subset
//   node book-all.js --skip yash         # everyone except Yash
//
// Exit code: 0 only if every child exited 0; non-zero if any failed.
require('dotenv').config();
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');
const { loadUsers } = require('./users');
const {
  buildDailySummary, sendYashAlert, sendTelegram, SETUP_COMPLETE_MARKER,
  buildWatchCandidates, upsertWatch, pruneWatchRegistry, decideDailyClaim,
  ymd, YASH_ALERT_CHAT_ID,
} = require('./lib');

const REGISTRY_PATH = process.env.GYM_WAITLIST_REGISTRY || path.join(__dirname, 'runs', 'waitlist-registry.json');

const NODE_BIN = process.execPath;
const BOOK_JS = path.join(__dirname, 'book.js');

function parseList(args, name) {
  const i = args.indexOf(`--${name}`);
  if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) return null;
  return args[i + 1].split(',').map(s => s.trim()).filter(Boolean);
}

function stripFlag(args, name) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return args;
  // Strip --name <value> if value follows; else just --name
  const next = args[i + 1];
  if (next && !next.startsWith('--')) return [...args.slice(0, i), ...args.slice(i + 2)];
  return [...args.slice(0, i), ...args.slice(i + 1)];
}

(async () => {
  let args = process.argv.slice(2);
  const onlyList = parseList(args, 'only');
  const skipList = parseList(args, 'skip');
  args = stripFlag(stripFlag(args, 'only'), 'skip');

  const users = loadUsers();

  // Roster: every user in users.json gets --user <id>. As of 2026-05-10,
  // Yash is also a regular entry in users.json (creds in keychain), so the
  // old "legacy no --user" branch is gone — all paths read keychain via
  // getCreds(). Drop --skip yash on the CLI to leave him out for a run.
  const roster = users.map(u => ({ id: u.id, label: u.label || u.id, bookArgs: ['--user', u.id] }));

  const filtered = roster.filter(r => {
    if (onlyList && !onlyList.includes(r.id)) return false;
    if (skipList && skipList.includes(r.id)) return false;
    return true;
  });

  if (filtered.length === 0) {
    console.error(`book-all: no users to run (only=${onlyList} skip=${skipList} roster=${roster.map(r => r.id).join(',')})`);
    process.exit(2);
  }

  // ── Daily-claim guard (dual-trigger arbitration) ────────────────────────
  // Two schedulers invoke a bare `node book-all.js` each morning: the 08:40
  // user LaunchAgent (primary, normal QoS) and the 08:54 system daemon
  // (backstop). The claim file makes the pair safe — never both booking, since
  // a double 9am sprint would double-book (Mindbody doesn't enforce
  // one-per-day) — and useful: the backstop auto-retries a failed or crashed
  // primary. Invocations carrying any flag/date (--only, --dry-run, recovery
  // dates...) are operator-driven and bypass the claim entirely.
  const isScheduledRun = process.argv.length <= 2;
  const todayYmd = ymd(new Date());
  const claimPath = path.join(__dirname, 'runs', `daily-claim-${todayYmd}.json`);
  const claimStartedAt = new Date().toISOString();
  const writeClaim = (status, extra = {}) => {
    try {
      const tmp = `${claimPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({
        date: todayYmd, pid: process.pid, startedAt: claimStartedAt,
        status, updatedAt: new Date().toISOString(), ...extra,
      }, null, 2));
      fs.renameSync(tmp, claimPath);
    } catch (e) { console.error(`book-all: claim write failed: ${e.message}`); }
  };
  if (isScheduledRun) {
    let claim = null;
    try { if (fs.existsSync(claimPath)) claim = JSON.parse(fs.readFileSync(claimPath, 'utf8')); } catch {}
    // pid-alive probe hardened against post-reboot pid reuse: the holder must
    // both respond to signal 0 AND still look like a booker node process.
    let pidAlive = false;
    if (claim && claim.status === 'running' && claim.pid) {
      try {
        process.kill(claim.pid, 0);
        const ps = spawnSync('ps', ['-p', String(claim.pid), '-o', 'command='], { encoding: 'utf8' });
        pidAlive = ps.status === 0 && /book-all|book\.js|node/.test(ps.stdout || '');
      } catch { pidAlive = false; }
    }
    const verdict = decideDailyClaim({ claim, pidAlive });
    console.log(`book-all: daily claim → ${verdict.action} (${verdict.reason})`);
    if (verdict.action === 'skip') process.exit(0);
    writeClaim('running');
    // Best-effort prune of claim files older than a week.
    try {
      for (const f of fs.readdirSync(path.join(__dirname, 'runs'))) {
        const m = f.match(/^daily-claim-(\d{4}-\d{2}-\d{2})\.json$/);
        if (m && (Date.now() - new Date(`${m[1]}T00:00:00+08:00`).getTime()) > 7 * 86400000) {
          fs.unlinkSync(path.join(__dirname, 'runs', f));
        }
      }
    } catch {}
  }

  console.log(`book-all: launching ${filtered.length} parallel run(s): ${filtered.map(r => r.id).join(', ')}`);
  if (args.length) console.log(`book-all: pass-through flags: ${args.join(' ')}`);

  // Each child writes its structured result JSON to BOOKER_RESULT_FILE so the
  // orchestrator can roll them up into the daily summary. Per-child temp file
  // (not shared) to dodge any cross-process write contention.
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'booker-results-'));
  const resultPathFor = (id) => path.join(resultsDir, `${id}.json`);

  // ONE shared Chromium for the whole fleet. launchServer() here, each child
  // connect()s and creates its own isolated context (per-user cookies/auth).
  // Five separate Chromium cold-starts at once thrashed the mini into the
  // 2026-06-06 (58s launch) and 2026-06-10 (every goto timing out) wipeouts.
  // If the server fails to launch, children fall back to private launches.
  let browserServer = null;
  let wsEndpoint = null;
  try {
    browserServer = await chromium.launchServer({ headless: true });
    wsEndpoint = browserServer.wsEndpoint();
    console.log('book-all: shared Chromium server up');
  } catch (e) {
    console.error(`book-all: launchServer failed (${e.message}) — children will launch private browsers`);
  }

  // Serialize the expensive phase: spawn the next child only when the previous
  // one is staged (SETUP_COMPLETE_MARKER on stdout), exits early (skip/failure),
  // or the gate times out. Peak host load becomes ONE browser setup at a time;
  // the 09:00 sprint is parallel API calls and stays simultaneous for everyone.
  const SETUP_GATE_TIMEOUT_MS = 150000;
  const children = [];
  for (let i = 0; i < filtered.length; i++) {
    const r = filtered[i];
    const childArgs = [...r.bookArgs, ...args];
    const tag = `[${r.id}]`;
    console.log(`${tag} spawn: node book.js ${childArgs.join(' ')}`);
    const proc = spawn(NODE_BIN, [BOOK_JS, ...childArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BOOKER_RESULT_FILE: resultPathFor(r.id),
        ...(wsEndpoint ? { BOOKER_WS_ENDPOINT: wsEndpoint } : {}),
      },
    });
    const isLast = i === filtered.length - 1;
    let releaseGate = () => {};
    let gate = null;
    if (!isLast) {
      gate = new Promise(resolve => {
        let released = false;
        releaseGate = (why) => {
          if (released) return;
          released = true;
          console.log(`${tag} setup gate released (${why})`);
          resolve();
        };
      });
    }
    // Tag every child line with [id] so interleaved output stays readable.
    const tagStream = (stream, sink, onLine) => {
      let buf = '';
      stream.on('data', chunk => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx + 1);
          sink.write(`${tag} ${line}`);
          if (onLine) onLine(line);
          buf = buf.slice(idx + 1);
        }
      });
      stream.on('end', () => { if (buf) { sink.write(`${tag} ${buf}\n`); if (onLine) onLine(buf); } });
    };
    tagStream(proc.stdout, process.stdout, line => {
      if (line.includes(SETUP_COMPLETE_MARKER)) releaseGate('staged');
    });
    tagStream(proc.stderr, process.stderr);
    const done = new Promise(resolve => proc.on('exit', code => {
      releaseGate(`exited ${code}`);
      resolve({ id: r.id, label: r.label, code });
    }));
    children.push({ proc, done });
    if (!isLast) {
      const timer = setTimeout(() => releaseGate(`timeout ${SETUP_GATE_TIMEOUT_MS}ms`), SETUP_GATE_TIMEOUT_MS);
      await gate;
      clearTimeout(timer);
    }
  }

  const results = await Promise.all(children.map(c => c.done));
  try { if (browserServer) await browserServer.close(); } catch {}
  const failed = results.filter(r => r.code !== 0);
  console.log(`\nbook-all: ${results.length} run(s) complete; ${failed.length} failed`);
  for (const r of results) console.log(`  ${r.code === 0 ? 'ok' : 'FAIL'} ${r.id} (exit=${r.code})`);

  // Roll up per-child result files into the daily summary. Children that
  // crashed without writing get a synthesized "no-result-file" entry so the
  // summary still pages Yash with the gap (silent gaps are the worst kind).
  const summaryRuns = [];
  let dayLabel = 'unknown';
  let runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  for (const r of filtered) {
    const file = resultPathFor(r.id);
    const childExit = results.find(x => x.id === r.id);
    let parsed = null;
    try {
      if (fs.existsSync(file)) parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { console.error(`book-all: failed to parse ${file}: ${e.message}`); }
    if (parsed) {
      summaryRuns.push({
        user: parsed.user,
        results: parsed.results,
        setupErrored: parsed.setupErrored,
        skipReason: parsed.skipReason || null,
        skipDetail: parsed.skipDetail || '',
      });
      if (parsed.dayLabel) dayLabel = parsed.dayLabel;
      if (parsed.runId) runId = parsed.runId;
    } else {
      // Child either crashed pre-write or didn't run book.js at all (very rare).
      // Synthesize so Yash still sees the gap in the daily summary.
      summaryRuns.push({
        user: { id: r.id, label: r.label },
        results: [{
          plan: { kind: '?', primaryTime: '?', fallback: null },
          status: { ok: false, reason: 'no-result-file', detail: `child exited ${childExit ? childExit.code : '?'} without writing result file` },
        }],
        setupErrored: true,
      });
    }
  }

  // Skip the summary in dry/now smoke tests (they suppress all telegram). The
  // env-flag is the same one book.js uses to mute its per-user tg() calls.
  // GYM_TEST_PRINT_SUMMARY=1 overrides for the e2e test: builds the summary
  // and prints to stdout instead of sending, so the test can assert on shape
  // without spamming the real Yash chat.
  const suppress = args.includes('--dry-run') || args.includes('--now') || args.includes('--no-wait');
  const summary = buildDailySummary({ runs: summaryRuns, runId, dayLabel });
  if (process.env.GYM_TEST_PRINT_SUMMARY === '1') {
    console.log('--- TEST DAILY SUMMARY ---');
    console.log(summary);
    console.log('--- END TEST DAILY SUMMARY ---');
  } else if (!suppress) {
    await sendYashAlert(summary);
  } else {
    console.log('book-all: daily summary suppressed (dry/now flag)');
  }

  // Write the daily bookings manifest so downstream agents (wodup-daily-send,
  // chasers, etc.) can see what each user ACTUALLY booked today, not what
  // their static users.json schedule claims. Solves a gap for users with
  // schedule:null (Yash, Dani) whose classes are driven dynamically by the
  // overrides/all-classes flow.
  //
  // File: runs/bookings-<targetYmd>.json. Only successful bookings are
  // listed; failures show up in the daily summary, not here. Suppressed runs
  // (--dry-run / --now smoke tests) must never touch it: a dry_run status is
  // ok:true, so without the guard a smoke test would overwrite the REAL
  // morning manifest with fake rows that wodup-daily-send then trusts.
  if (suppress) {
    console.log('book-all: bookings manifest skipped (dry/now flag)');
  } else try {
    let manifestDate = null;
    const bookings = {};
    for (const r of filtered) {
      const file = resultPathFor(r.id);
      let parsed = null;
      try { if (fs.existsSync(file)) parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (!parsed) continue;
      if (parsed.targetYmd && !manifestDate) manifestDate = parsed.targetYmd;
      const ok = (parsed.results || []).filter(x => x.status && x.status.ok && x.status.reason !== 'dry_run');
      if (!ok.length) continue;
      bookings[r.id] = ok.map(x => ({
        kind: x.plan.kind,
        time: x.status.time || x.plan.primaryTime,
      }));
    }
    if (manifestDate) {
      const manifestPath = path.join(__dirname, 'runs', `bookings-${manifestDate}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify({
        date: manifestDate,
        updated: new Date().toISOString(),
        runId,
        bookings,
      }, null, 2));
      console.log(`book-all: wrote bookings manifest ${manifestPath} (${Object.keys(bookings).length} user(s) with bookings)`);
    } else {
      console.log('book-all: skipped manifest (no targetYmd in any child payload)');
    }
  } catch (e) {
    console.error(`book-all: manifest write failed: ${e.message}`);
  }

  // ── Auto-enroll failed users into the waitlist watcher ────────────────────
  // For every plan that failed with a recoverable cause (classifyBookingFailure
  // → autoWatch), add the user+slot to runs/waitlist-registry.json so
  // waitlist-registry.js polls it and DMs them the moment a spot frees. This is
  // the safety net for misses like Geraldine's 2026-06-07 (api-direct pass-fetch
  // → fragile UI fallback → lost the booking). The enroll CONFIRMATION goes to
  // Yash only — no new unapproved user-facing send — while the watcher's
  // slot-open alerts reach the user via the chatIds stored on each entry.
  try {
    const nowMs = Date.now();
    const usersById = Object.fromEntries(users.map(u => [u.id, u]));
    const enrollRuns = [];
    for (const r of filtered) {
      let parsed = null;
      try {
        const f = resultPathFor(r.id);
        if (fs.existsSync(f)) parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {}
      if (!parsed) continue;
      enrollRuns.push({ id: r.id, user: parsed.user, targetYmd: parsed.targetYmd, results: parsed.results });
    }
    const candidates = buildWatchCandidates(enrollRuns, {
      usersById, nowMs, yashChatId: YASH_ALERT_CHAT_ID, nowIso: new Date().toISOString(),
    });

    if (candidates.length) {
      const lines = candidates.map(c => `• ${c.name}: ${c.kind} @ ${c.time} on ${c.date} (${c.reason})`);
      const note = `🔁 *Auto-enrolled into waitlist watcher* (${candidates.length})\n${lines.join('\n')}\nWill DM the second a slot frees.`;
      if (process.env.GYM_TEST_PRINT_ENROLL === '1') {
        console.log('--- TEST AUTO-ENROLL ---');
        console.log(JSON.stringify(candidates, null, 2));
        console.log(note);
        console.log('--- END TEST AUTO-ENROLL ---');
      } else if (suppress) {
        console.log(`book-all: auto-enroll suppressed (dry/now) — ${candidates.length} candidate(s)`);
      } else {
        let registry = { updated: null, watches: [] };
        try { if (fs.existsSync(REGISTRY_PATH)) registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); } catch {}
        let watches = pruneWatchRegistry(Array.isArray(registry.watches) ? registry.watches : [], nowMs);
        for (const c of candidates) watches = upsertWatch(watches, c);
        fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ updated: new Date().toISOString(), watches }, null, 2));
        console.log(`book-all: auto-enrolled ${candidates.length} user-slot(s); registry now has ${watches.length} active`);
        // DM each enrolled user their OWN technical reason + watchlist note (Yash
        // gets the same detail in the aggregate note below).
        for (const c of candidates) {
          if (!c.userChatId) continue;
          const dmy = c.date.split('-').reverse().join('-');
          await sendTelegram(c.userChatId,
            `🔁 ${c.name}, I couldn't lock in your ${c.kind} @ ${c.time} on ${dmy}.\n` +
            `Reason: ${c.cause}\n` +
            `You're on the waitlist watcher now and I'll ping you the second a spot frees. 🦞`);
        }
        await sendYashAlert(note);
      }
    } else {
      console.log('book-all: no auto-enroll candidates');
    }
  } catch (e) {
    console.error(`book-all: auto-enroll failed: ${e.message}`);
  }

  // Cleanup tmpdir.
  try { fs.rmSync(resultsDir, { recursive: true, force: true }); } catch {}

  const exitCode = failed.length > 0 ? 1 : 0;
  if (isScheduledRun) writeClaim(exitCode === 0 ? 'success' : 'fail', { exitCode, runId });
  process.exit(exitCode);
})();
