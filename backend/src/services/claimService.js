'use strict';

/**
 * ClaimService — M5 Supabase Swap.
 *
 * All claim persistence now goes through the Supabase client.
 * The Maps from M1 are replaced with structured queries.
 *
 * Table layout:
 *   claims        — core claim record
 *   claim_events  — immutable append-only event log
 *   diaries       — statutory diary deadlines
 *   reserves      — reserve history
 *
 * _seedClaim / _resetClaims  ─ test-only helpers.
 *   _seedClaim writes to an in-memory override Map so that unit and
 *   integration tests that seed directly (without going through the
 *   FROI flow) continue to work synchronously.  getClaim checks this
 *   map first before hitting Supabase.
 */

const { supabase }         = require('./supabase');
const filehandler          = require('./filehandler');
const adp                  = require('./adp');
const aiService            = require('./aiService');
const logger               = require('../logger');
const { addBusinessDays }  = require('../utils/businessDays');

// ── Sequence counter (fallback when RPC is unavailable in tests) ──────────────
let _claimSeq = 42;

async function _nextClaimNumber() {
  const { data, error } = await supabase.rpc('next_claim_number');
  if (!error && data) return data;
  // Fallback: generate locally (test environment / RPC not available)
  const num  = String(_claimSeq++).padStart(3, '0');
  const year = new Date().getFullYear();
  return `HHW-${year}-${num}`;
}

// ── Test override store ───────────────────────────────────────────────────────
// Populated only via _seedClaim(). getClaim checks here first so that
// tests that seed data synchronously bypass the Supabase mock.
const _testStore = new Map();

// ── DB ↔ JS mapping helpers ──────────────────────────────────────────────────

/**
 * Convert a Supabase claims row (with joined claim_events + diaries) into the
 * JS claim object shape that routes and tests expect.
 */
