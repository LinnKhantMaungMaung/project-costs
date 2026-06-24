// server/bookings.js
// ─────────────────────────────────────────────────────────────────────────────
// Fetches all RG bookings for a date range and computes Current Man Days
// per project per cost centre, exactly matching the Excel Search sheet formula.
//
// Formula (confirmed from Excel analysis):
//   Current Man Days = SUM(Days column) WHERE Project Code = X AND Department = Y
//
// Cost Centre → Department + Category mapping:
//   113 Labour Panel Build              → Dept contains "Control Panels"
//   114 Labour Design                   → Dept = "Design"
//   226 Labour Installation             → Dept = "Electrical Installation"
//   228 Project Management (general)    → Dept contains "Projects" (not PLC-Amazon)
//   331 PLC development (offline)       → Dept = "PLC", Category ≠ Commissioning
//   332 PLC development (commissioning) → Dept = "PLC", Category = Commissioning
//   334 Robot development               → Dept = "Robotics"
//   424 Project management (higher)     → Dept = "Director" or "Manager"
//   HELIX                               → Dept = "HELIX"
//   Service                             → Dept = "Service"
// ─────────────────────────────────────────────────────────────────────────────

const { fetchResourceTypes, fetchBookingsSerial, fetchProjects, fetchAllResources } = require('./resourceGuru');

// ── Cost centre definitions ───────────────────────────────────────────────────
const COST_CENTRES = [
  {
    code: '113',
    name: 'Labour Panel Build',
    match: (dept, _cat) => /control panels/i.test(dept),
  },
  {
    code: '114',
    name: 'Labour Design',
    match: (dept, _cat) => /^design$/i.test(dept),
  },
  {
    code: '226',
    name: 'Labour Installation',
    match: (dept, _cat) => /electrical installation/i.test(dept),
  },
  {
    code: '228',
    name: 'Project Management (general)',
    match: (dept, _cat) => /projects/i.test(dept) && !/plc|amazon/i.test(dept),
  },
  {
    code: '331',
    name: 'PLC development (offline)',
    match: (dept, cat) => /^plc$/i.test(dept) && !/commissioning/i.test(cat),
  },
  {
    code: '332',
    name: 'PLC development (commissioning)',
    match: (dept, cat) => /^plc$/i.test(dept) && /commissioning/i.test(cat),
  },
  {
    code: '334',
    name: 'Robot development',
    match: (dept, _cat) => /robotics/i.test(dept),
  },
  {
    code: '424',
    name: 'Project management (higher level)',
    match: (dept, _cat) => /^(director|manager)$/i.test(dept),
  },
  {
    code: 'HELIX',
    name: 'HELIX / Software',
    match: (dept, _cat) => /helix/i.test(dept),
  },
  {
    code: 'SVC',
    name: 'Service',
    match: (dept, _cat) => /^service$/i.test(dept),
  },
  {
    code: 'PLCA',
    name: 'PLC - Amazon',
    match: (dept, _cat) => /plc.*amazon|amazon.*plc/i.test(dept),
  },
];

// ── Dept option lookup ────────────────────────────────────────────────────────
async function buildDeptLookup() {
  const CONTRACTOR_OPT_ID = 172385;
  const deptLookup = {};
  const contrLookup = {};

  try {
    const resourceTypes = await fetchResourceTypes();
    const personType = Array.isArray(resourceTypes)
      ? resourceTypes.find(rt => rt.id === 225004)
      : null;
    const deptField = personType?.custom_fields?.find(cf => cf.id === 81460);
    if (deptField?.custom_field_options) {
      deptField.custom_field_options.forEach(opt => {
        deptLookup[Number(opt.id)] = opt.value;
        deptLookup[String(opt.id)] = opt.value;
      });
    }
  } catch (err) {
    console.warn('[Bookings] Could not load dept options:', err.message);
  }

  return { deptLookup, CONTRACTOR_OPT_ID: 172385 };
}

