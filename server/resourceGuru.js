// server/resourceGuru.js
// Resource Guru API client — conservative rate limiting for large fetches
// RG limit: 200 requests/minute. We stay well under by serialising all calls.

const fetch = require('node-fetch');

const BASE      = 'https://api.resourceguruapp.com/v1';
const TOKEN_URL = 'https://api.resourceguruapp.com/oauth/token';

let _accessToken    = null;
let _tokenExpiresAt = 0;

// ── Auth ──────────────────────────────────────────────────────────────────────
async function authenticate(attempt = 1) {
  console.log(`[RG] Authenticating... (attempt ${attempt})`);
  console.log(`[RG] Credentials check — account: ${process.env.RG_ACCOUNT}, username: ${process.env.RG_USERNAME}, client_id set: ${!!process.env.RG_CLIENT_ID}, client_secret set: ${!!process.env.RG_CLIENT_SECRET}, password set: ${!!process.env.RG_PASSWORD}`);

  // Use a 30s timeout — Render free tier can be slow on outbound connections
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  controller.signal,
      body: JSON.stringify({
        grant_type:    'password',
        username:      process.env.RG_USERNAME,
        password:      process.env.RG_PASSWORD,
        client_id:     process.env.RG_CLIENT_ID,
        client_secret: process.env.RG_CLIENT_SECRET,
      }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`RG auth failed ${res.status}: ${body}`);
    }
    const data = await res.json();
    _accessToken    = data.access_token;
    _tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    console.log('[RG] Authenticated successfully.');
  } catch (err) {
    clearTimeout(timer);
    // Retry up to 3 times with increasing delays
    if (attempt < 4) {
      const delay = attempt * 3000;
      console.warn(`[RG] Auth attempt ${attempt} failed: ${err.message} — retrying in ${delay/1000}s`);
      await sleep(delay);
      return authenticate(attempt + 1);
    }
    throw new Error(`RG authentication failed after ${attempt} attempts: ${err.message}`);
  }
}

async function ensureToken() {
  if (!_accessToken || Date.now() >= _tokenExpiresAt) await authenticate();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Rate-limited GET ──────────────────────────────────────────────────────────
// Every call goes through here. Handles 429 with Retry-After header.
async function rgGet(path, params = {}) {
  await ensureToken();
  const url = new URL(`${BASE}/${process.env.RG_ACCOUNT}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  while (true) {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${_accessToken}` },
    });
    if (res.status === 429) {
      const retry = parseInt(res.headers.get('Retry-After') || '10', 10);
      console.warn(`[RG] Rate limited on ${path} — waiting ${retry}s`);
      await sleep(retry * 1000 + 500); // extra 500ms buffer
      continue;
    }
    if (!res.ok) throw new Error(`RG ${res.status} on ${path}: ${await res.text()}`);
    return res.json();
  }
}

// ── Resource types (for dept option ID → name lookup) ────────────────────────
async function fetchResourceTypes() {
  return rgGet('/resource_types');
}

// ── Bookings: fetch one month at a time, fully serial, conservative pacing ───
// For 3 years of data we fetch month by month with a 400ms gap between each.
// 36 months × ~2 pages each = ~72 API calls = well under 200/min limit.
// Each monthly chunk is fully serial (no parallel) to guarantee rate safety.
async function fetchBookingsSerial(from, to, onProgress) {
  // Build list of monthly chunks
  const chunks = [];
  let cur = new Date(from);
  const end = new Date(to);
  while (cur <= end) {
    const chunkFrom = cur.toISOString().slice(0, 10);
    const monthEnd  = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    const chunkTo   = monthEnd < end ? monthEnd.toISOString().slice(0, 10) : to;
    chunks.push({ from: chunkFrom, to: chunkTo });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }

  console.log(`[RG] Fetching ${chunks.length} monthly chunks serially...`);
  const all = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let page = 1;
    while (true) {
      const data = await rgGet('/bookings', {
        start_date: chunk.from,
        end_date:   chunk.to,
        per_page:   300,
        page,
      });
      if (!Array.isArray(data) || data.length === 0) break;
      all.push(...data);
      if (data.length < 300) break;
      page++;
      await sleep(400); // 400ms between pages within a month
    }
    await sleep(400); // 400ms between months
    if (onProgress) onProgress(i + 1, chunks.length);
  }

  console.log(`[RG] Fetched ${all.length} bookings total`);
  return all;
}

module.exports = { fetchResourceTypes, fetchBookingsSerial, sleep, BASE };