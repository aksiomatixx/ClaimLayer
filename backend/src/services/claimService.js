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
const config = require('../config');
const filehandler          = require('./filehandler');
const adp                  = require('./adp');
const aiService            = require('./aiService');
const noticeService        = require('./noticeService');
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
    filed_at:            row.filed_at,
    filehandlerId:       row.filehandler_id,
    sourceSystem:        row.source_system || 'native',
    externalClaimId:     row.external_claim_id || null,
    syncStatus:          row.sync_status || 'native',
    lastSyncedAt:        row.last_synced_at || null,
    aiAnalysis:          row.ai_analysis || null,
    priority:            row.priority    || null,
    motorVehicleFields:  row.motor_vehicle_fields || null,
    employerContests:    row.employer_contests    ?? false,
    subrogationStatus:   row.subrogation_status   || null,
    createdAt:           row.created_at,
    updatedAt:           row.updated_at,
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

  // ── Step 0: Resolve the policy in force at DOI (Carrier & Policy Modeling).
  // Non-fatal: claims without a resolvable policy fall back to employer-row
  // insurer data in the WCIS payload, exactly as before this milestone.
  let policyId = null;
  try {
    const policyService = require('./policyService');
    const policy = await policyService.resolvePolicy(employerId, froiData.dateOfInjury);
    if (policy) policyId = policy.id;
  } catch (e) {
    logger.warn({ msg: 'createClaim: policy resolution failed — falling back to employer insurer data', err: e.message });
  }

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
    policy_id:        policyId,
    body_part:        froiData.bodyPart,
    injury_type:      froiData.injuryType,
    injury_description: froiData.injuryDescription,
    employer_name:    froiData.employerName,
    filed_at:             now,
    filehandler_id:       null,
    ai_analysis:          null,
    priority:             null,
    motor_vehicle_fields: froiData.motorVehicleFields || null,
    employer_contests:    froiData.employerContests   || false,
    subrogation_status:   null,
    created_at:           now,
    updated_at:           now,
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

  // ── Step 6.5: Motor vehicle subrogation flag ─────────────────────────────────
  if (froiData.injuryType === 'Motor Vehicle') {
    await supabase
      .from('claims')
      .update({ subrogation_status: 'under_evaluation' })
      .eq('id', claimId);
  }

  // ── Step 7: Trigger async AI analysis ──────────────────────────────────────
  setImmediate(() => _runAnalysis(claimId));

  // ── Step 8: DWC-7 notice — fire-and-forget ────────────────────────────────
  // Runs after HTTP response returns. Errors are logged, never rethrown.
  setImmediate(() => {
    noticeService.generateDwc7(claimId).catch(err =>
      logger.error({ msg: 'createClaim: DWC-7 notice failed', claimId, err: err.message }),
    );
  });

  // ── Step 9: WCIS FROI 00 enqueue — fire-and-forget ────────────────────────
  // M22A: claim-creation hook. Enqueues FROI 00 in wcis_trigger_queue.
  // wcisTriggerService handles all gating (wcis_enabled, DOI cutoff,
  // duplicate detection). Errors are logged, never rethrown.
  setImmediate(() => {
    const wcis = require('./wcisTriggerService');
    wcis.enqueueIfReportable({
      claim_id:         claimId,
      trigger_event:    'claim_created',
      source_service:   'claimService',
      source_record_id: null,
      event_date:       froiData.dateOfInjury,
      payload_context: {
        doi:         froiData.dateOfInjury,
        employer_id: employerId,
        employee_id: froiData.employeeId || null,
        source:      'intake',
      },
    }).catch((err) =>
      logger.error({ msg: 'createClaim: WCIS FROI 00 enqueue failed', claimId, err: err.message }),
    );
  });

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
      assigned_to: config.adjuster.email,
      priority:    'HIGH',
      notes:       `DWC-1 must be issued — date of injury ${doi}`,
    },
    {
      diary_type:  'TD_PAYMENT_SETUP',
      due_date:    addBusinessDays(doi, 14).toISOString().split('T')[0],
      assigned_to: config.adjuster.email,
      priority:    'HIGH',
      notes:       `First TD payment due within 14 days of disability onset — LC §4650. AWW: $${aww}, TD rate: $${tdRate}/wk`,
    },
    {
      diary_type:  'PR2_FOLLOW_UP',
      due_date:    addBusinessDays(doi, 7).toISOString().split('T')[0],
      assigned_to: config.adjuster.email,
      priority:    'MEDIUM',
      notes:       `PR-2 expected from treating physician within 5 business days of first visit`,
    },
    {
      diary_type:  'DWC7_NOTICE',
      due_date:    addBusinessDays(doi, 1).toISOString().split('T')[0],
      assigned_to: config.adjuster.email,
      priority:    'HIGH',
      notes:       `DWC-7 notice of rights must be mailed within 1 business day of claim creation`,
    },
    {
      diary_type:  'COMPENSABILITY_DECISION_DUE',
      due_date:    new Date(new Date(doi).getTime() + 90 * 24 * 60 * 60 * 1000)
                     .toISOString().split('T')[0],
      assigned_to: config.adjuster.email,
      priority:    'CRITICAL',
      notes:       `LC §5402 — claim presumed compensable by operation of law if not accepted or denied within 90 calendar days. DOI: ${doi}. Missing this deadline is a critical compliance failure.`,
    },
    {
      diary_type:  'DELAY_NOTICE_DUE',
      due_date:    new Date(new Date(filedAt).getTime() + 14 * 24 * 60 * 60 * 1000)
                     .toISOString().split('T')[0],
      assigned_to: config.adjuster.email,
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

    // Reserve recommendations stay LOCAL in the suggested state. The
    // FileHandler ledger is the financial system of record — no external
    // reserve mutation happens until a licensed adjuster approves through
    // approveReserves (PATCH /claims/:id/reserves). The lifecycle is:
    //   suggested (ai_analysis + this event) → pending adjuster review →
    //   approved (reserves row, reserves_approved event, FileHandler write).
    if (analysis.suggestedMedicalReserve != null) {
      const { error: evErr } = await supabase.from('claim_events').insert({
        claim_id:  claimId,
        type:      'reserves_suggested',
        timestamp: new Date().toISOString(),
        data: {
          source:    'AI_ENGINE',
          status:    'suggested_pending_adjuster_approval',
          medical:   analysis.suggestedMedicalReserve,
          indemnity: analysis.suggestedIndemnityReserve,
          expense:   analysis.suggestedExpenseReserve,
        },
      });
      if (evErr) logger.error({ msg: '_runAnalysis: reserves_suggested event insert failed', claimId, err: evErr.message });
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

async function updateStatus(claimId, newStatus, changedBy, opts = {}) {
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

  // Compensability accept/deny is the human counterpart to the
  // AI compensability decision — link them so the audit trail
  // shows model rec → adjuster decision pairing.
  if (newStatus === 'accepted' || newStatus === 'denied') {
    try {
      await require('./aiDecisionsService').linkHumanDecision(claimId, 'compensability', {
        human_reviewer_id: null, human_decision: `${newStatus} by ${changedBy}`,
      });
    } catch { /* non-fatal */ }
  }

  // Keep test store in sync
  if (_testStore.has(claimId)) {
    const c = _testStore.get(claimId);
    c.status    = newStatus;
    c.updatedAt = now;
    c.events = c.events || [];
    c.events.push({ type: 'status_changed', timestamp: now, data: { from: prev, to: newStatus, changedBy } });
  }

  // ── WCIS hook — M22A ──────────────────────────────────────────
  // Intercept status transitions that are reportable to WCIS.
  //   denied   → FROI 04 or SROI 04 (depends on prior FROI accept)
  //   closed   → SROI FN (unless suppressed by settlement path)
  //
  // opts.suppressWcisClose=true is passed by cnrService.recordPayment
  // and disbursementService.recordDisbursementPayment to avoid
  // duplicate enqueue on settlement-driven closures.
  setImmediate(() => {
    const wcis = require('./wcisTriggerService');
    const doi = claim.dateOfInjury;

    if (newStatus === 'denied') {
      // wcisTriggerService handles FROI 04 vs SROI 04 routing by
      // inspecting wcis_claim_state.first_froi_accepted_at.
      wcis.enqueueIfReportable({
        claim_id:       claimId,
        trigger_event:  'claim_denied_no_payment',
        source_service: 'claimService',
        event_date:     now.slice(0, 10),
        payload_context: { doi, changedBy, from_status: prev },
      }).catch((err) => logger.error({
        msg: 'updateStatus WCIS denial enqueue failed', claimId, err: err.message,
      }));
    }

    if (newStatus === 'closed' && !opts.suppressWcisClose) {
      wcis.enqueueIfReportable({
        claim_id:       claimId,
        trigger_event:  'claim_closed',
        source_service: 'claimService',
        event_date:     now.slice(0, 10),
        payload_context: {
          doi,
          closed_date: now.slice(0, 10),
          source: 'updateStatus',
          claim_status_code: opts.futureMedicalOnly ? 'X' : 'C',
        },
      }).catch((err) => logger.error({
        msg: 'updateStatus WCIS close enqueue failed', claimId, err: err.message,
      }));
    }
  });

  // ── Legacy adapter write-back (M_legacy_integration) ──────────────────────
  // For claims migrated from a legacy system-of-record, push the field
  // change to that system through the adapter registry. Native and
  // a1_tracker claims also flow through the adapter — A1TrackerAdapter
  // delegates to filehandler so behavior is unchanged for them.
  //
  // QUEUE-NEVER-BLOCK: any failure is logged as a claim_event and toggles
  // sync_status='sync_failed'. Never throws into updateStatus.
  setImmediate(() => {
    _legacyWriteBackUpdate(claimId, {
      field: 'status', oldValue: prev, newValue: newStatus,
    }).catch((err) => logger.error({
      msg: 'updateStatus: legacy write-back unexpected throw', claimId, err: err.message,
    }));
  });

  if (_testStore.has(claimId)) {
    return _testStore.get(claimId);
  }
  return getClaim(claimId);
}

// ── Legacy write-back helper ─────────────────────────────────────────────────
// Routes a claim field-update through the appropriate LegacyClaimsAdapter
// based on source_system. Best-effort: never throws.
async function _legacyWriteBackUpdate(claimId, change) {
  const claim = await getClaim(claimId);
  if (!claim) return;

  // Skip native claims that don't yet have an external peer record.
  // (A1 / filehandler-side state for native claims continues to be managed
  // by claimService's existing filehandler calls — the adapter is layered
  // on top, not replacing those calls.)
  const sourceSystem = claim.sourceSystem || 'native';
  const externalId   = claim.externalClaimId;
  if (sourceSystem === 'native' || !externalId) return;

  const { getAdapter } = require('./legacy/adapterRegistry');
  const adapter = getAdapter(sourceSystem);
  const now = new Date().toISOString();

  try {
    await supabase.from('claims').update({
      sync_status: 'sync_pending', updated_at: now,
    }).eq('id', claimId);

    await adapter.pushClaimUpdate(externalId, change);

    await supabase.from('claims').update({
      sync_status:   'synced',
      last_synced_at: new Date().toISOString(),
      updated_at:    new Date().toISOString(),
    }).eq('id', claimId);

    await supabase.from('claim_events').insert({
      claim_id:  claimId,
      type:      'legacy_sync_ok',
      timestamp: new Date().toISOString(),
      data:      { source_system: sourceSystem, field: change.field, external_claim_id: externalId },
    });
  } catch (err) {
    logger.error({ msg: '_legacyWriteBackUpdate failed', claimId, sourceSystem, err: err.message });
    try {
      await supabase.from('claims').update({
        sync_status: 'sync_failed', updated_at: new Date().toISOString(),
      }).eq('id', claimId);
      await supabase.from('claim_events').insert({
        claim_id:  claimId,
        type:      'legacy_sync_failed',
        timestamp: new Date().toISOString(),
        data:      { source_system: sourceSystem, field: change.field, error: err.message },
      });
    } catch { /* swallowed — already in failure path */ }
  }
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

// ── M17B: attorney representation as a first-class claim operation ──────────

/**
 * Set or clear attorney representation on a claim. The authoritative
 * source is claims.attorney_represented; legacy ad-hoc fields remain
 * readable via utils/representation.js during the transition. Fires
 * SROI 02 (representation change) when the represented state actually
 * changes — a same-state update (e.g. correcting the firm name) does not.
 */
async function setAttorneyRepresentation(claimId, { represented, attorney }, changedBy) {
  const claim = await getClaim(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);

  const { data: row } = await supabase
    .from('claims').select('attorney_represented').eq('id', claimId).single();
  const wasRepresented = !!(row && row.attorney_represented);
  const nowRepresented = !!represented;

  const now = new Date().toISOString();
  const update = {
    attorney_represented: nowRepresented,
    attorney_name:  nowRepresented ? (attorney?.name  || null) : null,
    attorney_firm:  nowRepresented ? (attorney?.firm  || null) : null,
    attorney_email: nowRepresented ? (attorney?.email || null) : null,
    attorney_phone: nowRepresented ? (attorney?.phone || null) : null,
    updated_at: now,
  };
  await supabase.from('claims').update(update).eq('id', claimId);

  await supabase.from('claim_events').insert({
    claim_id: claimId,
    type: 'representation_changed',
    timestamp: now,
    data: { represented: nowRepresented, attorney_name: update.attorney_name, changed_by: changedBy },
  });

  if (wasRepresented !== nowRepresented) {
    // WCIS HOOK — SROI 02 (M17B). Non-fatal: a queue failure never
    // blocks the representation change.
    try {
      const wcis = require('./wcisTriggerService');
      await wcis.enqueueIfReportable({
        claim_id:         claimId,
        trigger_event:    'representation_changed',
        source_service:   'claimService',
        source_record_id: claimId,
        event_date:       now.split('T')[0],
        payload_context:  { represented: nowRepresented },
      });
    } catch (e) {
      logger.error({ msg: 'setAttorneyRepresentation: WCIS enqueue failed (non-fatal)', claimId, err: e.message });
    }
  }

  return getClaim(claimId);
}

/**
 * Reopen a closed claim (worker condition worsened). Sets the claim
 * back to active_medical, records the reopen event, and fires FROI 02
 * (data change) per the M17B reopen pathway. TD reinstatement, if any,
 * follows separately through tdPeriodsService (SROI RB).
 */
async function reopenClaim(claimId, reason, changedBy) {
  const claim = await getClaim(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);
  if (!['closed', 'future_medical_only'].includes(claim.status)) {
    throw new Error(`Only closed claims can be reopened (status: ${claim.status})`);
  }
  if (!reason) throw new Error('A reopen reason is required');

  const now = new Date().toISOString();
  await supabase.from('claims')
    .update({ status: 'active_medical', updated_at: now })
    .eq('id', claimId);

  await supabase.from('claim_events').insert({
    claim_id: claimId,
    type: 'claim_reopened',
    timestamp: now,
    data: { from_status: claim.status, reason, changed_by: changedBy },
  });

  await supabase.from('audit_log').insert({
    action: 'claim_reopened', resource_type: 'claim', resource_id: claimId,
    description: `Claim reopened from ${claim.status}: ${reason}`,
    actor: changedBy || null, created_at: now,
  });

  try {
    const wcis = require('./wcisTriggerService');
    await wcis.enqueueIfReportable({
      claim_id:         claimId,
      trigger_event:    'froi_data_changed',
      source_service:   'claimService',
      source_record_id: claimId,
      event_date:       now.split('T')[0],
      payload_context:  { reason: 'claim_reopened', from_status: claim.status },
    });
  } catch (e) {
    logger.error({ msg: 'reopenClaim: WCIS enqueue failed (non-fatal)', claimId, err: e.message });
  }

  return getClaim(claimId);
}

module.exports = {
  createClaim,
  setAttorneyRepresentation,
  reopenClaim,
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
  _legacyWriteBackUpdate,
};