function _toClaim(row) {
  if (!row) return null;
  return {
    id:               row.id,
    claimNumber:      row.claim_number,
    employerId:       row.employer_id,
    status:           row.status,
    employee:         row.employee || {},   // JSONB snapshot
    aww:              row.aww    != null ? parseFloat(row.aww)    : 0,
    tdRate:           row.td_rate != null ? parseFloat(row.td_rate) : 0,
    weeksCalculated:  row.weeks_calculated,
    dateOfInjury:     row.date_of_injury,
    bodyPart:         row.body_part,
    injuryType:       row.injury_type,
    injuryDescription: row.injury_description,
    employerName:     row.employer_name,
    filed_at:         row.filed_at,
    filehandlerId:    row.filehandler_id,
    aiAnalysis:       row.ai_analysis || null,
    priority:         row.priority    || null,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
    events: ((row.claim_events || [])
      .slice()
      .sort((a, b) => new Date(a.timestamp || a.created_at) - new Date(b.timestamp || b.created_at))
      .map(e => ({
        type:      e.type,
        timestamp: e.timestamp || e.created_at,
        data:      e.data || {},
      }))),
    diaries: (row.diaries || []).map(d => ({
      diaryId:    d.fh_diary_id || d.id,
      type:       d.diary_type,
      dueDate:    d.due_date,
      assignedTo: d.assigned_to,
      priority:   d.priority,
      notes:      d.notes,
      status:     d.status,
      createdAt:  d.created_at,
    })),
  };
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

/** Fetch a claim row with its events and diaries joined. */
async function _fetchClaim(claimId) {
  const { data, error } = await supabase
    .from('claims')
    .select('*, claim_events(*), diaries(*)')
    .eq('id', claimId)
    .single();
  if (error || !data) return null;
  return _toClaim(data);
}

// ── Create claim ──────────────────────────────────────────────────────────────

async function createClaim(froiData, employerId) {
  const claimNumber = await _nextClaimNumber();
  const now         = new Date().toISOString();
  const claimId     = `claim_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  logger.info({ msg: 'createClaim: start', claimNumber, employerId });

  // ── Step 1: Pull ADP data ──────────────────────────────────────────────────
  let employee;
  try {
    employee = await adp.getEmployeeWithFinancials(froiData.adpEmployeeId);
  } catch (err) {
    logger.error({ msg: 'createClaim: ADP pull failed', err: err.message, claimNumber });
    throw new Error(`ADP pull failed — cannot create claim without employee data: ${err.message}`);
  }

  // ── Step 2: Upsert the employee record ─────────────────────────────────────
  const { data: empRow } = await supabase
    .from('employees')
    .upsert(
      {
        adp_employee_id:     froiData.adpEmployeeId,
        adp_associate_oid:   employee.associateOID,
        first_name:          employee.firstName,
        last_name:           employee.lastName,
        dob:                 employee.dob,
        address_line1:       employee.address?.line1,
        address_state:       employee.address?.state,
        address_zip:         employee.address?.zip,
        phone:               employee.phone,
        job_title:           employee.jobTitle,
        hire_date:           employee.hireDate,
        aww:                 employee.aww,
        td_rate:             employee.tdRate,
        weeks_calculated:    employee.weeksCalculated,
        adp_data_last_pulled: now,
        updated_at:          now,
      },
      { onConflict: 'adp_employee_id' }
    )
    .select()
    .single();

  // Build the employee snapshot stored inside the claim row (JSONB)
  const employeeSnapshot = {
    adpEmployeeId: froiData.adpEmployeeId,
    associateOID:  employee.associateOID,
    firstName:     employee.firstName,
    lastName:      employee.lastName,
    dob:           employee.dob,
    address:       employee.address,
    phone:         employee.phone,
    jobTitle:      employee.jobTitle,
    hireDate:      employee.hireDate,
  };

  // ── Step 3: Insert the claim row ───────────────────────────────────────────
  const claimRow = {
    id:               claimId,
    claim_number:     claimNumber,
    employer_id:      employerId,
    employee_id:      empRow?.id || null,
    status:           'new_claim',
    employee:         employeeSnapshot,
    aww:              employee.aww,
    td_rate:          employee.tdRate,
    weeks_calculated: employee.weeksCalculated,
    date_of_injury:   froiData.dateOfInjury,
    body_part:        froiData.bodyPart,
    injury_type:      froiData.injuryType,
    injury_description: froiData.injuryDescription,
    employer_name:    froiData.employerName,
    filed_at:         now,
    filehandler_id:   null,
    ai_analysis:      null,
    priority:         null,
    created_at:       now,
    updated_at:       now,
  };

  await supabase.from('claims').insert(claimRow);

  // ── Step 4: Insert initial events ──────────────────────────────────────────
  const initEvents = [
    {
      claim_id:  claimId,
      type:      'claim_created',
      timestamp: now,
      data:      { source: 'froi', employerId, adpEmployeeId: froiData.adpEmployeeId },
    },
    {
      claim_id:  claimId,
      type:      'adp_pull_complete',
      timestamp: new Date().toISOString(),
      data:      { aww: employee.aww, tdRate: employee.tdRate, weeks: employee.weeksCalculated },
    },
  ];
  await supabase.from('claim_events').insert(initEvents);

  // ── Step 5: FileHandler sync ────────────────────────────────────────────────
  let filehandlerId = null;
  try {
    const fhResult = await filehandler.createClaim({
      claimNumber,
      firstName:    employee.firstName,
      lastName:     employee.lastName,
      dob:          employee.dob,
      employerName: froiData.employerName,
      dateOfInjury: froiData.dateOfInjury,
      bodyPart:     froiData.bodyPart,
      injuryType:   froiData.injuryType,
    });

    filehandlerId = fhResult.claimId;

    await supabase.from('claims')
      .update({ filehandler_id: fhResult.claimId, updated_at: new Date().toISOString() })
      .eq('id', claimId);

    await supabase.from('claim_events').insert({
      claim_id:  claimId,
      type:      'filehandler_claim_created',
      timestamp: new Date().toISOString(),
      data:      { fhClaimId: fhResult.claimId, fhStatus: fhResult.status },
    });

    logger.info({ msg: 'createClaim: FileHandler sync OK', claimNumber, fhClaimId: fhResult.claimId });
  } catch (err) {
    logger.error({ msg: 'createClaim: FileHandler sync FAILED', err: err.message, claimNumber });
    await supabase.from('claim_events').insert({
      claim_id:  claimId,
      type:      'filehandler_sync_failed',
      timestamp: new Date().toISOString(),
      data:      { error: err.message, willRetry: true },
    });
  }

  // ── Step 6: Seed initial statutory diaries ─────────────────────────────────
  if (filehandlerId) {
    await _seedInitialDiaries(claimId, froiData.dateOfInjury, now, employee.aww, employee.tdRate);
  }

  // ── Step 7: Trigger async AI analysis ──────────────────────────────────────
  setImmediate(() => _runAnalysis(claimId));

  logger.info({ msg: 'createClaim: complete', claimNumber, claimId });

  // Return the fully assembled claim object
  return _fetchClaim(claimId);
}

// ── Initial diaries (statutory deadlines) ─────────────────────────────────────
async function _seedInitialDiaries(claimId, doi, filedAt, aww, tdRate) {
  const diaryDefs = [
    {
      diary_type:  'DWC1_ISSUE',
      due_date:    addBusinessDays(doi, 1).toISOString().split('T')[0],
      assigned_to: 'system@homecaretpa.com',
      priority:    'HIGH',
      notes:       `DWC-1 must be issued — date of injury ${doi}`,
    },
    {
      diary_type:  'TD_PAYMENT_SETUP',
      due_date:    addBusinessDays(doi, 14).toISOString().split('T')[0],
      assigned_to: 'system@homecaretpa.com',
      priority:    'HIGH',
      notes:       `First TD payment due within 14 days of disability onset — LC §4650. AWW: $${aww}, TD rate: $${tdRate}/wk`,
    },
    {
      diary_type:  'PR2_FOLLOW_UP',
      due_date:    addBusinessDays(doi, 7).toISOString().split('T')[0],
      assigned_to: 'system@homecaretpa.com',
      priority:    'MEDIUM',
      notes:       `PR-2 expected from treating physician within 5 business days of first visit`,
    },
    {
      diary_type:  'DWC7_NOTICE',
      due_date:    addBusinessDays(doi, 1).toISOString().split('T')[0],
      assigned_to: 'system@homecaretpa.com',
      priority:    'HIGH',
      notes:       `DWC-7 notice of rights must be mailed within 1 business day of claim creation`,
    },
    {
      diary_type:  'COMPENSABILITY_DECISION_DUE',
      due_date:    new Date(new Date(doi).getTime() + 90 * 24 * 60 * 60 * 1000)
                     .toISOString().split('T')[0],
      assigned_to: 'system@homecaretpa.com',
      priority:    'CRITICAL',
      notes:       `LC §5402 — claim presumed compensable by operation of law if not accepted or denied within 90 calendar days. DOI: ${doi}. Missing this deadline is a critical compliance failure.`,
    },
    {
      diary_type:  'DELAY_NOTICE_DUE',
      due_date:    new Date(new Date(filedAt).getTime() + 14 * 24 * 60 * 60 * 1000)
                     .toISOString().split('T')[0],
      assigned_to: 'system@homecaretpa.com',
      priority:    'HIGH',
      notes:       `LC §4650/§4652 — if compensability decision is not made within 14 days of FROI receipt (${filedAt.split('T')[0]}), a delay notice must be sent to the employee. Clock starts at FROI filing, not injury date.`,
    },
  ];

  const diaryRows = diaryDefs.map(d => ({
    ...d,
    claim_id:    claimId,
    fh_diary_id: `diy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    status:      'open',
    created_at:  new Date().toISOString(),
  }));

  await supabase.from('diaries').insert(diaryRows);

  const diaryEvents = diaryRows.map(d => ({
    claim_id:  claimId,
    type:      'diary_created',
    timestamp: new Date().toISOString(),
    data:      { diaryType: d.diary_type, diaryId: d.fh_diary_id, dueDate: d.due_date },
  }));

  if (diaryEvents.length) {
    await supabase.from('claim_events').insert(diaryEvents);
  }
}

