// server/db.js
// PostgreSQL connection, schema setup, and all data operations

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', err => console.error('[DB] Unexpected pool error:', err.message));

// ── Setup schema ──────────────────────────────────────────────────────────────
async function setupSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_summaries (
        project_code    TEXT PRIMARY KEY,
        project_name    TEXT NOT NULL,
        emp_days        FLOAT DEFAULT 0,
        contractor_days FLOAT DEFAULT 0,
        total_days      FLOAT DEFAULT 0,
        first_booking   DATE,
        last_booking    DATE,
        cost_centres    JSONB DEFAULT '[]',
        people          JSONB DEFAULT '[]',
        built_at        TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS build_meta (
        id          INTEGER PRIMARY KEY DEFAULT 1,
        built_at    TIMESTAMP,
        range_from  DATE,
        range_to    DATE,
        total_projects  INTEGER DEFAULT 0,
        total_bookings  INTEGER DEFAULT 0
      );
    `);
    console.log('[DB] Schema ready');
  } finally {
    client.release();
  }
}

// ── Check if data is fresh (built within last 25 hours) ──────────────────────
async function getMetaStatus() {
  try {
    const res = await pool.query('SELECT * FROM build_meta WHERE id = 1');
    if (res.rows.length === 0) return null;
    return res.rows[0];
  } catch(err) {
    console.error('[DB] getMetaStatus error:', err.message);
    return null;
  }
}

// ── Save all projects to Postgres ─────────────────────────────────────────────
// Uses upsert so re-runs don't duplicate data
async function saveProjects(projects, meta) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clear old data
    await client.query('TRUNCATE project_summaries');

    // Batch insert all projects
    for (const p of projects) {
      await client.query(`
        INSERT INTO project_summaries
          (project_code, project_name, emp_days, contractor_days, total_days,
           first_booking, last_booking, cost_centres, people, built_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
        ON CONFLICT (project_code) DO UPDATE SET
          project_name    = EXCLUDED.project_name,
          emp_days        = EXCLUDED.emp_days,
          contractor_days = EXCLUDED.contractor_days,
          total_days      = EXCLUDED.total_days,
          first_booking   = EXCLUDED.first_booking,
          last_booking    = EXCLUDED.last_booking,
          cost_centres    = EXCLUDED.cost_centres,
          people          = EXCLUDED.people,
          built_at        = NOW()
      `, [
        p.code,
        p.name,
        p.empDays,
        p.contractorDays,
        p.totalDays,
        p.firstBooking || null,
        p.lastBooking  || null,
        JSON.stringify(p.costCentres),
        JSON.stringify(p.people),
      ]);
    }

    // Update meta
    await client.query(`
      INSERT INTO build_meta (id, built_at, range_from, range_to, total_projects, total_bookings)
      VALUES (1, NOW(), $1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET
        built_at       = NOW(),
        range_from     = EXCLUDED.range_from,
        range_to       = EXCLUDED.range_to,
        total_projects = EXCLUDED.total_projects,
        total_bookings = EXCLUDED.total_bookings
    `, [meta.from, meta.to, projects.length, meta.totalBookings]);

    await client.query('COMMIT');
    console.log(`[DB] Saved ${projects.length} projects`);
  } catch(err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Load all project summaries (lightweight — for list/search) ────────────────
async function loadProjectList() {
  const res = await pool.query(`
    SELECT project_code, project_name, emp_days, contractor_days, total_days,
           first_booking, last_booking
    FROM project_summaries
    ORDER BY project_code DESC
  `);
  return res.rows.map(r => ({
    code:           r.project_code,
    name:           r.project_name,
    empDays:        r.emp_days,
    contractorDays: r.contractor_days,
    totalDays:      r.total_days,
    firstBooking:   r.first_booking?.toISOString().slice(0,10) || null,
    lastBooking:    r.last_booking?.toISOString().slice(0,10)  || null,
  }));
}

// ── Load single project (full detail including cost centres + people) ─────────
async function loadProject(code) {
  const res = await pool.query(`
    SELECT * FROM project_summaries WHERE project_code = $1
  `, [code]);
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    code:           r.project_code,
    name:           r.project_name,
    empDays:        r.emp_days,
    contractorDays: r.contractor_days,
    totalDays:      r.total_days,
    firstBooking:   r.first_booking?.toISOString().slice(0,10) || null,
    lastBooking:    r.last_booking?.toISOString().slice(0,10)  || null,
    costCentres:    r.cost_centres,
    people:         r.people,
  };
}

// ── Search projects by code or name ──────────────────────────────────────────
async function searchProjects(query) {
  const res = await pool.query(`
    SELECT project_code, project_name, emp_days, contractor_days, total_days,
           first_booking, last_booking
    FROM project_summaries
    WHERE project_code ILIKE $1 OR project_name ILIKE $1
    ORDER BY total_days DESC
    LIMIT 20
  `, [`%${query}%`]);
  return res.rows.map(r => ({
    code:           r.project_code,
    name:           r.project_name,
    empDays:        r.emp_days,
    contractorDays: r.contractor_days,
    totalDays:      r.total_days,
    firstBooking:   r.first_booking?.toISOString().slice(0,10) || null,
    lastBooking:    r.last_booking?.toISOString().slice(0,10)  || null,
  }));
}

module.exports = { setupSchema, getMetaStatus, saveProjects, loadProjectList, loadProject, searchProjects, pool };