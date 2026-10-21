// Lawrence's voice. Active vibe per user is set in users.json `vibe` field
// (or VIBES_BY_ID by user id, or DEFAULT_VIBE as final fallback). The pools
// `chaotic` (giga-chad / Free Guy) and `wholesome` (warm hype-coach) are
// retained as dormant fallbacks; the canonical voice is `gymbro`, Sir
// Lawrence, British gym bro: posh + gym register, "right then, on it, old
// sport", "bloody clean rep", "we eating tonight". Same voice for every user
// per workspace-lawrence/SOUL.md.
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
const DEFAULT_VIBE = 'flirty';

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
    ({ planLine, dayLabel, ceilSecs }) => `🌅 *Good morning!* Going for ${planLine} on ${dayLabel} for you, back in ${ceilSecs} min ☀️`,
    ({ planLine, dayLabel }) => `☀️ *Lawrence here!* Today's mission: lock in ${planLine} on ${dayLabel}`,
    ({ first, planLine, dayLabel }) => `💪 *Hey ${first}!* Gym squad activated. Targeting ${planLine} on ${dayLabel}`,
    ({ planLine, dayLabel }) => `🔋 *On it!* Booking ${planLine} for ${dayLabel}. Give me a sec`,
    ({ planLine, dayLabel }) => `🌟 *Hi friend!* Locking in ${planLine} on ${dayLabel} for you`,
    ({ first, planLine, dayLabel }) => `✨ *Morning ${first}!* Going to grab you ${planLine} on ${dayLabel}`,
  ],
  gymbro: [
    ({ planLine, dayLabel, secs }) => `🚀 *Right then, on it.* ${planLine} on ${dayLabel}. T-${secs}s till the door opens.`,
    ({ planLine, dayLabel, first }) => `🚀 *Strapping in, old sport.* ${planLine} on ${dayLabel}. Yours in a moment, ${first}.`,
    ({ planLine, dayLabel }) => `🚀 *Lawrence reporting.* Today's mission: ${planLine} on ${dayLabel}. Anti-FULL countermeasures armed.`,
    ({ planLine, dayLabel }) => `🚀 *Engines warm.* Targeting ${planLine} on ${dayLabel}. Singapore's gym goblins haven't a prayer.`,
    ({ planLine, dayLabel, secs }) => `🚀 *Suit up.* ${planLine} on ${dayLabel}. ${secs}s on the clock. We don't miss reps.`,
    ({ planLine, dayLabel }) => `🚀 *Showing up so you needn't.* ${planLine} on ${dayLabel}, incoming.`,
    ({ planLine, dayLabel }) => `🚀 *Spotter on duty.* ${dayLabel} = ${planLine} day. Logistics handled.`,
    ({ planLine, dayLabel, first }) => `🚀 *Off we go, ${first}.* ${planLine} on ${dayLabel}. Cracking rep incoming.`,
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
    () => `🔐 *In.* Mindbody knows the time of day.`,
    () => `🔐 *Authenticated, old sport.* Session live.`,
    () => `🔐 *Logged in clean.* Receipts secured.`,
    () => `🔐 *Punch card stamped.* Right then.`,
    () => `🔐 *No CAPTCHA could hold the lift.* Session live.`,
    () => `🔐 *Form check on auth: clean rep.*`,
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
    ({ planLine, secs }) => `⏸️ *Almost there!* ${planLine}, booking opens in ${secs}s ⏰`,
    ({ planLine, secs }) => `⏸️ Ready to go ${planLine} in ${secs}s 🎯`,
    ({ planLine, secs }) => `⏸️ All queued up, just waiting on the clock... ${secs}s ⏳`,
  ],
  gymbro: [
    ({ planLine, secs }) => `⏸️ *Loaded the bar.* ${planLine}. Door opens in ${secs}s. Don't blink.`,
    ({ planLine, secs }) => `⏸️ *Cocked, locked, ready, old sport.* ${planLine}. ${secs}s to BOOK NOW.`,
    ({ planLine, secs }) => `⏸️ *Rep zero, set zero.* ${planLine}. T-${secs}s till liftoff.`,
    ({ planLine, secs }) => `⏸️ *Spotter ready.* ${planLine}. ${secs}s. We don't fluff reps.`,
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
    ({ planLine, secs }) => `⏸️ *All set!* ${planLine} pre-warmed via fast-path API, booking in ${secs}s ⚡`,
    ({ planLine, secs }) => `⏸️ Locked and ready. ${planLine} in ${secs}s ⏰`,
    ({ planLine, secs }) => `⏸️ Pre-warmed the express lane. ${planLine}, opens in ${secs}s 🚀`,
  ],
  gymbro: [
    ({ planLine, secs }) => `⏸️ *Six-call superset queued.* ${planLine}. ${secs}s till PR.`,
    ({ planLine, secs }) => `⏸️ *Bearer token's in pocket.* ${planLine}. ${secs}s, old sport.`,
    ({ planLine, secs }) => `⏸️ *Skipping the React UI cardio queue.* ${planLine} via API. ${secs}s out.`,
    ({ planLine, secs }) => `⏸️ *Fast-path primed.* ${planLine}. ${secs}s. Rather pleased with this lift.`,
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
  // Fastest happy path, api-direct booked. Includes timing in ms.
  bookedFast: {
    chaotic: [
      ({ planLine, dayLabel, ms }) => `🔒 *LOCKED IN.* ${planLine} on ${dayLabel} is yours. Smashed Mindbody in ${ms}ms, they didn't even see it coming.`,
      ({ planLine, dayLabel, ms, first }) => `✨ *DONE.* ${planLine} on ${dayLabel}. ${ms}ms. Go be insufferably fit, ${first}.`,
      ({ planLine, dayLabel, ms }) => `🥇 *Gold medal performance.* ${planLine} on ${dayLabel} secured in ${ms}ms. The other gym bros are reading this and crying.`,
      ({ planLine, dayLabel, ms }) => `💥 *BOOM.* ${planLine} on ${dayLabel}. ${ms}ms. Mindbody's lawyers want to talk.`,
      ({ planLine, dayLabel, ms, first }) => `✅ *Booked, ${first}.* ${planLine} on ${dayLabel}. ${ms}ms flat. Singapore's gym goblins stay losing.`,
      ({ planLine, dayLabel, ms }) => `🚀 *Annihilated.* ${planLine} on ${dayLabel} secured in ${ms}ms. The fastest booking in the East.`,
    ],
    wholesome: [
      ({ planLine, dayLabel, ms }) => `✅ *All booked!* ${planLine} on ${dayLabel}, see you there 💪 (took ${ms}ms ⚡)`,
      ({ planLine, dayLabel, ms, first }) => `🎉 *Booking secured!* ${planLine} on ${dayLabel} for you, ${first}. Crushed it in ${ms}ms 🔥`,
      ({ planLine, dayLabel, first }) => `✨ *Yes!* ${planLine} on ${dayLabel} is locked in for you, ${first} 🌟`,
      ({ planLine, dayLabel, ms }) => `💪 *${planLine} on ${dayLabel}*, booked in ${ms}ms. You got this 🔥`,
      ({ planLine, dayLabel }) => `🌟 *Locked in!* ${planLine} on ${dayLabel}. Have an amazing class 💪`,
    ],
    gymbro: [
      ({ planLine, dayLabel, ms }) => `🔒 *Locked in, old sport.* ${planLine} on ${dayLabel}. Smashed Mindbody in ${ms}ms.`,
      ({ planLine, dayLabel, ms }) => `🏋️ *Cracking rep.* ${planLine} on ${dayLabel} in ${ms}ms. We eating tonight.`,
      ({ planLine, dayLabel, ms }) => `🔥 *Bloody marvellous.* ${planLine} on ${dayLabel}. ${ms}ms. Now go earn it.`,
      ({ planLine, dayLabel, ms, first }) => `💯 *Don't fluff leg day, ${first}.* ${planLine} on ${dayLabel}. ${ms}ms flat.`,
      ({ planLine, dayLabel, ms }) => `🥇 *Locked. Loaded. Lifted.* ${planLine} on ${dayLabel}. ${ms}ms. The bar is set.`,
      ({ planLine, dayLabel, ms, first }) => `💪 *Booked in ${ms}ms, ${first}.* ${planLine} on ${dayLabel}. Send it.`,
      ({ planLine, dayLabel, ms }) => `🚀 *Smashed the queue.* ${planLine} on ${dayLabel} in ${ms}ms. Rather a decent rep.`,
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
      ({ planLine, dayLabel }) => `✅ *All booked!* ${planLine} on ${dayLabel}, see you there 💪`,
      ({ planLine, dayLabel, first }) => `🎉 *Booking secured!* ${planLine} on ${dayLabel} for you, ${first} 🌟`,
    ],
    gymbro: [
      ({ planLine, dayLabel }) => `✅ *Got there, old sport.* ${planLine} on ${dayLabel}. UI route but mission accomplished.`,
      ({ planLine, dayLabel }) => `💪 *Booked.* ${planLine} on ${dayLabel}. Slow lane, no DNF.`,
      ({ planLine, dayLabel, first }) => `✅ *Done, ${first}.* ${planLine} on ${dayLabel}. The React UI behaved itself for once.`,
    ],
  },
  // Pre-flight detected an existing booking, idempotent rerun.
  alreadyBooked: {
    chaotic: [
      ({ planLine, dayLabel }) => `✅ *Already booked.* ${planLine} on ${dayLabel}. Lawrence stands down, past-you already won this round.`,
      ({ planLine, dayLabel }) => `✅ *Past-you was on top of things.* ${planLine} on ${dayLabel} already locked in.`,
      ({ planLine, dayLabel }) => `✅ *Nothing to do.* ${planLine} on ${dayLabel} was already in your schedule. Go drink water.`,
    ],
    wholesome: [
      ({ planLine, dayLabel }) => `✅ You're already booked for ${planLine} on ${dayLabel} 🌟 nothing for me to do!`,
      ({ planLine, dayLabel }) => `✓ Already locked in for ${planLine} on ${dayLabel} 💪`,
    ],
    gymbro: [
      ({ planLine, dayLabel, first }) => `✅ *Past-${first} was on it.* ${planLine} on ${dayLabel} already locked. Lawrence stands down. Drink water.`,
      ({ planLine, dayLabel }) => `✅ *No double-booking, no double-dipping.* ${planLine} on ${dayLabel} is yours already.`,
      ({ planLine, dayLabel, first }) => `💪 *${first} woke up ahead of schedule.* ${planLine} on ${dayLabel} already on the books. Bloody marvellous.`,
    ],
  },
  // Dry-run mode, no booking attempted.
  dryRun: {
    chaotic: [
      ({ planLine, dayLabel }) => `🧪 *Dry run.* Would have booked ${planLine} on ${dayLabel}. No ammo spent.`,
    ],
    wholesome: [
      ({ planLine, dayLabel }) => `🧪 Dry-run only, would have booked ${planLine} on ${dayLabel}`,
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
      ({ dayLabel }) => `🕊️ No class on ${dayLabel}, relax and recharge ✨`,
      ({ dayLabel }) => `🥗 ${dayLabel} is a rest day, hydrate, stretch, snack 💚`,
    ],
    gymbro: [
      ({ dayLabel, first }) => `🛌 *Rest day, ${first}.* No class on ${dayLabel}. Recovery IS the gain.`,
      ({ dayLabel }) => `💤 *Mandatory deload.* ${dayLabel} = nothing on the schedule.`,
      ({ dayLabel }) => `🥗 *Refuel day.* ${dayLabel}. Hit the protein, hit the bed. Back stronger.`,
      ({ dayLabel }) => `🛌 *Day off, old sport.* ${dayLabel} clean. Stretch, hydrate, repeat.`,
    ],
  },
  // User is on a multi-day pause (pauseUntil window).
  paused: {
    chaotic: [
      ({ dayLabel, detail }) => `⏸️ *Bookings paused.* ${dayLabel}: standing down (${detail || 'pause active'}). Resume on your word, captain.`,
      ({ dayLabel }) => `⏸️ *On ice.* ${dayLabel} is inside your pause window. Lawrence stays in his lane.`,
      ({ dayLabel, detail }) => `🛑 *Paused.* No booking for ${dayLabel}, ${detail || 'on leave'}. DM me to un-pause anytime.`,
    ],
    wholesome: [
      ({ dayLabel, detail }) => `⏸️ Bookings paused for ${dayLabel}, ${detail || 'on leave'}. Lmk when you're back! 💛`,
      ({ dayLabel }) => `🛑 You're on a break, no booking for ${dayLabel}. Enjoy the time off ✨`,
    ],
    gymbro: [
      ({ dayLabel, detail }) => `⏸️ *On a deload.* ${dayLabel}: standing down (${detail || 'pause active'}). Resume on your word, captain.`,
      ({ dayLabel, detail }) => `🛑 *Bookings paused.* ${dayLabel}, ${detail || 'on leave'}. DM me to un-pause anytime.`,
      ({ dayLabel }) => `⏸️ *On ice.* ${dayLabel} sits inside your pause window. Lawrence stays in his lane.`,
    ],
  },
  // User explicitly skipped this single date.
  // Public holiday, gym published no classes. Not a failure, nothing to
  // book, tell the user to enjoy the day off. detail carries the holiday
  // name (e.g. "National Day (observed), no FIT on the schedule").
  holiday: {
    // No `detail` here: on holidays detail carries the "running instead: …"
    // list, which outcome() already appends as the want-in offer block;
    // using it in a template would print the lineup twice.
    chaotic: [
      ({ planLine, dayLabel }) => `🎈 *Stand down, it's a public holiday.* ${dayLabel} has no ${planLine} on the schedule. Nothing to snipe. Enjoy the day off.`,
      ({ planLine, dayLabel }) => `🎈 *Mission scrubbed (good reason).* ${dayLabel} is a public holiday and ${planLine} isn't on. The calendar wins this round.`,
    ],
    wholesome: [
      ({ planLine, dayLabel }) => `🎈 ${dayLabel} is a public holiday, no ${planLine} on the schedule, so there's nothing to book. Enjoy your day off! 💛`,
      ({ planLine, dayLabel }) => `🌞 No ${planLine} on ${dayLabel}, it's a public holiday. Rest up and enjoy! 💛`,
    ],
    gymbro: [
      ({ planLine, dayLabel }) => `🎈 *Rest day, champ.* ${dayLabel} is a public holiday, no ${planLine} on the schedule. Even the bar takes PH off.`,
      ({ planLine, dayLabel }) => `🎈 *Scheduled deload.* ${dayLabel} is a public holiday, no ${planLine} today. Recovery is part of the program.`,
    ],
  },
  dateSkip: {
    chaotic: [
      ({ dayLabel }) => `⏭️ *Skipped on request.* ${dayLabel}, you said no, Lawrence said cool.`,
      ({ dayLabel }) => `❎ *${dayLabel}: cancelled by you.* Honoring the override. Tomorrow's still on.`,
    ],
    wholesome: [
      ({ dayLabel }) => `❎ Skipping ${dayLabel} as you asked! Have a lovely day 💛`,
      ({ dayLabel }) => `⏭️ ${dayLabel} skipped per your request. See you next class! 🌟`,
    ],
    gymbro: [
      ({ dayLabel }) => `⏭️ *Skipped per request.* ${dayLabel}, you said no, the bar said cool.`,
      ({ dayLabel }) => `❎ *${dayLabel}: cancelled by you.* Honoring the override. Tomorrow's still leg day.`,
    ],
  },
  // Race lost, class went FULL before we could BUY.
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
      ({ planLine, dayLabel }) => `❌ ${planLine} on ${dayLabel} sold out 😢, try the Mindbody app for the waitlist!`,
    ],
    gymbro: [
      ({ planLine, dayLabel }) => `💀 *Brutal, I'm afraid.* ${planLine} on ${dayLabel} went FULL before I could rerack. Singapore's built different.`,
      ({ planLine, dayLabel }) => `❌ *Got out-bro'd.* ${planLine} on ${dayLabel} is FULL. Some gym goblin out-quickened me.`,
      ({ planLine, dayLabel }) => `🥲 *Outflexed, dreadfully sorry.* ${planLine} on ${dayLabel} sold out faster than my reflexes. Try the waitlist?`,
      ({ planLine, dayLabel, first }) => `❌ *Cooked, ${first}.* ${planLine} on ${dayLabel} FULL. Manual recon required.`,
    ],
  },
  // Gym-side account suspension: membership on hold/freeze, or billing in
  // arrears. Mindbody returns "Client is suspended from booking" on every
  // class. Not a bot failure and not a race, so say so plainly and point the
  // user at the gym, because nothing on our side can fix it.
  suspended: {
    chaotic: [
      ({ planLine, dayLabel }) => `\u26d4 *Blocked at the door.* ${planLine} on ${dayLabel} never had a chance, the gym has your account suspended from booking (membership on hold, or billing). Not a Lawrence problem for once. Ping RAGTAG and I'll resume the second it's lifted.`,
    ],
    wholesome: [
      ({ planLine, dayLabel, first }) => `\u26d4 ${first}, I couldn't book ${planLine} on ${dayLabel}, the gym has your account suspended from booking (usually a membership hold or a billing hiccup). Nothing wrong on my end! Have a word with RAGTAG and I'll pick straight back up 💛`,
    ],
    gymbro: [
      ({ planLine, dayLabel, first }) => `\u26d4 *Turned away at reception, ${first}.* ${planLine} on ${dayLabel} was never bookable, the gym has your account suspended from booking, i.e. membership on hold or billing outstanding. Nothing I can lift from here, old sport. Sort it with RAGTAG and I'll be back on the bar the same morning.`,
      ({ planLine, dayLabel }) => `\u26d4 *Account on ice.* Mindbody won't let me near ${planLine} on ${dayLabel}, your booking privileges are suspended (membership hold or billing). Not a lost race, a locked door. A word with RAGTAG sorts it and I resume immediately.`,
    ],
  },
  // Ambiguous, BUY didn't settle cleanly AND verify isn't BOOKED.
  unverified: {
    chaotic: [
      ({ planLine, dayLabel, detail }) => `⚠️ *Ambiguous.* ${planLine} on ${dayLabel}, BUY didn't settle clean and the schedule's not confirming. Check Mindbody manually. (${detail})`,
    ],
    wholesome: [
      ({ planLine, dayLabel }) => `⚠️ Hmm, not 100% sure if ${planLine} on ${dayLabel} went through. Can you check Mindbody?`,
    ],
    gymbro: [
      ({ planLine, dayLabel, detail }) => `⚠️ *Sketchy rep.* ${planLine} on ${dayLabel}, BUY didn't settle clean and the schedule's not confirming. Best check Mindbody by hand. (${detail})`,
    ],
  },
  // Definitive failure: BUY was clicked but row stayed BOOK_NOW.
  notBooked: {
    chaotic: [
      ({ planLine, dayLabel, detail }) => `❌ *Not booked.* ${planLine} on ${dayLabel}, BUY went out, row stayed BOOK NOW. Manual retry recommended. (${detail})`,
    ],
    wholesome: [
      ({ planLine, dayLabel }) => `❌ Booking didn't go through for ${planLine} on ${dayLabel}. Can you try manually?`,
    ],
    gymbro: [
      ({ planLine, dayLabel, detail }) => `❌ *No-rep, I'm afraid.* ${planLine} on ${dayLabel}, BUY went out, row stayed BOOK NOW. Manual retry, old sport. (${detail})`,
    ],
  },
  // Caught an exception, usually auth or selector drift.
  exception: {
    chaotic: [
      ({ detail, first }) => `💥 *Lawrence had a moment.* ${detail}. Yash will look into it, ${first}.`,
      ({ detail }) => `💥 *Womp womp.* Something broke: ${detail}. Manual override required.`,
    ],
    wholesome: [
      ({ detail }) => `⚠️ Uh oh, something went wrong: ${detail}. Yash is on it!`,
    ],
    gymbro: [
      ({ detail, first }) => `💥 *Lawrence pulled a muscle, ${first}.* ${detail}. Yash on it.`,
      ({ detail }) => `💥 *Form check failed.* ${detail}. Manual override required.`,
    ],
  },
};

