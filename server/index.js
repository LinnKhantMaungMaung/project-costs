// server/index.js
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const { buildProjectData } = require('./bookings');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── In-memory state ───────────────────────────────────────────────────────────
let state = {
  data:     null,   // { projects, projectIndex, meta }
  building: false,
  progress: null,
  error:    null,
};

function getDefaultRange() {
  const to   = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - 3);
  return {
    from: from.toISOString().slice(0, 10),
    to:   to.toISOString().slice(0, 10),
  };
}

// ── Build ─────────────────────────────────────────────────────────────────────
async function runBuild(from, to) {
  if (state.building) { console.log('[Server] Already building — skipping'); return; }
  state.building = true;
  state.error    = null;
  state.progress = { stage: 'starting', done: 0, total: 0 };

  try {
    console.log(`[Server] Build started: ${from} → ${to}`);
    const data = await buildProjectData(from, to, prog => { state.progress = prog; });
    state.data     = data;
    state.progress = { stage: 'done', total: data.projects.length };
    console.log(`[Server] Build complete — ${data.projects.length} projects`);
  } catch(err) {
    state.error    = err.message;
    state.progress = { stage: 'error', message: err.message };
    console.error('[Server] Build failed:', err.message);
  } finally {
    state.building = false;
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
    setInterval(() => { const r = getDefaultRange(); runBuild(r.from, r.to); }, 24*60*60*1000);
  }, msUntil);
}

// ── Start build on startup ────────────────────────────────────────────────────
const { from: defaultFrom, to: defaultTo } = getDefaultRange();
console.log(`[Server] Starting build: ${defaultFrom} → ${defaultTo}`);
runBuild(defaultFrom, defaultTo);
scheduleDailyRebuild();

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    ready:    !!state.data && !state.building,
    building: state.building,
    progress: state.progress,
    error:    state.error,
    meta:     state.data?.meta || null,
  });
});

app.get('/api/projects', (req, res) => {
  if (!state.data) return res.status(503).json({ error: 'Data not ready', building: state.building });
  if (req.query.q) {
    const q = req.query.q.toLowerCase();
    const results = state.data.projects
      .filter(p => p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
      .slice(0, 20)
      .map(p => ({ code: p.code, name: p.name, empDays: p.empDays, contractorDays: p.contractorDays, totalDays: p.totalDays, firstBooking: p.firstBooking, lastBooking: p.lastBooking }));
    return res.json({ projects: results });
  }
  res.json({
    projects: state.data.projects.map(p => ({
      code: p.code, name: p.name,
      empDays: p.empDays, contractorDays: p.contractorDays, totalDays: p.totalDays,
      firstBooking: p.firstBooking, lastBooking: p.lastBooking,
    })),
    meta: state.data.meta,
  });
});

app.get('/api/project/:code', (req, res) => {
  if (!state.data) return res.status(503).json({ error: 'Data not ready', building: state.building });
  const project = state.data.projectIndex[req.params.code];
  if (!project) return res.status(404).json({ error: `Project ${req.params.code} not found` });
  res.json(project);
});

app.get('/api/rebuild', (req, res) => {
  if (state.building) return res.status(409).json({ error: 'Build already in progress' });
  const from = req.query.from || getDefaultRange().from;
  const to   = req.query.to   || getDefaultRange().to;
  res.json({ ok: true, message: `Build started for ${from} → ${to}` });
  runBuild(from, to);
});

app.post('/api/rebuild', (req, res) => {
  if (state.building) return res.status(409).json({ error: 'Build already in progress' });
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  res.json({ ok: true, message: `Build started for ${from} → ${to}` });
  runBuild(from, to);
});

app.get('/api/reset', (req, res) => {
  if (state.building) return res.status(409).json({ error: 'Build already in progress' });
  const { from, to } = getDefaultRange();
  res.json({ ok: true, message: `Rebuilding with default range ${from} → ${to}` });
  runBuild(from, to);
});

// Debug: see raw booking fields
app.get('/api/debug-booking', async (req, res) => {
  try {
    const { fetchBookingsSerial } = require('./resourceGuru');
    const from = req.query.from || new Date(Date.now() - 7*24*3600*1000).toISOString().slice(0,10);
    const to   = req.query.to   || new Date().toISOString().slice(0,10);
    const raw  = await fetchBookingsSerial(from, to, () => {});
    res.json({ count: raw.length, sample: raw.slice(0, 2) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.listen(PORT, () => {
  console.log(`\n🚀 Project Costs running at http://localhost:${PORT}`);
  console.log(`   RG account : ${process.env.RG_ACCOUNT || '(not set)'}\n`);
});