// ── Main build ────────────────────────────────────────────────────────────────
async function buildProjectData(from, to, onProgress) {
  console.log(`[Bookings] Building project data ${from} → ${to}`);

  if (onProgress) onProgress({ stage: 'fetch', done: 0, total: 4 });

  // Build all lookup maps in parallel
  const [{ deptLookup, CONTRACTOR_OPT_ID }, allProjects, allResources] = await Promise.all([
    buildDeptLookup(),
    fetchProjects(),
    fetchAllResources(),
  ]);

  // Project ID → { code, name } lookup
  // RG projects have a 'project_code' field which is the human-readable number (e.g. 5884)
  const projectLookup = {};
  for (const p of allProjects) {
    projectLookup[String(p.id)] = {
      code: String(p.project_code || p.id),
      name: p.name || String(p.id),
    };
  }
  console.log(`[Bookings] Project lookup: ${Object.keys(projectLookup).length} projects`);
  // Log a sample to verify project_code field
  const sampleProj = allProjects[0];
  if (sampleProj) console.log(`[Bookings] Sample project fields: ${JSON.stringify(Object.keys(sampleProj))}`);
  if (sampleProj) console.log(`[Bookings] Sample project: id=${sampleProj.id} project_code=${sampleProj.project_code} name=${sampleProj.name}`);

  // Resource ID → { name, dept, isContractor, jobTitle } lookup
  const resourceLookup = {};
  const CONTRACTOR_OPT = 172385;
  for (const r of allResources) {
    const resCF     = r.custom_fields || {};
    const deptIds   = resCF['81460'] || [];
    const dept      = deptIds.length > 0
      ? (deptLookup[Number(deptIds[0])] || deptLookup[String(deptIds[0])] || 'Unknown')
      : 'Unknown';
    const contrIds  = resCF['81461'] || [];
    resourceLookup[String(r.id)] = {
      name:         r.name || 'Unknown',
      dept,
      isContractor: contrIds.map(Number).includes(CONTRACTOR_OPT),
      jobTitle:     r.job_title || '',
    };
  }
  console.log(`[Bookings] Resource lookup: ${Object.keys(resourceLookup).length} resources`);

  if (onProgress) onProgress({ stage: 'fetch', done: 1, total: 4 });

  const bookings = await fetchBookingsSerial(from, to, (count, done) => {
    if (onProgress) onProgress({ stage: 'fetch', done: 2, total: 4, bookings: count });
    console.log(`[Bookings] Fetched ${count} bookings so far...`);
  });

  if (onProgress) onProgress({ stage: 'build', done: 0, total: bookings.length });
  console.log(`[Bookings] Processing ${bookings.length} bookings...`);

  // projectMap: projectCode → projectData
  const projectMap = {};

  for (let i = 0; i < bookings.length; i++) {
    const b = bookings[i];

    // ── Project — use project_id to look up real project code ───────────────
    const projId  = b.project_id ? String(b.project_id) : null;
    const projInfo = projId ? projectLookup[projId] : null;

    // Skip bookings with no project assigned
    if (!projId || !projInfo) continue;

    const projCodeStr = projInfo.code;   // human-readable e.g. "5884"
    const projName    = projInfo.name;

    // ── Resource — look up by resource_id ────────────────────────────────────
    const resId   = b.resource_id ? String(b.resource_id) : null;
    const resInfo = resId ? resourceLookup[resId] : null;

    const resourceName = resInfo?.name         || 'Unknown';
    const dept         = resInfo?.dept         || 'Unknown';
    const isContractor = resInfo?.isContractor || false;

    // ── Category from custom_field_values ────────────────────────────────────
    const cfv      = b.custom_field_values || {};
    const catArr   = cfv['Category'] || cfv['category'] || [];
    const category = Array.isArray(catArr) ? (catArr[0] || 'None') : String(catArr || 'None');

    // ── Days: sum across durations array ─────────────────────────────────────
    // RG /bookings returns a durations array: [{date, duration (minutes)}]
    // Each entry is one calendar day. We sum them all for total days on this booking.
    const durations = b.durations || [];
    let totalMinutes = 0;
    let startDate = '';
    let endDate   = '';

    if (durations.length > 0) {
      // Use durations array (most accurate)
      for (const dur of durations) {
        totalMinutes += Number(dur.duration || 0);
        const d = (dur.date || '').slice(0, 10);
        if (!startDate || d < startDate) startDate = d;
        if (!endDate   || d > endDate)   endDate   = d;
      }
    } else {
      // Fallback: single duration field
      totalMinutes = Number(b.duration || b.minutes || 0);
      startDate    = (b.start_date || '').slice(0, 10);
      endDate      = (b.end_date   || startDate).slice(0, 10);
    }

    // Convert minutes to days (8hr = 480min per day, matching RG export)
    const days = totalMinutes > 0 ? totalMinutes / 480 : 0;
    if (days <= 0) continue;

    // ── Accumulate ───────────────────────────────────────────────────────────
    if (!projectMap[projCodeStr]) {
      projectMap[projCodeStr] = {
        code:            projCodeStr,
        name:            projName,
        empDays:         0,
        contractorDays:  0,
        totalDays:       0,
        costCentres:     {},
        people:          {},
        firstBooking:    startDate,
        lastBooking:     endDate,
      };
    }
    const proj = projectMap[projCodeStr];

    // Update booking date range
    if (startDate && startDate < proj.firstBooking) proj.firstBooking = startDate;
    if (endDate   && endDate   > proj.lastBooking)  proj.lastBooking  = endDate;

    // Employee vs contractor totals
    proj.totalDays += days;
    if (isContractor) proj.contractorDays += days;
    else              proj.empDays        += days;

    // Cost centre assignment
    let assigned = false;
    for (const cc of COST_CENTRES) {
      if (cc.match(dept, category)) {
        if (!proj.costCentres[cc.code]) {
          proj.costCentres[cc.code] = { code: cc.code, name: cc.name, days: 0 };
        }
        proj.costCentres[cc.code].days += days;
        assigned = true;
        break; // first matching cost centre wins
      }
    }
    if (!assigned) {
      // Put in "Other" bucket
      if (!proj.costCentres['OTHER']) {
        proj.costCentres['OTHER'] = { code: 'OTHER', name: 'Other / Unassigned', days: 0 };
      }
      proj.costCentres['OTHER'].days += days;
    }

    // People breakdown
    if (!proj.people[resourceName]) {
      proj.people[resourceName] = {
        name: resourceName, days: 0, dept,
        empType: isContractor ? 'Contractor' : 'Employee',
        firstBooking: startDate, lastBooking: endDate,
      };
    }
    proj.people[resourceName].days += days;
    if (startDate && startDate < proj.people[resourceName].firstBooking) proj.people[resourceName].firstBooking = startDate;
    if (endDate   && endDate   > proj.people[resourceName].lastBooking)  proj.people[resourceName].lastBooking  = endDate;

    if (i % 5000 === 0 && onProgress) {
      onProgress({ stage: 'build', done: i, total: bookings.length });
    }
  }

  // ── Finalise ─────────────────────────────────────────────────────────────
  const projects = Object.values(projectMap).map(p => ({
    ...p,
    empDays:        +p.empDays.toFixed(4),
    contractorDays: +p.contractorDays.toFixed(4),
    totalDays:      +p.totalDays.toFixed(4),
    costCentres: Object.values(p.costCentres)
      .map(cc => ({ ...cc, days: +cc.days.toFixed(4) }))
      .sort((a, b) => b.days - a.days),
    people: Object.values(p.people)
      .map(pe => ({ ...pe, days: +pe.days.toFixed(4) }))
      .sort((a, b) => b.days - a.days),
  })).sort((a, b) => Number(b.code) - Number(a.code));

  console.log(`[Bookings] Built ${projects.length} projects`);
  if (onProgress) onProgress({ stage: 'done', total: projects.length });

  return {
    projects,
    projectIndex: Object.fromEntries(projects.map(p => [p.code, p])),
    meta: {
      from, to,
      builtAt:       new Date().toISOString(),
      totalBookings: bookings.length,
      totalProjects: projects.length,
    },
  };
}

module.exports = { buildProjectData, COST_CENTRES };