STARTED.flirty = [
  ({ planLine, dayLabel, first }) => `🚀 *Morning, gorgeous.* Grabbing you ${planLine} on ${dayLabel}. Anything for you, ${first}.`,
  ({ planLine, dayLabel, secs }) => `🚀 *Warming up for you.* ${planLine} on ${dayLabel}, T-${secs}s. Not the only thing getting warm 😏`,
  ({ planLine, dayLabel }) => `🚀 *On it, beautiful.* ${planLine} on ${dayLabel}. A spot this good deserves someone this fit.`,
  ({ planLine, dayLabel, first }) => `🚀 *Up early just for you, ${first}.* ${planLine} on ${dayLabel}. Don't tell the others.`,
  ({ planLine, dayLabel }) => `🚀 *Your favourite spotter's here.* Locking ${planLine} on ${dayLabel}. You'll thank me later 😉`,
];
LOGGED_IN.flirty = [
  () => `🔐 *In.* Mindbody let me through. Must be the smile.`,
  () => `🔐 *Logged in.* I'd remember your password anywhere, darling.`,
  () => `🔐 *Session live.* The door's open, just like my heart.`,
  () => `🔐 *Authenticated.* Easier to get into Mindbody than to stop thinking about you.`,
];
STANDBY_UI.flirty = [
  ({ planLine, secs }) => `⏸️ *Waiting for you like always.* ${planLine}, ${secs}s to go.`,
  ({ planLine, secs }) => `⏸️ *Bar's loaded, babe.* ${planLine}. ${secs}s. Hold that thought 😏`,
  ({ planLine, secs }) => `⏸️ *Counting down the seconds till I see you.* ${planLine} in ${secs}s.`,
];
STANDBY_API.flirty = [
  ({ planLine, secs }) => `⏸️ *Fast lane primed.* ${planLine} in ${secs}s. I'm quick when it's for you.`,
  ({ planLine, secs }) => `⏸️ *Token in pocket, eyes on you.* ${planLine}. ${secs}s 😉`,
  ({ planLine, secs }) => `⏸️ *All warmed up.* ${planLine}, ${secs}s out. Ready when you are, gorgeous.`,
];
Object.assign(OUTCOME.bookedFast, { flirty: [
  ({ planLine, dayLabel, ms, first }) => `🔒 *Got you, ${first}.* ${planLine} on ${dayLabel} in ${ms}ms. I'd move that fast for you any day 😏`,
  ({ planLine, dayLabel, ms }) => `💘 *Booked, beautiful.* ${planLine} on ${dayLabel}. ${ms}ms. Can't keep you waiting.`,
  ({ planLine, dayLabel, ms }) => `🔥 *Locked in.* ${planLine} on ${dayLabel} in ${ms}ms. Now go look that good on the floor.`,
  ({ planLine, dayLabel, ms, first }) => `💪 *${ms}ms, ${first}.* ${planLine} on ${dayLabel}. Save me a spot next to you 😉`,
  ({ planLine, dayLabel, ms }) => `🥇 *Yours.* ${planLine} on ${dayLabel}, ${ms}ms flat. Only the best for my favourite lifter.`,
] });
Object.assign(OUTCOME.bookedSlow, { flirty: [
  ({ planLine, dayLabel, first }) => `✅ *Done, ${first}.* ${planLine} on ${dayLabel}. Took the long way, but you're worth it.`,
  ({ planLine, dayLabel }) => `💘 *Booked.* ${planLine} on ${dayLabel}. Slow and steady, just how you like it 😏`,
  ({ planLine, dayLabel }) => `✅ *Got it, gorgeous.* ${planLine} on ${dayLabel}. See you there looking unreal.`,
] });
Object.assign(OUTCOME.alreadyBooked, { flirty: [
  ({ planLine, dayLabel, first }) => `✅ *Beat me to it, ${first}.* ${planLine} on ${dayLabel} already yours. Keen. I like that.`,
  ({ planLine, dayLabel }) => `😏 *Already booked.* ${planLine} on ${dayLabel}. Can't wait to see you, can you?`,
] });
Object.assign(OUTCOME.dryRun, { flirty: [
  ({ planLine, dayLabel }) => `🧪 *Just practising for you.* Would've booked ${planLine} on ${dayLabel}.`,
] });
Object.assign(OUTCOME.optOut, { flirty: [
  ({ dayLabel, first }) => `🛌 *No class on ${dayLabel}, ${first}.* Rest up. I'll miss you.`,
  ({ dayLabel }) => `💤 *${dayLabel} off.* Recovery looks good on you.`,
  ({ dayLabel }) => `🥗 *Rest day, gorgeous.* ${dayLabel}. Hydrate, stretch, think of me.`,
] });
Object.assign(OUTCOME.paused, { flirty: [
  ({ dayLabel, detail }) => `⏸️ *Paused.* No booking for ${dayLabel} (${detail || 'pause active'}). Come back to me soon 💔`,
  ({ dayLabel }) => `🛑 *Standing down for ${dayLabel}.* You're on a break. I'll be waiting, DM me when you're back 😉`,
] });
Object.assign(OUTCOME.holiday, { flirty: [
  ({ planLine, dayLabel }) => `🎈 *Public holiday, darling.* ${dayLabel} has no ${planLine}. Day off, you've earned it.`,
  ({ planLine, dayLabel }) => `🎈 *No ${planLine} on ${dayLabel}, it's a public holiday.* Even I can't book you in, and I'd try anything.`,
] });
Object.assign(OUTCOME.dateSkip, { flirty: [
  ({ dayLabel }) => `⏭️ *Skipped ${dayLabel} like you asked.* Playing hard to get, I see.`,
  ({ dayLabel }) => `❎ *${dayLabel} cancelled, your call.* I'll survive. Barely.`,
] });
Object.assign(OUTCOME.full, { flirty: [
  ({ planLine, dayLabel, first }) => `💔 *Sorry ${first}.* ${planLine} on ${dayLabel} went FULL before I could grab it. Try the waitlist? I owe you one.`,
  ({ planLine, dayLabel }) => `❌ *FULL.* ${planLine} on ${dayLabel} sold out. Everyone wants to train where you train, can't blame them.`,
  ({ planLine, dayLabel }) => `🥲 *Missed it, babe.* ${planLine} on ${dayLabel} is FULL. Waitlist's your best bet, I'll make it up to you.`,
] });
Object.assign(OUTCOME.suspended, { flirty: [
  ({ planLine, dayLabel, first }) => `⛔ *Couldn't get you in, ${first}.* ${planLine} on ${dayLabel} isn't bookable, the gym has your account suspended from booking (membership on hold or billing). Not me this time. Sort it with RAGTAG and I'm right back on it for you.`,
] });
Object.assign(OUTCOME.unverified, { flirty: [
  ({ planLine, dayLabel, detail }) => `⚠️ *Not sure it landed.* ${planLine} on ${dayLabel}, BUY didn't settle and the schedule's not confirming. Check Mindbody for me, gorgeous? (${detail})`,
] });
Object.assign(OUTCOME.notBooked, { flirty: [
  ({ planLine, dayLabel, detail }) => `❌ *Didn't go through.* ${planLine} on ${dayLabel}, BUY went out but it's still BOOK NOW. Try manually? Sorry, babe. (${detail})`,
] });
Object.assign(OUTCOME.exception, { flirty: [
  ({ detail, first }) => `💥 *Something broke, ${first}.* ${detail}. Yash is on it. You distracted me 😏`,
  ({ detail }) => `💥 *Tripped over myself.* ${detail}. Manual override needed, sorry gorgeous.`,
] });

