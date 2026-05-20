// Mindbody marketplace API client. Bypasses the React UI entirely so we can
// fire the booking pipeline at T+0 instead of T+12s (DOM refresh penalty).
//
// Auth: the Bearer token lives in browser memory (axios interceptor sets it),
// not in localStorage/cookies — so we open a Playwright context with saved
// auth.json, navigate to a page that triggers any Mindbody API call, and
// capture the Authorization header off the first matching request. Tokens
// are JWTs valid ~12h, plenty for one booking attempt.
//
// The captured Bearer is then re-used in raw Node fetch() calls. This lets
// us run the entire booking pipeline outside the browser at full network speed.
const fs = require('fs');
const path = require('path');

const MB_HOST = 'https://prod-mkt-gateway.mindbody.io';
const MB_HEADERS_BASE = {
  'content-type': 'application/vnd.api+json',
  'x-mb-app-name': 'mindbody.io',
  'x-mb-app-version': 'cce33732',
  'x-mb-app-build': '2026-04-23T12:33:29.293Z',
  'x-mb-user-session-id': 'mb-1',
};

// Static identifiers for Yash @ Ragtag, captured from recon-api/2026-04-27T07-41-35.
const RAGTAG = {
  mb_site_id: 5744526,
  mb_location_id: 1,
  mb_master_location_id: 4952007,
  inventory_source: 'MB',
};
const LOCATION_REF = JSON.stringify(RAGTAG);

// Open a Playwright context, navigate to a page that triggers an API call,
// and resolve as soon as we see an Authorization: Bearer header. Caller
// passes the launched browser/context/page so we don't double-launch.
async function captureBearerToken(page, { timeoutMs = 20000 } = {}) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bearer capture timeout after ${timeoutMs}ms`)), timeoutMs);
    const onReq = req => {
      const auth = req.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ') && req.url().includes('mindbody.io')) {
        clearTimeout(timer);
        page.off('request', onReq);
        resolve(auth);
      }
    };
    page.on('request', onReq);
    // Always navigate (or reload) — even if already on ragtag, we need to
    // trigger a fresh API call to capture the Bearer header.
    try {
      const onRagtag = /locations\/ragtag/i.test(page.url());
      if (onRagtag) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      } else {
        await page.goto('https://www.mindbodyonline.com/explore/locations/ragtag', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      }
    } catch (e) { /* navigation may abort if a request fires first; that's fine */ }
  });
}

const { matchesScheduleEntry } = require('./lib');

// Mindbody's location/schedules returns ALL class times in a date range. We
// filter for the target class kind + start time. Used to discover mb_class_id
// (varies per occurrence) without scraping the React DOM.
async function fetchScheduleClasses(bearer, { fromIso, toIso }) {
  const url = `${MB_HOST}/v1/location/schedules`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...MB_HEADERS_BASE, authorization: bearer },
    body: JSON.stringify({
      location_ref_json: LOCATION_REF,
      start_time_from: fromIso,
      start_time_to: toIso,
      location_timezone: 'Asia/Singapore',
    }),
  });
  if (!r.ok) throw new Error(`fetchScheduleClasses ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  // Each entry has attributes.attributes.{startTime, course.name, inventoryRefJson, status.id}
  return (j.data || []).map(d => {
    const a = d.attributes && d.attributes.attributes;
    if (!a) return null;
    let inv = null;
    try { inv = JSON.parse(a.inventoryRefJson || '{}'); } catch {}
    return {
      id: d.id,
      startTime: a.startTime,
      endTime: a.endTime,
      courseName: (a.course && a.course.name) || null,
      bookable: a.status && a.status.id === 1,
      statusText: a.status && a.status.status,
      mb_class_id: inv && inv.mb_class_id,
      mb_class_schedule_id: inv && inv.mb_class_schedule_id,
      mb_class_description_id: inv && inv.mb_class_description_id,
      raw: a,
    };
  }).filter(Boolean);
}

// Find the class entry matching a desired (kind, startTimeSgt). Delegates the
// per-entry check to lib.matchesScheduleEntry so the matcher is unit-tested.
function findClass(classes, { kindNeedle, sgtDate, sgtHHMM }) {
  for (const c of classes) {
    if (matchesScheduleEntry(c, { kindNeedle, sgtDate, sgtHHMM })) return c;
  }
  return null;
}

