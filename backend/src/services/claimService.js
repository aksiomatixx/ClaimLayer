'use strict';

/**
 * ClaimService — orchestrates the full claim creation lifecycle.
 *
 * Timeline per architecture.md:
 *   T+0:00  FROI received
 *   T+0:30  ADP pull → demographics, AWW, TD rate
 *   T+0:35  Claim created in DB + FileHandler
 *   T+1:00  Claude AI analysis (async, via setImmediate in dev)
 *   T+2:25  Initial diaries set in FileHandler
 *
 * NOTE: The in-memory Map (claimsStore) is intentional for M1 mock testing.
 *       Replace every `claimsStore.*` call with the Supabase client in M2.
 */

const filehandler  = require('./filehandler');
const adp          = require('./adp');
const aiService    = require('./aiService');
const logger       = require('../logger');

// ── In-memory store (replace with Supabase in M2) ────────────────────────────
const claimsStore = new Map();
let _claimSeq = 42; // start above the mock data in App.jsx

function _nextClaimNumber() {
  return `HHW-${new Date().getFullYear()}-${String(_claimSeq++).padStart(3, '0')}`;
}

// ── Business-day helper ───────────────────────────────────────────────────────
// Adds N business days (Mon–Fri). Does not account for California holidays —
// add a holiday calendar in production.
function addBusinessDays(isoDate, days) {
  const d = new Date(isoDate);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.toISOString().split('T')[0];
}

// ── Create claim ──────────────────────────────────────────────────────────────

/**
 * Full FROI → claim creation flow.
 *
 * @param {object} froiData  Validated FROI payload from the route handler.
 * @param {string} employerId  Authenticated employer's ID.
 * @returns {object} Newly created claim record.
 */
async function createClaim(froiData, employerId) {
  const claimNumber = _nextClaimNumber();
  const now         = new Date().toISOString();

  logger.info({ msg: 'createClaim: start', claimNumber, employerId });

  // ── Step 1: Pull ADP data ──────────────────────────────────────────────────
  let employee;
  try {
    employee = await adp.getEmployeeWithFinancials(froiData.adpEmployeeId);
  } catch (err) {
    logger.error({ msg: 'createClaim: ADP pull failed', err: err.message, claimNumber });
    throw new Error(`ADP pull failed — cannot create claim without employee data: ${err.message}`);
  }

  // ── Step 2: Build the local claim record ────────────────────────────────────
  const claim = {
    id:          `claim_${Date.now()}`,
    claimNumber,
    employerId,
    status:      'new_claim',

    employee: {
      adpEmployeeId: froiData.adpEmployeeId,
      associateOID:  employee.associateOID,
      firstName:     employee.firstName,
      lastName:      employee.lastName,
      dob:           employee.dob,
      address:       employee.address,
      phone:         employee.phone,
      jobTitle:      employee.jobTitle,
      hireDate:      employee.hireDate,
    },

    // Financial data from ADP
    aww:             employee.aww,
    tdRate:          employee.tdRate,
    weeksCalculated: employee.weeksCalculated,

    // Injury facts from FROI
    dateOfInjury:      froiData.dateOfInjury,
    bodyPart:          froiData.bodyPart,
    injuryType:        froiData.injuryType,
    injuryDescription: froiData.injuryDescription,
    employerName:      froiData.employerName,

    // Set after FileHandler sync
    filehandlerId: null,

    // Set after async AI analysis
    aiAnalysis: null,
    priority:   null,

    createdAt: now,
    updatedAt: now,

    // Append-only event log — mirrors claim_events table
    events: [
      {
        type:      'claim_created',
        timestamp: now,
        data:      { source: 'froi', employerId, adpEmployeeId: froiData.adpEmployeeId },
      },
      {
        type:      'adp_pull_complete',
        timestamp: new Date().toISOString(),
        data:      { aww: employee.aww, tdRate: employee.tdRate, weeks: employee.weeksCalculated },
      },
    ],
  };

  // ── Step 3: Create claim in FileHandler ─────────────────────────────────────
  try {
    const fhResult = await filehandler.createClaim({
      claimNumber:  claimNumber,
      firstName:    employee.firstName,
      lastName:     employee.lastName,
      dob:          employee.dob,
      employerName: froiData.employerName,
      dateOfInjury: froiData.dateOfInjury,
      bodyPart:     froiData.bodyPart,
      injuryType:   froiData.injuryType,
    });

    claim.filehandlerId = fhResult.claimId;
    claim.events.push({
      type:      'filehandler_claim_created',
      timestamp: new Date().toISOString(),
      data:      { fhClaimId: fhResult.claimId, fhStatus: fhResult.status },
    });

    logger.info({ msg: 'createClaim: FileHandler sync OK', claimNumber, fhClaimId: fhResult.claimId });
  } catch (err) {
    // Persisting locally even when FH sync fails — reconciliation worker retries
    logger.error({ msg: 'createClaim: FileHandler sync FAILED', err: err.message, claimNumber });
    claim.events.push({
      type:      'filehandler_sync_failed',
      timestamp: new Date().toISOString(),
      data:      { error: err.message, willRetry: true },
    });
  }

  // ── Step 4: Seed initial statutory diaries in FileHandler ───────────────────
  if (claim.filehandlerId) {
    await _seedInitialDiaries(claim);
  }

  // ── Step 5: Persist locally (replace with Supabase insert in M2) ───────────
  claimsStore.set(claim.id, claim);

  // ── Step 6: Trigger async AI analysis ──────────────────────────────────────
  // In production this becomes: queue.enqueue('ClaimAnalysisWorker', claim.id)
  setImmediate(() => _runAnalysis(claim.id));

  logger.info({ msg: 'createClaim: complete', claimNumber, claimId: claim.id });
  return claim;
}