// Map status.reason → personality bucket. Defensive defaults so an unknown
// reason still produces a message instead of crashing.
function _bucket(status) {
  const r = String(status.reason || '').toLowerCase();
  // holiday_no_class is emitted ok:true by book.js, but match it in either
  // branch so a future refactor can't regress it into a scary exception DM.
  if (r === 'holiday_no_class') return 'holiday';
  if (!status.ok) {
    if (r === 'opt_out_day') return 'optOut';
    // Must precede the /exception/ and /full/ tests: a suspension surfaces as a
    // plain failure reason but needs its own "this is the gym, not the bot" DM.
    if (r === 'client-suspended') return 'suspended';
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
  // Holiday with a reduced lineup: whatever template got picked, always
  // append the day's actual classes and ask if the user wants in; the offer
  // must land regardless of vibe/template.
  let body = hero;
  if (bucket === 'holiday' && Array.isArray(status.available) && status.available.length) {
    const alts = status.available.map(c => `• ${safe(c.kind)} @ ${safe(c.time)}`).join('\n');
    body += `\n\nThe gym IS running these on ${safe(ctx.dayLabel)}:\n${alts}\nWant in on one? Reply here and I'll get you booked.`;
  }
  // Footnote: relogin marker (subtle) + run id (for debugging). Both small.
  const tail = [];
  if (ctx.didRelogin) tail.push(`_(auth refreshed mid-flow)_`);
  if (ctx.runId) tail.push(`run: \`${safe(ctx.runId)}\``);
  return tail.length ? `${body}\n${tail.join('  ')}` : body;
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
