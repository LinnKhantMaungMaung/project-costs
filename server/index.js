// server/index.js
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const { buildProjectData } = require('./bookings');

const app  = express();
const PORT = process.env.PORT || 3001;

// Default: last 3 years to today
function getDefaultRange() {
  const to   = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - 3);
  return {
    from: from.toISOString().slice(0, 10),
    to:   to.toISOString().slice(0, 10),
  };
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── In-memory state ────────────────────────────────────────────────────────
let state = {
  data:     null,   // built project data
  building: false,
  progress: null,   // { stage, done, total }
  error:    null,
  range:    null,   // { from, to } currently loaded
};

// ── Build on startup ───────────────────────────────────────────────────────
async function startBuild(from, to) {
  if (state.building) return;
  state.building = true;
  state.error    = null;
  state.progress = { stage: 'starting', done: 0, total: 0 };
  state.range    = { from, to };

  try {
    const data = await buildProjectData(from, to, prog => {
      state.progress = prog;
    });
    state.data     = data;
    state.building = false;
    state.progress = { stage: 'done', total: data.projects.length };
    console.log(`[Server] Build complete — ${data.projects.length} projects`);
  } catch (err) {
    state.building = false;
    state.error    = err.message;
    state.progress = { stage: 'error', message: err.message };
    console.error('[Server] Build failed:', err.message);
  }
}

// Start immediately on server boot
const { from: defaultFrom, to: defaultTo } = getDefaultRange();
console.log(`[Server] Starting build for ${defaultFrom} → ${defaultTo}`);
startBuild(defaultFrom, defaultTo);

// ── Routes ─────────────────────────────────────────────────────────────────

// Status — is the data ready?
app.get('/api/status', (req, res) => {
  res.json({
    ready:    !!state.data && !state.building,
    building: state.building,
    progress: state.progress,
    error:    state.error,
    meta:     state.data?.meta || null,
  });
});

// Project list — all project codes + names for the search/autocomplete
app.get('/api/projects', (req, res) => {
  if (!state.data) {
    return res.status(503).json({ error: 'Data not ready', building: state.building, progress: state.progress });
  }
  // Return lightweight list: code, name, totalDays, firstBooking, lastBooking
  const list = state.data.projects.map(p => ({
    code:          p.code,
    name:          p.name,
    empDays:       p.empDays,
    contractorDays: p.contractorDays,
    totalDays:     p.totalDays,
    firstBooking:  p.firstBooking,
    lastBooking:   p.lastBooking,
  }));
  res.json({ projects: list, meta: state.data.meta });
});

// Single project — full detail including cost centres and people
app.get('/api/project/:code', (req, res) => {
  if (!state.data) {
    return res.status(503).json({ error: 'Data not ready', building: state.building, progress: state.progress });
  }
  const project = state.data.projectIndex[req.params.code];
  if (!project) {
    return res.status(404).json({ error: `Project ${req.params.code} not found` });
  }
  res.json(project);
});

// Trigger a rebuild with a custom date range
app.post('/api/rebuild', async (req, res) => {
  if (state.building) {
    return res.status(409).json({ error: 'Build already in progress' });
  }
  const { from, to } = req.body;
  if (!from || !to) {
    return res.status(400).json({ error: 'from and to dates required' });
  }
  res.json({ ok: true, message: `Build started for ${from} → ${to}` });
  startBuild(from, to); // non-blocking
});

// Serve the webpage
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Project Costs server running at http://localhost:${PORT}`);
  console.log(`   RG account: ${process.env.RG_ACCOUNT || '(not set)'}`);
  console.log(`   Default range: ${defaultFrom} → ${defaultTo}\n`);
});