// ── Initial diaries (statutory deadlines) ─────────────────────────────────────
async function _seedInitialDiaries(claim) {
  const doi = claim.dateOfInjury;

  const diaries = [
    {
      type:       'DWC1_ISSUE',
      dueDate:    addBusinessDays(doi, 1),
      assignedTo: 'system@homecaretpa.com',
      priority:   'HIGH',
      notes:      `DWC-1 must be issued — date of injury ${doi}`,
    },
    {
      type:       'TD_PAYMENT_SETUP',
      dueDate:    addBusinessDays(doi, 14),
      assignedTo: 'system@homecaretpa.com',
      priority:   'HIGH',
      notes:      `First TD payment due within 14 days of disability onset — LC §4650. AWW: $${claim.aww}, TD rate: $${claim.tdRate}/wk`,
    },
    {
      type:       'PR2_FOLLOW_UP',
      dueDate:    addBusinessDays(doi, 7),
      assignedTo: 'system@homecaretpa.com',
      priority:   'MEDIUM',
      notes:      `PR-2 expected from treating physician within 5 business days of first visit`,
    },
    {
      type:       'DWC7_NOTICE',
      dueDate:    addBusinessDays(doi, 1),
      assignedTo: 'system@homecaretpa.com',
      priority:   'HIGH',
      notes:      `DWC-7 notice of rights must be mailed within 1 business day of claim creation`,
    },
    {
      type:       'COMPENSABILITY_DECISION_DUE',
      dueDate:    new Date(new Date(doi).getTime() + 90 * 24 * 60 * 60 * 1000)
                    .toISOString().split('T')[0],
      assignedTo: 'system@homecaretpa.com',
      priority:   'CRITICAL',
      notes:      `LC §5402 — claim presumed compensable by operation of law if not accepted or denied within 90 calendar days. DOI: ${doi}. Missing this deadline is a critical compliance failure.`,
    },
  ];

  for (const diary of diaries) {
    try {
      const result = await filehandler.createDiary(claim.filehandlerId, diary);
      claim.events.push({
        type:      'diary_created',
        timestamp: new Date().toISOString(),
        data:      { diaryType: diary.type, diaryId: result.diaryId, dueDate: diary.dueDate },
      });
    } catch (err) {
      logger.error({ msg: '_seedInitialDiaries: failed', diaryType: diary.type, err: err.message });
      claim.events.push({
        type:      'diary_create_failed',
        timestamp: new Date().toISOString(),
        data:      { diaryType: diary.type, error: err.message },
      });
    }
  }
}