// Fetch the user's eligible passes for paying for a specific class.
// We pick the first one with remainingCount > 0 (or undefined = unlimited).
async function fetchPaymentPassUuid(bearer, classMeta) {
  const r = await fetch(`${MB_HOST}/v1/location/payment_methods/class_time_passes`, {
    method: 'POST',
    headers: { ...MB_HEADERS_BASE, authorization: bearer },
    body: JSON.stringify({
      locationRefJson: LOCATION_REF,
      classTimeRefJson: JSON.stringify({
        mb_class_id: classMeta.mb_class_id,
        mb_class_schedule_id: classMeta.mb_class_schedule_id,
        mb_class_description_id: classMeta.mb_class_description_id,
        ...RAGTAG,
        inventory_category: 'class_time',
      }),
    }),
  });
  if (!r.ok) throw new Error(`fetchPaymentPassUuid ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const pass = (j.data || []).find(p => {
    const c = p.attributes && p.attributes.remainingCount;
    return c == null || c > 0;
  });
  if (!pass) throw new Error('no eligible pass found for this class');
  return pass.id;
}

// 6-step booking pipeline. After /booking_items and after /payments the order
// status reverts to "requires_compute" — Mindbody's /process refuses to commit
// until a /compute_total flips it back to "computed". So the actual minimum
// flow is: orders → booking_items → compute_total → payments → compute_total → process.
// First live test (2026-04-27): each leg ~250ms, total ~1.3s.
async function bookViaApi(bearer, { classMeta, paymentMethodUuid, recaptchaToken }) {
  const t0 = Date.now();
  const timing = {};
  const headers = { ...MB_HEADERS_BASE, authorization: bearer };
  const post = async (label, urlPath, body) => {
    const t = Date.now();
    const r = await fetch(`${MB_HOST}${urlPath}`, { method: 'POST', headers, body: JSON.stringify(body) });
    timing[label] = Date.now() - t;
    const txt = await r.text();
    let json = null; try { json = JSON.parse(txt); } catch {}
    return { ok: r.ok || r.status === 201 || r.status === 202, status: r.status, json, txt };
  };

  // 1. Create order.
  const r1 = await post('orders', '/v1/orders', { locationRefJson: LOCATION_REF });
  if (!r1.ok || !(r1.json && r1.json.data && r1.json.data.id)) {
    return { ok: false, step: 'orders', status: r1.status, body: r1.txt.slice(0, 400), timing };
  }
  const orderId = r1.json.data.id;

  // 2. Add booking item.
  const r2 = await post('booking_items', `/v1/orders/${orderId}/booking_items`, {
    inventoryItemRefJson: JSON.stringify({
      mb_class_id: classMeta.mb_class_id,
      mb_class_schedule_id: classMeta.mb_class_schedule_id,
      mb_class_description_id: classMeta.mb_class_description_id,
      ...RAGTAG,
      inventory_category: 'class_time',
    }),
  });
  if (!r2.ok) return { ok: false, step: 'booking_items', status: r2.status, body: r2.txt.slice(0, 400), orderId, timing };
  const bookingItemUuid = r2.json && r2.json.data && r2.json.data.relationships && r2.json.data.relationships.bookingItems && r2.json.data.relationships.bookingItems.data && r2.json.data.relationships.bookingItems.data[0] && r2.json.data.relationships.bookingItems.data[0].id;
  if (!bookingItemUuid) return { ok: false, step: 'booking_items', status: r2.status, body: 'no bookingItemUuid', orderId, timing };

  // 3. Compute total — flips order status to "computed".
  const r3 = await post('compute_total_1', `/v1/orders/${orderId}/compute_total`, {});
  if (!r3.ok) return { ok: false, step: 'compute_total_1', status: r3.status, body: r3.txt.slice(0, 400), orderId, timing };

  // 4. Attach payment.
  const r4 = await post('payments', `/v1/orders/${orderId}/payments`, { paymentMethodUuid, bookingItemUuid });
  if (!r4.ok) return { ok: false, step: 'payments', status: r4.status, body: r4.txt.slice(0, 400), orderId, timing };

  // 5. Compute total again — order may revert to requires_compute after payment is added.
  const r5 = await post('compute_total_2', `/v1/orders/${orderId}/compute_total`, {});
  if (!r5.ok) return { ok: false, step: 'compute_total_2', status: r5.status, body: r5.txt.slice(0, 400), orderId, timing };

  // 6. Process — actually commits the booking. Recaptcha: empty string works
  // for $0 pass-paid orders (verified 2026-04-27); only paid orders enforce it.
  const r6 = await post('process', `/v1/orders/${orderId}/process`, {
    challengeRedirectUrl: 'https://www.mindbodyonline.com/explore/checkout/sca/success',
    recaptcha_token: recaptchaToken || '',
  });
  timing.total = Date.now() - t0;
  if (!r6.ok) return { ok: false, step: 'process', status: r6.status, body: r6.txt.slice(0, 400), orderId, timing };

  const status = r6.json && r6.json.data && r6.json.data.attributes && r6.json.data.attributes.status;
  // status.code 10 = processing_requested (async commit)
  // status.code 11 / title "completed" = fully done
  return {
    ok: true, step: 'process', httpStatus: r6.status,
    statusCode: status && status.code,
    statusTitle: status && status.title,
    orderId, bookingItemUuid, timing,
  };
}

// Generate a fresh recaptcha v3 token via the live browser. Mindbody's
// frontend uses the same site key (visible in their bundled JS); we just
// invoke grecaptcha.execute with action=process_order. Costs ~200-400ms.
async function generateRecaptchaToken(page, { action = 'process_order', timeoutMs = 5000 } = {}) {
  return await page.evaluate(async ({ action, timeoutMs }) => {
    if (!window.grecaptcha) throw new Error('grecaptcha not loaded');
    // Site key is exposed in any rendered checkout page; sniff it from the page.
    const siteKeyMatch = document.documentElement.outerHTML.match(/sitekey[\"']?\s*:\s*[\"']([^\"']+)[\"']/i)
      || document.documentElement.outerHTML.match(/data-sitekey=[\"']([^\"']+)[\"']/i);
    if (!siteKeyMatch) throw new Error('site key not found in page');
    const sk = siteKeyMatch[1];
    return await Promise.race([
      window.grecaptcha.execute(sk, { action }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('recaptcha timeout')), timeoutMs)),
    ]);
  }, { action, timeoutMs });
}

// Join a waitlist for a class. Similar to bookViaApi but uses inventory_category
// 'class_time_waitlist' and completes in 2-3 steps instead of 6.
async function joinWaitlistViaApi(bearer, { classMeta }) {
  const t0 = Date.now();
  const timing = {};
  const headers = { ...MB_HEADERS_BASE, authorization: bearer };
  const post = async (label, urlPath, body) => {
    const t = Date.now();
    const r = await fetch(`${MB_HOST}${urlPath}`, { method: 'POST', headers, body: JSON.stringify(body) });
    timing[label] = Date.now() - t;
    const txt = await r.text();
    let json = null; try { json = JSON.parse(txt); } catch {}
    return { ok: r.ok || r.status === 201 || r.status === 202, status: r.status, json, txt };
  };

  // 1. Create order.
  const r1 = await post('orders', '/v1/orders', { locationRefJson: LOCATION_REF });
  if (!r1.ok || !(r1.json && r1.json.data && r1.json.data.id)) {
    return { ok: false, step: 'orders', status: r1.status, body: r1.txt.slice(0, 400), timing };
  }
  const orderId = r1.json.data.id;

  // 2. Add waitlist booking item (use inventory_category 'class_time_waitlist').
  const r2 = await post('booking_items', `/v1/orders/${orderId}/booking_items`, {
    inventoryItemRefJson: JSON.stringify({
      mb_class_id: classMeta.mb_class_id,
      mb_class_schedule_id: classMeta.mb_class_schedule_id,
      mb_class_description_id: classMeta.mb_class_description_id,
      ...RAGTAG,
      inventory_category: 'class_time_waitlist',
    }),
  });
  if (!r2.ok) return { ok: false, step: 'booking_items', status: r2.status, body: r2.txt.slice(0, 400), orderId, timing };
  const bookingItemUuid = r2.json && r2.json.data && r2.json.data.relationships && r2.json.data.relationships.bookingItems && r2.json.data.relationships.bookingItems.data && r2.json.data.relationships.bookingItems.data[0] && r2.json.data.relationships.bookingItems.data[0].id;
  if (!bookingItemUuid) return { ok: false, step: 'booking_items', status: r2.status, body: 'no bookingItemUuid', orderId, timing };

  // 3. Process — commit the waitlist join. No payment required.
  const r3 = await post('process', `/v1/orders/${orderId}/process`, {
    challengeRedirectUrl: 'https://www.mindbodyonline.com/explore/checkout/sca/success',
    recaptcha_token: '',
  });
  timing.total = Date.now() - t0;
  if (!r3.ok) return { ok: false, step: 'process', status: r3.status, body: r3.txt.slice(0, 400), orderId, timing };

  const status = r3.json && r3.json.data && r3.json.data.attributes && r3.json.data.attributes.status;
  return {
    ok: true, step: 'process', httpStatus: r3.status,
    statusCode: status && status.code,
    statusTitle: status && status.title,
    orderId, bookingItemUuid, timing,
  };
}

module.exports = {
  RAGTAG,
  LOCATION_REF,
  captureBearerToken,
  fetchScheduleClasses,
  findClass,
  fetchPaymentPassUuid,
  bookViaApi,
  joinWaitlistViaApi,
  generateRecaptchaToken,
};