// ── Async AI analysis ─────────────────────────────────────────────────────────
async function _runAnalysis(claimId) {
  // Use getClaim so test-seeded claims (in _testStore) are also found
  const claim = await getClaim(claimId);
  if (!claim) return;

  logger.info({ msg: '_runAnalysis: start', claimId, claimNumber: claim.claimNumber });

  try {
    const analysis = await aiService.analyzeCompensability(claim);

    if (!analysis) {
      logger.warn({ msg: '_runAnalysis: no analysis returned — skipping', claimId });
      return;
    }

    const updatedAt = new Date().toISOString();

    await supabase.from('claims').update({
      ai_analysis: analysis,
      priority:    analysis.priority,
      updated_at:  updatedAt,
    }).eq('id', claimId);

    // Also update test-seeded claims in _testStore
    if (_testStore.has(claimId)) {
      const tc = _testStore.get(claimId);
      tc.aiAnalysis = analysis;
      tc.priority = analysis.priority;
      tc.updatedAt = updatedAt;
    }

    await supabase.from('claim_events').insert({
      claim_id:  claimId,
      type:      'ai_analysis_complete',
      timestamp: updatedAt,
      data:      analysis,
    });

    // Push AI-suggested reserves to FileHandler (pending adjuster approval)
    if (claim.filehandlerId && analysis.suggestedMedicalReserve != null) {
      try {
        await filehandler.setReserves(
          claim.filehandlerId,
          {
            medical:   analysis.suggestedMedicalReserve,
            indemnity: analysis.suggestedIndemnityReserve,
            expense:   analysis.suggestedExpenseReserve,
            reason:    `AI initial analysis — ${claim.injuryType} (score: ${analysis.compensabilityScore})`,
          },
          'AI_ENGINE',
          null
        );

        await supabase.from('claim_events').insert({
          claim_id:  claimId,
          type:      'reserves_set',
          timestamp: new Date().toISOString(),
          data: {
            source:    'AI_ENGINE',
            medical:   analysis.suggestedMedicalReserve,
            indemnity: analysis.suggestedIndemnityReserve,
            expense:   analysis.suggestedExpenseReserve,
            status:    'pending_adjuster_approval',
          },
        });
      } catch (err) {
        logger.error({ msg: '_runAnalysis: reserve set failed', claimId, err: err.message });
      }
    }

    logger.info({ msg: '_runAnalysis: complete', claimId, compensability: analysis.compensability });
  } catch (err) {
    logger.error({ msg: '_runAnalysis: AI call failed', claimId, err: err.message });
    await supabase.from('claim_events').insert({
      claim_id:  claimId,
      type:      'ai_analysis_failed',
      timestamp: new Date().toISOString(),
      data:      { error: err.message, requiresManualReview: true },
    });
  }
}

