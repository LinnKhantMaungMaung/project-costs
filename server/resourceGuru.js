// server/resourceGuru.js
// Resource Guru API client — conservative rate limiting for large fetches
// RG limit: 200 requests/minute. We stay well under by serialising all calls.

const https = require('https'); // built-in — no node-fetch needed

const BASE      = 'https://api.resourceguruapp.com/v1';
const TOKEN_URL = 'https://api.resourceguruapp.com/oauth/token';

let _accessToken    = null;
let _tokenExpiresAt = 0;

// ── Auth using native https (avoids node-fetch premature close on auth) ───────
function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path:     u.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Accept':         'application/json',
      },
      timeout: 30000,
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch(e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Auth request timed out')); });
    req.write(payload);
    req.end();
  });
}

async function authenticate(attempt = 1) {
  console.log(`[RG] Authenticating... (attempt ${attempt})`);
  console.log(`[RG] account=${process.env.RG_ACCOUNT} username=${process.env.RG_USERNAME} client_id_set=${!!process.env.RG_CLIENT_ID} secret_set=${!!process.env.RG_CLIENT_SECRET} password_set=${!!process.env.RG_PASSWORD}`);
  try {
    const { status, body } = await httpsPost(TOKEN_URL, {
      grant_type:    'password',
      username:      process.env.RG_USERNAME,
      password:      process.env.RG_PASSWORD,
      client_id:     process.env.RG_CLIENT_ID,
      client_secret: process.env.RG_CLIENT_SECRET,
    });
    if (status !== 200) throw new Error(`RG auth HTTP ${status}: ${JSON.stringify(body)}`);
    if (!body.access_token) throw new Error(`No access_token in response: ${JSON.stringify(body)}`);
    _accessToken    = body.access_token;
    _tokenExpiresAt = Date.now() + (body.expires_in - 60) * 1000;
    console.log('[RG] Authenticated successfully.');
  } catch(err) {
    if (attempt < 4) {
      const delay = attempt * 4000;
      console.warn(`[RG] Auth attempt ${attempt} failed: ${err.message} — retrying in ${delay/1000}s`);
      await sleep(delay);
      return authenticate(attempt + 1);
    }
    throw new Error(`RG auth failed after ${attempt} attempts: ${err.message}`);
  }
}

async function ensureToken() {
  if (!_accessToken || Date.now() >= _tokenExpiresAt) await authenticate();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Native https GET (avoids node-fetch premature close) ─────────────────────
function httpsGet(urlStr, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const options = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
      },
      timeout: 30000,
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch(e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Request timed out: ${urlStr}`)); });
    req.end();
  });
}

// ── Rate-limited GET ──────────────────────────────────────────────────────────
async function rgGet(path, params = {}) {
  await ensureToken();
  const url = new URL(`${BASE}/${process.env.RG_ACCOUNT}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  while (true) {
    const { status, headers, body } = await httpsGet(url.toString(), _accessToken);
    if (status === 429) {
      const retry = parseInt(headers['retry-after'] || '10', 10);
      console.warn(`[RG] Rate limited on ${path} — waiting ${retry}s`);
      await sleep(retry * 1000 + 500);
      continue;
    }
    if (status === 401) {
      // Token expired — re-authenticate and retry once
      console.warn('[RG] 401 — re-authenticating...');
      _accessToken = null;
      await ensureToken();
      continue;
    }
    if (status < 200 || status >= 300) {
      throw new Error(`RG ${status} on ${path}: ${JSON.stringify(body).slice(0, 200)}`);
    }
    return body;
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