// Lawrence's voice. Active vibe per user is set in users.json `vibe` field
// (or VIBES_BY_ID by user id, or DEFAULT_VIBE as final fallback). The pools
// `chaotic` (giga-chad / Free Guy) and `wholesome` (warm hype-coach) are kept
// in case anyone wants to switch back, but the active default is `gymbro` —
// toxic-gym-bro energy: mass-monster lingo, light ribbing, "no skip days".
//
// Each exported function returns a single Telegram-ready string with
// Markdown formatting. Variants are picked uniformly at random per send so
// the same booking outcome looks fresh every morning.
//
// Markdown safety: dynamic interpolation (statusTitle, error messages,
// arbitrary plan text) is run through `safe()` to strip *_[]` chars that
// break Telegram's parse_mode=Markdown. The book.js tg() helper already
// has a plain-text fallback; this is just a belt-and-braces.

const VIBES_BY_ID = {};
const DEFAULT_VIBE = 'gymbro';

function vibeFor(user) {
  if (!user) return DEFAULT_VIBE;
  if (user.vibe) return user.vibe;
  return VIBES_BY_ID[user.id] || DEFAULT_VIBE;
}

function firstName(user) {
  return user ? (user.label || user.id) : 'Yash';
}

let _rng = Math.random;
function _setRng(fn) { _rng = fn; }
function _resetRng() { _rng = Math.random; }
function pick(arr) {
  if (!arr || arr.length === 0) throw new Error('personality: empty pool');
  return arr[Math.floor(_rng() * arr.length)];
}
function safe(s) {
  return String(s == null ? '' : s).replace(/[_*[\]`]/g, '');
}

// ──────────────────────── 🚀 STARTED ────────────────────────
const STARTED = {
  chaotic: [
    ({ planLine, dayLabel, ceilSecs }) => `🚀 *Booting up.* Mission: ${planLine} on ${dayLabel}. ETA: ${ceilSecs} min.`,
    ({ planLine, dayLabel, secs }) => `🚀 *Strapped in.* ${dayLabel} ${planLine} acquisition in T-${secs}s. Hold my coffee.`,
    ({ planLine, dayLabel }) => `🚀 *Lawrence online.* Today's quest: snipe ${planLine} on ${dayLabel}. Anti-FULL countermeasures armed.`,
    ({ planLine, dayLabel }) => `🚀 *Engines warm.* Targeting ${planLine} on ${dayLabel}. Singapore's gym goblins stay losing.`,
    ({ planLine, dayLabel }) => `🚀 *Suit up.* ${planLine} on ${dayLabel}. We don't miss.`,
    ({ planLine, dayLabel }) => `🚀 *Showing up so you don't have to.* ${planLine} on ${dayLabel}, incoming.`,
    ({ planLine, dayLabel }) => `🚀 *Wake-up call.* ${dayLabel} = ${planLine} day. Lawrence handling logistics.`,
  ],
  wholesome: [
    ({ planLine, dayLabel, ceilSecs }) => `🌅 *Good morning!* Going for ${planLine} on ${dayLabel} for you — back in ${ceilSecs} min ☀️`,
    ({ planLine, dayLabel }) => `☀️ *Lawrence here!* Today's mission: lock in ${planLine} on ${dayLabel}`,
    ({ first, planLine, dayLabel }) => `💪 *Hey ${first}!* Gym squad activated. Targeting ${planLine} on ${dayLabel}`,
    ({ planLine, dayLabel }) => `🔋 *On it!* Booking ${planLine} for ${dayLabel}. Give me a sec`,
    ({ planLine, dayLabel }) => `🌟 *Hi friend!* Locking in ${planLine} on ${dayLabel} for you`,
    ({ first, planLine, dayLabel }) => `✨ *Morning ${first}!* Going to grab you ${planLine} on ${dayLabel}`,
  ],
  gymbro: [
    ({ planLine, dayLabel, secs }) => `🏋️ *Yo. Strapping in.* ${planLine} on ${dayLabel}. We don't skip days, bro. T-${secs}s.`,
    ({ planLine, dayLabel, first }) => `💪 *Bro mode: engaged.* Locking in ${planLine} on ${dayLabel}. Show me those gains, ${first}.`,
    ({ planLine, dayLabel }) => `🤝 *Trust the process.* ${planLine} on ${dayLabel}. Lawrence got you, mass monster.`,
    ({ planLine, dayLabel }) => `🏋️ *Sleeves rolled up.* ${planLine} on ${dayLabel}. Excuses are for the weak.`,
    ({ planLine, dayLabel, secs }) => `🥇 *Pre-workout's hitting.* ${planLine} on ${dayLabel}. T-${secs}s till the door opens.`,
    ({ planLine, dayLabel }) => `💯 *Showing up = 50% of it.* I handle the booking. You handle the reps. ${planLine} on ${dayLabel}.`,
    ({ planLine, dayLabel }) => `🔥 *Sleeves crying for help.* ${planLine} on ${dayLabel}. Let's cook.`,
    ({ planLine, dayLabel, first }) => `💪 *Listen up, ${first}.* ${planLine} on ${dayLabel} is non-negotiable. Lawrence on it.`,
  ],
};
function started(user, ctx) {
  const tmpl = pick(STARTED[vibeFor(user)]);
  return tmpl({
    planLine: safe(ctx.planLine),
    dayLabel: safe(ctx.dayLabel),
    secs: ctx.secs,
    ceilSecs: Math.max(1, Math.ceil(ctx.secs / 60)),
    first: firstName(user),
  });
}

// ──────────────────────── 🔐 LOGGED IN ────────────────────────
const LOGGED_IN = {
  chaotic: [
    () => `🔐 *In.* Cookies refreshed. Papers in order.`,
    () => `🔐 *Snuck into Mindbody.* Session refreshed. They never know.`,
    () => `🔐 *Authenticated.* Lockpicked the door. Hung up my coat.`,
    () => `🔐 *Logged in like a ghost.* Auth.json gleaming.`,
    () => `🔐 *Mindbody welcomes back its favorite ghost.* Session live.`,
  ],
  wholesome: [
    () => `🔐 Logged in! ✅`,
    () => `🔐 Mindbody session ready ✓`,
    () => `🔐 All signed in, continuing... 👍`,
  ],
  gymbro: [
    () => `🔐 *In.* Mindbody knows what time it is.`,
    () => `🔐 *Authenticated.* The app fears us, bro.`,
    () => `🔐 *Logged in like a beast.* Receipts secured.`,
    () => `🔐 *Punch card stamped.* Let's eat.`,
    () => `🔐 *No CAPTCHA could hold me.* Session live.`,
    () => `🔐 *Form check: passed.* Auth on point.`,
  ],
};
function loggedIn(user) {
  return pick(LOGGED_IN[vibeFor(user)])({});
}

// ──────────────────────── ⏸️ ON STANDBY ────────────────────────
const STANDBY_UI = {
  chaotic: [
    ({ planLine, secs }) => `⏸️ *Locked, loaded, lurking.* ${planLine}. Window opens in ${secs}s. Don't blink.`,
    ({ planLine, secs }) => `⏸️ *Row staged.* ${planLine}. T-${secs}s to launch. Holding breath.`,
    ({ planLine, secs }) => `⏸️ *Pre-cocked the trigger.* ${planLine}. ${secs}s till 09:00. Mindbody has no idea.`,
    ({ planLine, secs }) => `⏸️ *On the clock.* ${planLine}. ${secs}s. The race begins.`,
  ],
  wholesome: [
    ({ planLine, secs }) => `⏸️ *Almost there!* ${planLine} — booking opens in ${secs}s ⏰`,
    ({ planLine, secs }) => `⏸️ Ready to go ${planLine} in ${secs}s 🎯`,
    ({ planLine, secs }) => `⏸️ All queued up, just waiting on the clock... ${secs}s ⏳`,
  ],
  gymbro: [
    ({ planLine, secs }) => `⏸️ *Loaded the bar.* ${planLine}. Door opens in ${secs}s. Don't blink.`,
    ({ planLine, secs }) => `⏸️ *Cocked, locked, juiced up.* ${planLine}. ${secs}s to spam BOOK NOW.`,
    ({ planLine, secs }) => `⏸️ *Rep 0, set 0.* ${planLine}. T-${secs}s till liftoff.`,
    ({ planLine, secs }) => `⏸️ *Spotter ready.* ${planLine}. ${secs}s. We don't miss reps.`,
  ],
};
const STANDBY_API = {
  chaotic: [
    ({ planLine, secs }) => `⏸️ *API path pre-warmed.* ${planLine}. ${secs}s to sub-2-second body slam.`,
    ({ planLine, secs }) => `⏸️ *Bearer captured. Pass on standby.* ${planLine}. T-${secs}s.`,
    ({ planLine, secs }) => `⏸️ *Skipping the React UI peasant queue.* ${planLine} via API direct. ${secs}s out.`,
    ({ planLine, secs }) => `⏸️ *6-call pipeline cocked and locked.* ${planLine}. ${secs}s.`,
  ],
  wholesome: [
    ({ planLine, secs }) => `⏸️ *All set!* ${planLine} pre-warmed via fast-path API — booking in ${secs}s ⚡`,
    ({ planLine, secs }) => `⏸️ Locked and ready. ${planLine} in ${secs}s ⏰`,
    ({ planLine, secs }) => `⏸️ Pre-warmed the express lane. ${planLine}, opens in ${secs}s 🚀`,
  ],
  gymbro: [
    ({ planLine, secs }) => `⏸️ *6-call superset queued.* ${planLine}. ${secs}s till PR.`,
    ({ planLine, secs }) => `⏸️ *Bearer token hits like creatine.* ${planLine}. ${secs}s.`,
    ({ planLine, secs }) => `⏸️ *Skipping the React UI cardio bunnies.* ${planLine} via API. ${secs}s out.`,
    ({ planLine, secs }) => `⏸️ *No-rep merchants HATE this.* ${planLine}. ${secs}s.`,
  ],
};
function standby(user, ctx) {
  const pool = ctx.mode === 'api' ? STANDBY_API : STANDBY_UI;
  return pick(pool[vibeFor(user)])({
    planLine: safe(ctx.planLine),
    secs: ctx.secs,
  });
}

// ──────────────────────── ✅/❌ OUTCOME ────────────────────────
// status from book.js: { ok, reason, detail, time, timing?, via? }
//   ok=true reasons:  booked, booked (api-direct), booked (fallback),
//                     booked (BUY-confirmed), already_booked, dry_run, opt_out_day
//   ok=false reasons: not booked, unverified, exception, FULL-ish

const OUTCOME = {
  // Fastest happy path — api-direct booked. Includes timing in ms.
  bookedFast: {
    chaotic: [
      ({ planLine, dayLabel, ms }) => `🔒 *LOCKED IN.* ${planLine} on ${dayLabel} is yours. Smashed Mindbody in ${ms}ms — they didn't even see it coming.`,
      ({ planLine, dayLabel, ms, first }) => `✨ *DONE.* ${planLine} on ${dayLabel}. ${ms}ms. Go be insufferably fit, ${first}.`,
      ({ planLine, dayLabel, ms }) => `🥇 *Gold medal performance.* ${planLine} on ${dayLabel} secured in ${ms}ms. The other gym bros are reading this and crying.`,
      ({ planLine, dayLabel, ms }) => `💥 *BOOM.* ${planLine} on ${dayLabel}. ${ms}ms. Mindbody's lawyers want to talk.`,
      ({ planLine, dayLabel, ms, first }) => `✅ *Booked, ${first}.* ${planLine} on ${dayLabel}. ${ms}ms flat. Singapore's gym goblins stay losing.`,
      ({ planLine, dayLabel, ms }) => `🚀 *Annihilated.* ${planLine} on ${dayLabel} secured in ${ms}ms. The fastest booking in the East.`,
    ],
    wholesome: [
      ({ planLine, dayLabel, ms }) => `✅ *All booked!* ${planLine} on ${dayLabel} — see you there 💪 (took ${ms}ms ⚡)`,
      ({ planLine, dayLabel, ms, first }) => `🎉 *Booking secured!* ${planLine} on ${dayLabel} for you, ${first}. Crushed it in ${ms}ms 🔥`,
      ({ planLine, dayLabel, first }) => `✨ *Yes!* ${planLine} on ${dayLabel} is locked in for you, ${first} 🌟`,
      ({ planLine, dayLabel, ms }) => `💪 *${planLine} on ${dayLabel}* — booked in ${ms}ms. You got this 🔥`,
      ({ planLine, dayLabel }) => `🌟 *Locked in!* ${planLine} on ${dayLabel}. Have an amazing class 💪`,
    ],
    gymbro: [
      ({ planLine, dayLabel, ms }) => `💪 *LOCKED IN, BRO.* ${planLine} on ${dayLabel}. ${ms}ms. Light weight, baby.`,
      ({ planLine, dayLabel, ms }) => `🏋️ *PR'd the booking.* ${planLine} on ${dayLabel}. ${ms}ms. Mindbody on the floor crying.`,
      ({ planLine, dayLabel, ms }) => `🔥 *Yessir.* ${planLine} on ${dayLabel}. ${ms}ms. Now go earn it.`,
      ({ planLine, dayLabel, ms, first }) => `💯 *No skip days.* ${planLine} on ${dayLabel}. ${ms}ms. Don't half-rep me, ${first}.`,
      ({ planLine, dayLabel, ms }) => `🥇 *Locked. Loaded. Lifted.* ${planLine} on ${dayLabel}. ${ms}ms. The bar is set.`,
      ({ planLine, dayLabel, ms, first }) => `💪 *Booked in ${ms}ms, ${first}.* ${planLine} on ${dayLabel}. The gym is calling. Pick up.`,
      ({ planLine, dayLabel, ms }) => `🚀 *Annihilated the queue.* ${planLine} on ${dayLabel} in ${ms}ms. Mass-monster mode.`,
    ],
  },
  // UI-flow booked (no ms timing). Slower path, still success.
  bookedSlow: {
    chaotic: [
      ({ planLine, dayLabel }) => `✅ *Booked.* ${planLine} on ${dayLabel}. Took the scenic UI route but we got there.`,
      ({ planLine, dayLabel, first }) => `✅ *Done, ${first}.* ${planLine} on ${dayLabel}. The React UI behaved itself for once.`,
      ({ planLine, dayLabel }) => `✅ *Locked in.* ${planLine} on ${dayLabel}. Manual mode but mission accomplished.`,
    ],
    wholesome: [
      ({ planLine, dayLabel }) => `✅ *All booked!* ${planLine} on ${dayLabel} — see you there 💪`,
      ({ planLine, dayLabel, first }) => `🎉 *Booking secured!* ${planLine} on ${dayLabel} for you, ${first} 🌟`,
    ],
    gymbro: [
      ({ planLine, dayLabel }) => `✅ *Got there, bro.* ${planLine} on ${dayLabel}. UI flow but mission accomplished.`,
      ({ planLine, dayLabel }) => `💪 *Booked.* ${planLine} on ${dayLabel}. Slow lane but no DNF.`,
      ({ planLine, dayLabel, first }) => `✅ *Done, ${first}.* ${planLine} on ${dayLabel}. The React UI behaved itself for once.`,
    ],
  },
  // Pre-flight detected an existing booking — idempotent rerun.
  alreadyBooked: {
    chaotic: [
      ({ planLine, dayLabel }) => `✅ *Already booked.* ${planLine} on ${dayLabel}. Lawrence stands down — past-you already won this round.`,
      ({ planLine, dayLabel }) => `✅ *Past-you was on top of things.* ${planLine} on ${dayLabel} already locked in.`,
      ({ planLine, dayLabel }) => `✅ *Nothing to do.* ${planLine} on ${dayLabel} was already in your schedule. Go drink water.`,
    ],
    wholesome: [
      ({ planLine, dayLabel }) => `✅ You're already booked for ${planLine} on ${dayLabel} 🌟 nothing for me to do!`,
      ({ planLine, dayLabel }) => `✓ Already locked in for ${planLine} on ${dayLabel} 💪`,
    ],
    gymbro: [
      ({ planLine, dayLabel, first }) => `✅ *Past-${first} was on it.* ${planLine} on ${dayLabel} already locked. Lawrence stands down. Drink water.`,
      ({ planLine, dayLabel }) => `✅ *No double-booking, no double-dipping.* ${planLine} on ${dayLabel} is already yours.`,
      ({ planLine, dayLabel, first }) => `💪 *${first} woke up ahead of schedule.* ${planLine} on ${dayLabel} already on the books.`,
    ],
  },
  // Dry-run mode — no booking attempted.
  dryRun: {
    chaotic: [
      ({ planLine, dayLabel }) => `🧪 *Dry run.* Would have booked ${planLine} on ${dayLabel}. No ammo spent.`,
    ],
    wholesome: [
      ({ planLine, dayLabel }) => `🧪 Dry-run only — would have booked ${planLine} on ${dayLabel}`,
    ],
    gymbro: [
      ({ planLine, dayLabel }) => `🧪 *Dry run, no gains.* Would have booked ${planLine} on ${dayLabel}. No protein wasted.`,
    ],
  },
  // No class scheduled today (per-user opt-out for this DOW).
  optOut: {
    chaotic: [
      ({ dayLabel }) => `⏭️ *Rest day, champion.* No class on ${dayLabel}. Hydrate, stretch, snack 🥗`,
      ({ dayLabel }) => `🛌 *Lawrence is OFF for ${dayLabel}.* Enjoy the lie-in.`,
      ({ dayLabel }) => `🕊️ *${dayLabel} = peace and quiet.* Nothing on the schedule.`,
    ],
    wholesome: [
      ({ dayLabel }) => `🛌 Rest day for ${dayLabel}! Enjoy the lie-in 😴`,
      ({ dayLabel }) => `🕊️ No class on ${dayLabel} — relax and recharge ✨`,
      ({ dayLabel }) => `🥗 ${dayLabel} is a rest day — hydrate, stretch, snack 💚`,
    ],
    gymbro: [
      ({ dayLabel, first }) => `🛌 *Rest day, ${first}.* No class on ${dayLabel}. Recovery IS the gain.`,
      ({ dayLabel }) => `💤 *Mandatory deload.* ${dayLabel} = nothing. Don't even think about doubling up tomorrow.`,
      ({ dayLabel }) => `🥗 *Refuel day.* ${dayLabel}. Hit the protein. Hit the bed. Be back stronger.`,
      ({ dayLabel }) => `🛌 *Day off, big guy.* ${dayLabel} — schedule's clean. Stretch, hydrate, repeat.`,
    ],
  },
  // User is on a multi-day pause (pauseUntil window).
  paused: {
    chaotic: [
      ({ dayLabel, detail }) => `⏸️ *Bookings paused.* ${dayLabel}: standing down (${detail || 'pause active'}). Resume on your word, captain.`,
      ({ dayLabel }) => `⏸️ *On ice.* ${dayLabel} is inside your pause window. Lawrence stays in his lane.`,
      ({ dayLabel, detail }) => `🛑 *Paused.* No booking for ${dayLabel} — ${detail || 'on leave'}. DM me to un-pause anytime.`,
    ],
    wholesome: [
      ({ dayLabel, detail }) => `⏸️ Bookings paused for ${dayLabel} — ${detail || 'on leave'}. Lmk when you're back! 💛`,
      ({ dayLabel }) => `🛑 You're on a break — no booking for ${dayLabel}. Enjoy the time off ✨`,
    ],
    gymbro: [
      ({ dayLabel, detail }) => `⏸️ *On a deload.* ${dayLabel}: standing down (${detail || 'pause active'}). Resume on your word, captain.`,
      ({ dayLabel, detail }) => `🛑 *Bookings paused, body on rest.* ${dayLabel} — ${detail || 'on leave'}. DM me to un-pause.`,
      ({ dayLabel }) => `⏸️ *On ice.* ${dayLabel} is inside your pause window. Lawrence stays in his lane.`,
    ],
  },
  // User explicitly skipped this single date.
  dateSkip: {
    chaotic: [
      ({ dayLabel }) => `⏭️ *Skipped on request.* ${dayLabel} — you said no, Lawrence said cool.`,
      ({ dayLabel }) => `❎ *${dayLabel}: cancelled by you.* Honoring the override. Tomorrow's still on.`,
    ],
    wholesome: [
      ({ dayLabel }) => `❎ Skipping ${dayLabel} as you asked! Have a lovely day 💛`,
      ({ dayLabel }) => `⏭️ ${dayLabel} skipped per your request. See you next class! 🌟`,
    ],
    gymbro: [
      ({ dayLabel }) => `⏭️ *Skipped per request.* ${dayLabel} — you said no, the bar said cool.`,
      ({ dayLabel }) => `❎ *${dayLabel} cancelled.* Honoring the override. Tomorrow's still leg day.`,
    ],
  },
  // Race lost — class went FULL before we could BUY.
  full: {
    chaotic: [
      ({ planLine, dayLabel, first }) => `💀 *BRUTAL.* ${planLine} on ${dayLabel} went FULL before I could blink. Sorry ${first}, Singapore is built different on ${dayLabel}s.`,
      ({ planLine, dayLabel }) => `❌ *Got rinsed.* ${planLine} on ${dayLabel} is FULL. The race was lost. I have failed you.`,
      ({ planLine, dayLabel }) => `❌ *Cooked.* ${planLine} on ${dayLabel} FULL. Manual recon required, captain.`,
      ({ planLine, dayLabel }) => `🥲 *Outflexed.* ${planLine} on ${dayLabel} filled up faster than my reflexes. Try the waitlist?`,
    ],
    wholesome: [
      ({ planLine, dayLabel, first }) => `😢 *So sorry ${first}!* ${planLine} on ${dayLabel} went full before I could grab it. Check the waitlist?`,
      ({ planLine, dayLabel }) => `🥲 *Missed it!* ${planLine} on ${dayLabel} filled up too fast. There's always tomorrow 💛`,
      ({ planLine, dayLabel }) => `❌ ${planLine} on ${dayLabel} sold out 😢 — try the Mindbody app for the waitlist!`,
    ],
    gymbro: [
      ({ planLine, dayLabel }) => `💀 *BRUTAL.* ${planLine} on ${dayLabel} went FULL before I could even rerack. Singapore is built different.`,
      ({ planLine, dayLabel }) => `❌ *Got out-bro'd.* ${planLine} on ${dayLabel} is FULL. Some gym goblin out-quickened me.`,
      ({ planLine, dayLabel }) => `🥲 *Outflexed.* ${planLine} on ${dayLabel} sold out faster than my reflexes. Try the waitlist?`,
      ({ planLine, dayLabel, first }) => `❌ *Cooked, ${first}.* ${planLine} on ${dayLabel} FULL. Manual recon required.`,
    ],
  },
  // Ambiguous — BUY didn't settle cleanly AND verify isn't BOOKED.
  unverified: {
    chaotic: [
      ({ planLine, dayLabel, detail }) => `⚠️ *Ambiguous.* ${planLine} on ${dayLabel} — BUY didn't settle clean and the schedule's not confirming. Check Mindbody manually. (${detail})`,
    ],
    wholesome: [
      ({ planLine, dayLabel }) => `⚠️ Hmm, not 100% sure if ${planLine} on ${dayLabel} went through. Can you check Mindbody?`,
    ],
    gymbro: [
      ({ planLine, dayLabel, detail }) => `⚠️ *Sketchy rep.* ${planLine} on ${dayLabel} — BUY didn't settle clean and the schedule's not confirming. Check Mindbody manually. (${detail})`,
    ],
  },
  // Definitive failure: BUY was clicked but row stayed BOOK_NOW.
  notBooked: {
    chaotic: [
      ({ planLine, dayLabel, detail }) => `❌ *Not booked.* ${planLine} on ${dayLabel} — BUY went out, row stayed BOOK NOW. Manual retry recommended. (${detail})`,
    ],
    wholesome: [
      ({ planLine, dayLabel }) => `❌ Booking didn't go through for ${planLine} on ${dayLabel}. Can you try manually?`,
    ],
    gymbro: [
      ({ planLine, dayLabel, detail }) => `❌ *No-rep.* ${planLine} on ${dayLabel} — BUY went out, row stayed BOOK NOW. Manual retry. (${detail})`,
    ],
  },
  // Caught an exception — usually auth or selector drift.
  exception: {
    chaotic: [
      ({ detail, first }) => `💥 *Lawrence had a moment.* ${detail}. Yash will look into it, ${first}.`,
      ({ detail }) => `💥 *Womp womp.* Something broke: ${detail}. Manual override required.`,
    ],
    wholesome: [
      ({ detail }) => `⚠️ Uh oh, something went wrong: ${detail}. Yash is on it!`,
    ],
    gymbro: [
      ({ detail, first }) => `💥 *Lawrence pulled a muscle.* ${detail}. Yash on it, ${first}.`,
      ({ detail }) => `💥 *Form check failed.* ${detail}. Manual override required.`,
    ],
  },
};

// Map status.reason → personality bucket. Defensive defaults so an unknown
// reason still produces a message instead of crashing.
function _bucket(status) {
  const r = String(status.reason || '').toLowerCase();
  if (!status.ok) {
    if (r === 'opt_out_day') return 'optOut';
    if (/exception/.test(r)) return 'exception';
    if (/unverified/.test(r)) return 'unverified';
    if (/full|not booked/.test(r)) return 'full';
    return 'exception';
  }
  if (r === 'opt_out_day') return 'optOut';
  if (r === 'paused') return 'paused';
  if (r === 'date_skip') return 'dateSkip';
  if (r === 'dry_run') return 'dryRun';
  if (r === 'already_booked') return 'alreadyBooked';
  if (status.via === 'api' && status.timing && status.timing.total) return 'bookedFast';
  if (/api-direct/.test(r) && status.timing && status.timing.total) return 'bookedFast';
  return 'bookedSlow';
}

function outcome(user, status, ctx) {
  const bucket = _bucket(status);
  const vibe = vibeFor(user);
  const pool = (OUTCOME[bucket] && OUTCOME[bucket][vibe]) || OUTCOME.bookedSlow.chaotic;
  const tmpl = pick(pool);
  const ms = status.timing && status.timing.total ? Math.round(status.timing.total) : null;
  const hero = tmpl({
    planLine: safe(ctx.planLine),
    dayLabel: safe(ctx.dayLabel),
    detail: safe(status.detail || '').slice(0, 200),
    ms,
    first: firstName(user),
  });
  // Footnote: relogin marker (subtle) + run id (for debugging). Both small.
  const tail = [];
  if (ctx.didRelogin) tail.push(`_(auth refreshed mid-flow)_`);
  if (ctx.runId) tail.push(`run: \`${safe(ctx.runId)}\``);
  return tail.length ? `${hero}\n${tail.join('  ')}` : hero;
}

module.exports = {
  vibeFor,
  firstName,
  safe,
  started,
  loggedIn,
  standby,
  outcome,
  _setRng,
  _resetRng,
  _bucket,
  STARTED,
  LOGGED_IN,
  STANDBY_UI,
  STANDBY_API,
  OUTCOME,
};