// ── Synchronous trigger (POST /:id/analyze route) ────────────────────────────
async function triggerAnalysis(claimId) {
  const claim = await getClaim(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);
  if (claim.aiAnalysis) {
    logger.info({ msg: 'triggerAnalysis: returning cached result', claimId });
    return claim;
  }
  await _runAnalysis(claimId);
  return getClaim(claimId);
}

// ── Read operations ───────────────────────────────────────────────────────────

async function getClaim(claimId) {
  // Test seeds bypass Supabase
  if (_testStore.has(claimId)) return _testStore.get(claimId);
  return _fetchClaim(claimId);
}

async function listClaims(filters = {}) {
  let query = supabase
    .from('claims')
    .select('*, claim_events(*), diaries(*)')
    .order('created_at', { ascending: false });

  if (filters.employerId) query = query.eq('employer_id', filters.employerId);
  if (filters.status)     query = query.eq('status',      filters.status);

  const { data, error } = await query;
  if (error) {
    logger.error({ msg: 'listClaims: Supabase error', err: error.message });
    throw new Error(error.message);
  }

  // Merge Supabase rows with any test-seeded claims
  const fromDb = (data || []).map(_toClaim);
  const seeded = Array.from(_testStore.values()).filter(c => {
    if (filters.employerId && c.employerId !== filters.employerId) return false;
    if (filters.status     && c.status     !== filters.status)     return false;
    return true;
  });

  const all = [...fromDb, ...seeded];
  return all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ── Diaries ───────────────────────────────────────────────────────────────────
async function getDiaries(claimId) {
  const claim = await getClaim(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);
  return claim.diaries || [];
}

// ── Reserve approval ──────────────────────────────────────────────────────────
async function approveReserves(claimId, reserves, adjusterEmail) {
  const claim = await getClaim(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);
  if (!claim.filehandlerId) throw new Error('Claim is not yet synced to FileHandler');

  await filehandler.setReserves(
    claim.filehandlerId,
    { ...reserves, reason: reserves.reason || 'Adjuster reserve approval' },
    'ADJUSTER',
    adjusterEmail
  );

  const now = new Date().toISOString();

  await supabase.from('reserves').insert({
    claim_id:    claimId,
    medical:     reserves.medical   || 0,
    indemnity:   reserves.indemnity || 0,
    expense:     reserves.expense   || 0,
    reason:      reserves.reason,
    source:      'ADJUSTER',
    approved_by: adjusterEmail,
    created_at:  now,
  });

  await supabase.from('claim_events').insert({
    claim_id:  claimId,
    type:      'reserves_approved',
    timestamp: now,
    data:      { approvedBy: adjusterEmail, ...reserves },
  });

  await supabase.from('claims').update({ updated_at: now }).eq('id', claimId);

  // For test-seeded claims, update the in-memory object too
  if (_testStore.has(claimId)) {
    const c = _testStore.get(claimId);
    c.events = c.events || [];
    c.events.push({ type: 'reserves_approved', timestamp: now, data: { approvedBy: adjusterEmail, ...reserves } });
    c.updatedAt = now;
    return c;
  }

  return getClaim(claimId);
}

// ── Status update ─────────────────────────────────────────────────────────────
const VALID_TRANSITIONS = {
  new_claim:              ['intake_complete', 'denied'],
  intake_complete:        ['under_investigation', 'accepted'],
  under_investigation:    ['accepted', 'denied'],
  accepted:               ['active_medical'],
  active_medical:         ['p_and_s', 'litigated'],
  p_and_s:                ['pd_evaluation', 'litigated'],
  pd_evaluation:          ['settlement_discussions', 'litigated'],
  settlement_discussions: ['closed'],
  litigated:              ['settlement_discussions', 'closed'],
  denied:                 [],
  closed:                 [],
};

async function updateStatus(claimId, newStatus, changedBy) {
  const claim = await getClaim(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);

  const allowed = VALID_TRANSITIONS[claim.status] || [];
  if (!allowed.includes(newStatus)) {
    throw new Error(`Invalid status transition: ${claim.status} → ${newStatus}`);
  }

  const prev = claim.status;
  const now  = new Date().toISOString();

  await supabase.from('claims')
    .update({ status: newStatus, updated_at: now })
    .eq('id', claimId);

  await supabase.from('claim_events').insert({
    claim_id:  claimId,
    type:      'status_changed',
    timestamp: now,
    data:      { from: prev, to: newStatus, changedBy },
  });

  // Keep test store in sync
  if (_testStore.has(claimId)) {
    const c = _testStore.get(claimId);
    c.status    = newStatus;
    c.updatedAt = now;
    c.events = c.events || [];
    c.events.push({ type: 'status_changed', timestamp: now, data: { from: prev, to: newStatus, changedBy } });
    return c;
  }

  return getClaim(claimId);
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Insert a claim directly into the test override store.
 * Bypasses ADP + FileHandler — use in tests only.
 */
function _seedClaim(claim) {
  _testStore.set(claim.id, claim);
  return claim;
}

/**
 * Clear the test override store and reset the local sequence counter.
 * Also resets the Supabase mock store's claims/events/diaries if available.
 */
function _resetClaims() {
  _testStore.clear();
  _claimSeq = 42;
  // If the mock client exposes _resetStore, wipe claims-related tables too
  if (typeof supabase._resetStore === 'function') {
    supabase._resetStore(['claims', 'claim_events', 'diaries', 'reserves', 'employees']);
  }
}

module.exports = {
  createClaim,
  getClaim,
  listClaims,
  approveReserves,
  updateStatus,
  triggerAnalysis,
  getDiaries,
  // exported for tests
  _runAnalysis,
  _nextClaimNumber,
  _seedClaim,
  _resetClaims,
};
