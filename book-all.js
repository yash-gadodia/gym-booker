// Multi-user fan-out wrapper. Spawns Yash's legacy run (no --user) plus one
// child per user defined in users.json, all in parallel. Each child runs its
// own busy-wait to 09:00:00.000 SGT with its own browser, auth, and Bearer
// token, so popular slots are not lost to sequential scheduling delay.
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
const { spawn } = require('child_process');
const path = require('path');
const { loadUsers } = require('./users');

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

  // Roster: yash (legacy, no --user) + each user from users.json.
  const roster = [{ id: 'yash', label: 'Yash', bookArgs: [] }];
  for (const u of users) roster.push({ id: u.id, label: u.label || u.id, bookArgs: ['--user', u.id] });

  const filtered = roster.filter(r => {
    if (onlyList && !onlyList.includes(r.id)) return false;
    if (skipList && skipList.includes(r.id)) return false;
    return true;
  });

  if (filtered.length === 0) {
    console.error(`book-all: no users to run (only=${onlyList} skip=${skipList} roster=${roster.map(r => r.id).join(',')})`);
    process.exit(2);
  }

  console.log(`book-all: launching ${filtered.length} parallel run(s): ${filtered.map(r => r.id).join(', ')}`);
  if (args.length) console.log(`book-all: pass-through flags: ${args.join(' ')}`);

  const children = filtered.map(r => {
    const childArgs = [...r.bookArgs, ...args];
    const tag = `[${r.id}]`;
    console.log(`${tag} spawn: node book.js ${childArgs.join(' ')}`);
    const proc = spawn(NODE_BIN, [BOOK_JS, ...childArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    // Tag every child line with [id] so interleaved output stays readable.
    const tagStream = (stream, sink) => {
      let buf = '';
      stream.on('data', chunk => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          sink.write(`${tag} ${buf.slice(0, idx + 1)}`);
          buf = buf.slice(idx + 1);
        }
      });
      stream.on('end', () => { if (buf) sink.write(`${tag} ${buf}\n`); });
    };
    tagStream(proc.stdout, process.stdout);
    tagStream(proc.stderr, process.stderr);
    const done = new Promise(resolve => proc.on('exit', code => resolve({ id: r.id, label: r.label, code })));
    return { proc, done };
  });

  const results = await Promise.all(children.map(c => c.done));
  const failed = results.filter(r => r.code !== 0);
  console.log(`\nbook-all: ${results.length} run(s) complete; ${failed.length} failed`);
  for (const r of results) console.log(`  ${r.code === 0 ? 'ok' : 'FAIL'} ${r.id} (exit=${r.code})`);
  process.exit(failed.length > 0 ? 1 : 0);
})();
