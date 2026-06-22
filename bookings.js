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

const { fetchResourceTypes, fetchBookingsSerial } = require('./resourceGuru');

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

  const { deptLookup, CONTRACTOR_OPT_ID } = await buildDeptLookup();

  const bookings = await fetchBookingsSerial(from, to, (done, total) => {
    if (onProgress) onProgress({ stage: 'fetch', done, total });
    console.log(`[Bookings] Fetched ${done}/${total} months`);
  });

  if (onProgress) onProgress({ stage: 'build', done: 0, total: bookings.length });
  console.log(`[Bookings] Processing ${bookings.length} bookings...`);

  // projectMap: projectCode → projectData
  const projectMap = {};

  for (let i = 0; i < bookings.length; i++) {
    const b = bookings[i];

    // ── Project ──────────────────────────────────────────────────────────────
    const projCode = b.project?.id
      || b.project?.project_code
      || b.project_id
      || null;
    if (!projCode) continue;

    const projName = b.project?.name || b.project_name || String(projCode);
    const projCodeStr = String(projCode);

    // ── Resource ─────────────────────────────────────────────────────────────
    const res  = b.resource || {};
    const resCF = res.custom_fields || {};

    // Department
    const deptIds = resCF['81460'] || [];
    const dept    = deptIds.length > 0
      ? (deptLookup[Number(deptIds[0])] || deptLookup[String(deptIds[0])] || 'Unknown')
      : (res.job_title ? 'Unknown' : 'Unknown');

    // Contractor/Employee
    const contractorIds = resCF['81461'] || [];
    const isContractor  = contractorIds.map(Number).includes(CONTRACTOR_OPT_ID);

    // ── Category ─────────────────────────────────────────────────────────────
    const bookCF   = b.custom_fields || {};
    const category = bookCF['81458'] || b.activity_type?.name || 'None';

    // ── Days ─────────────────────────────────────────────────────────────────
    // RG /bookings returns duration in MINUTES
    const minutes = Number(b.duration || b.minutes || 0);
    const days    = minutes > 0 ? minutes / 480 : 0; // 480 min = 8hr day
    // Note: RG uses 7.5hr days in some exports, 8hr in others.
    // We use the raw Days logic: duration_minutes / 480
    // This matches the Excel Days column which is pre-computed by RG.

    if (days <= 0) continue;

    // ── Date ─────────────────────────────────────────────────────────────────
    const startDate = (b.start_date || '').slice(0, 10);
    const endDate   = (b.end_date   || startDate).slice(0, 10);

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
    const personName = res.name || 'Unknown';
    if (!proj.people[personName]) {
      proj.people[personName] = {
        name: personName, days: 0, dept,
        empType: isContractor ? 'Contractor' : 'Employee',
        firstBooking: startDate, lastBooking: endDate,
      };
    }
    proj.people[personName].days += days;
    if (startDate < proj.people[personName].firstBooking) proj.people[personName].firstBooking = startDate;
    if (endDate   > proj.people[personName].lastBooking)  proj.people[personName].lastBooking  = endDate;

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