// ── Async AI analysis ─────────────────────────────────────────────────────────
async function _runAnalysis(claimId) {
  const claim = claimsStore.get(claimId);
  if (!claim) return;

  logger.info({ msg: '_runAnalysis: start', claimId, claimNumber: claim.claimNumber });

  try {
    const analysis = await aiService.analyzeCompensability(claim);

    claim.aiAnalysis = analysis;
    claim.priority   = analysis.priority;
    claim.updatedAt  = new Date().toISOString();
    claim.events.push({
      type:      'ai_analysis_complete',
      timestamp: new Date().toISOString(),
      data:      analysis,
    });
    claimsStore.set(claimId, claim);

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
          null  // null = pending adjuster approval
        );

        claim.events.push({
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
        claimsStore.set(claimId, claim);
      } catch (err) {
        logger.error({ msg: '_runAnalysis: reserve set failed', claimId, err: err.message });
      }
    }

    logger.info({ msg: '_runAnalysis: complete', claimId, compensability: analysis.compensability });
  } catch (err) {
    logger.error({ msg: '_runAnalysis: AI call failed', claimId, err: err.message });
    claim.events.push({
      type:      'ai_analysis_failed',
      timestamp: new Date().toISOString(),
      data:      { error: err.message, requiresManualReview: true },
    });
    claimsStore.set(claimId, claim);
  }
}

// ── Read operations ───────────────────────────────────────────────────────────

async function getClaim(claimId) {
  // Replace with: return supabase.from('claims').select('*').eq('id', claimId).single()
  return claimsStore.get(claimId) || null;
}

async function listClaims(filters = {}) {
  // Replace with a Supabase query in M2
  let all = Array.from(claimsStore.values());
  if (filters.employerId) {
    all = all.filter(c => c.employerId === filters.employerId);
  }
  if (filters.status) {
    all = all.filter(c => c.status === filters.status);
  }
  return all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ── Adjuster reserve approval ─────────────────────────────────────────────────

/**
 * Adjuster reviews and approves (or adjusts) AI-suggested reserves.
 * This pushes the final reserves to FileHandler with the adjuster's email as approvedBy.
 */
async function approveReserves(claimId, reserves, adjusterEmail) {
  const claim = claimsStore.get(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);
  if (!claim.filehandlerId) throw new Error('Claim is not yet synced to FileHandler');

  await filehandler.setReserves(
    claim.filehandlerId,
    { ...reserves, reason: reserves.reason || 'Adjuster reserve approval' },
    'ADJUSTER',
    adjusterEmail
  );

  claim.events.push({
    type:      'reserves_approved',
    timestamp: new Date().toISOString(),
    data:      { approvedBy: adjusterEmail, ...reserves },
  });
  claim.updatedAt = new Date().toISOString();
  claimsStore.set(claimId, claim);

  return claim;
}

// ── Status update ─────────────────────────────────────────────────────────────

async function updateStatus(claimId, newStatus, changedBy) {
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

  const claim = claimsStore.get(claimId);
  if (!claim) throw new Error(`Claim not found: ${claimId}`);

  const allowed = VALID_TRANSITIONS[claim.status] || [];
  if (!allowed.includes(newStatus)) {
    throw new Error(`Invalid status transition: ${claim.status} → ${newStatus}`);
  }

  const prev        = claim.status;
  claim.status      = newStatus;
  claim.updatedAt   = new Date().toISOString();
  claim.events.push({
    type:      'status_changed',
    timestamp: new Date().toISOString(),
    data:      { from: prev, to: newStatus, changedBy },
  });
  claimsStore.set(claimId, claim);

  return claim;
}

module.exports = {
  createClaim,
  getClaim,
  listClaims,
  approveReserves,
  updateStatus,
  // exported for tests
  _runAnalysis,
  _nextClaimNumber,
};
