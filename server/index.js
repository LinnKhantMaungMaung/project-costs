// server/index.js
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const { buildProjectData }  = require('./bookings');
const { setupSchema, getMetaStatus, saveProjects, loadProjectList, loadProject, searchProjects } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Build state (in-memory progress tracking only) ────────────────────────────
let building = false;
let progress = null;
let buildError = null;

// ── Date range ────────────────────────────────────────────────────────────────
function getDefaultRange() {
  const to   = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - 3);
  return {
    from: from.toISOString().slice(0, 10),
    to:   to.toISOString().slice(0, 10),
  };
}

// ── Core build: fetch RG → calculate → save to Postgres ──────────────────────
async function runBuild(from, to) {
  if (building) {
    console.log('[Server] Build already in progress — skipping');
    return;
  }
  building   = true;
  buildError = null;
  progress   = { stage: 'starting', done: 0, total: 0 };

  try {
    console.log(`[Server] Build started: ${from} → ${to}`);
    const data = await buildProjectData(from, to, prog => { progress = prog; });
    await saveProjects(data.projects, data.meta);
    progress = { stage: 'done', total: data.projects.length };
    console.log(`[Server] Build complete — ${data.projects.length} projects saved to Postgres`);
  } catch(err) {
    buildError = err.message;
    progress   = { stage: 'error', message: err.message };
    console.error('[Server] Build failed:', err.message);
  } finally {
    building = false;
  }
}

// ── Schedule daily rebuild at 2am ─────────────────────────────────────────────
function scheduleDailyRebuild() {
  const now     = new Date();
  const next2am = new Date();
  next2am.setHours(2, 0, 0, 0);
  if (next2am <= now) next2am.setDate(next2am.getDate() + 1);
  const msUntil = next2am - now;
  console.log(`[Server] Next rebuild: ${next2am.toISOString()} (in ${Math.round(msUntil/3600000)}h)`);
  setTimeout(() => {
    const { from, to } = getDefaultRange();
    runBuild(from, to);
    setInterval(() => {
      const r = getDefaultRange();
      runBuild(r.from, r.to);
    }, 24 * 60 * 60 * 1000);
  }, msUntil);
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function startup() {
  // Set up tables if they don't exist
  await setupSchema();

  // Check if we have fresh data in Postgres already
  const meta = await getMetaStatus();

  if (!meta) {
    console.log('[Server] No data in Postgres — building now...');
    const { from, to } = getDefaultRange();
    runBuild(from, to); // non-blocking
  } else {
    const ageHours = (Date.now() - new Date(meta.built_at)) / 3600000;
    if (ageHours > 25) {
      console.log(`[Server] Data is ${Math.round(ageHours)}h old — rebuilding...`);
      const { from, to } = getDefaultRange();
      runBuild(from, to); // non-blocking
    } else {
      console.log(`[Server] Postgres data is ${Math.round(ageHours)}h old — ready immediately`);
      progress = { stage: 'done', total: meta.total_projects };
    }
  }

  scheduleDailyRebuild();
}

startup().catch(err => console.error('[Server] Startup error:', err.message));

// ── Routes ────────────────────────────────────────────────────────────────────

// Status — is data ready?
app.get('/api/status', async (req, res) => {
  try {
    const meta = await getMetaStatus();
    res.json({
      ready:    !!meta && !building,
      building,
      progress,
      error:    buildError,
      meta:     meta ? {
        builtAt:       meta.built_at,
        from:          meta.range_from,
        to:            meta.range_to,
        totalProjects: meta.total_projects,
        totalBookings: meta.total_bookings,
      } : null,
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// All projects — lightweight list for search/autocomplete
app.get('/api/projects', async (req, res) => {
  try {
    // Support search query param: /api/projects?q=5884
    if (req.query.q) {
      const results = await searchProjects(req.query.q);
      return res.json({ projects: results });
    }
    const projects = await loadProjectList();
    if (!projects.length && building) {
      return res.status(503).json({ error: 'Data still building', building });
    }
    const meta = await getMetaStatus();
    res.json({ projects, meta });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Single project — full detail
app.get('/api/project/:code', async (req, res) => {
  try {
    const project = await loadProject(req.params.code);
    if (!project) return res.status(404).json({ error: `Project ${req.params.code} not found` });
    res.json(project);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger a manual rebuild
app.get('/api/rebuild', (req, res) => {
  if (building) return res.status(409).json({ error: 'Build already in progress' });
  const from = req.query.from || getDefaultRange().from;
  const to   = req.query.to   || getDefaultRange().to;
  res.json({ ok: true, message: `Build started for ${from} → ${to}` });
  runBuild(from, to);
});

app.post('/api/rebuild', (req, res) => {
  if (building) return res.status(409).json({ error: 'Build already in progress' });
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  res.json({ ok: true, message: `Build started for ${from} → ${to}` });
  runBuild(from, to);
});

// Debug: see exactly what one booking looks like from RG API
app.get('/api/debug-booking', async (req, res) => {
  try {
    const { fetchBookingsSerial } = require('./resourceGuru');
    const from = req.query.from || new Date(Date.now() - 7*24*3600*1000).toISOString().slice(0,10);
    const to   = req.query.to   || new Date().toISOString().slice(0,10);
    console.log(`[Debug] Fetching sample booking ${from} → ${to}`);
    const bookings = [];
    const raw = await fetchBookingsSerial(from, to, () => {});
    // Return first 2 bookings in full so we can see all fields
    res.json({
      count: raw.length,
      sample: raw.slice(0, 2),
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.listen(PORT, () => {
  console.log(`\n🚀 Project Costs running at http://localhost:${PORT}`);
  console.log(`   RG account : ${process.env.RG_ACCOUNT || '(not set)'}`);
  console.log(`   Database   : ${process.env.DATABASE_URL ? '✓ connected' : '✗ DATABASE_URL not set'}\n`);
});