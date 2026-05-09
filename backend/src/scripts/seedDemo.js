'use strict';

/**
 * seedDemo.js — idempotent demo seeder.
 *
 * Creates exactly 8 fake claims spanning the lifecycle so a reviewer
 * can clone, run `npm run dev:demo`, and immediately see a populated
 * console.
 *
 * IDs are deterministic ('claim_demo_001' .. 'claim_demo_008') and
 * every row carries metadata.demo = true. The /admin/demo-reset
 * endpoint and the db:reset script use that flag to wipe just the
 * seed.
 *
 * REGULATORY DATA RULE (per Master_Context):
 *   No PDRS values, fee schedule amounts, AWW formulas, or statutory
 *   figures are synthesized here. PD evaluations use the existing
 *   pdrs_lookup seed (5/10/15/25/50 WPI rows from the 2005 PDRS).
 *   TD rates use the rates that adp.js / pdService.js already
 *   compute (within the 2026 statutory floor/ceiling per LC §4453).
 *   AWW values are realistic but explicitly fake placeholders for
 *   home health workers — they do not derive from a regulated
 *   schedule.
 */

const { supabase } = require('../services/supabase');
const logger       = require('../logger');

// ── Personas ──────────────────────────────────────────────────────────────────
//
// Names + 555 phones + 900-area "fake SSN" stubs (not stored — SSN is
// last-4-only per data-model.md). DOIs are computed at runtime as
// today - N days so the demo never goes stale.
//
const EMPLOYER_BRIGHTCARE = {
  id:   'employer-brightcare-001',
  name: 'BrightCare Home Health, Inc.',
};
const EMPLOYER_WESTSIDE = {
  id:   'employer-westside-001',
  name: 'Westside Home Care Services',
};

const PERSONAS = [
  { first: 'Maria',   last: 'Santos',   phone: '(213) 555-0101', dob: '1981-03-15', title: 'Home Health Aide II',     employer: EMPLOYER_BRIGHTCARE, aww: 750.75, tdRate: 500.50 },
  { first: 'James',   last: 'Lee',      phone: '(213) 555-0102', dob: '1978-11-02', title: 'LVN Home Health',         employer: EMPLOYER_BRIGHTCARE, aww: 1120.00, tdRate: 746.67 },
  { first: 'Rosa',    last: 'Mendez',   phone: '(213) 555-0103', dob: '1985-07-19', title: 'Personal Care Worker',    employer: EMPLOYER_BRIGHTCARE, aww: 621.00, tdRate: 414.00 },
  { first: 'David',   last: 'Park',     phone: '(213) 555-0104', dob: '1990-01-08', title: 'Home Health Aide I',      employer: EMPLOYER_BRIGHTCARE, aww: 690.00, tdRate: 460.00 },
  { first: 'Linda',   last: 'Chen',     phone: '(818) 555-0105', dob: '1972-06-25', title: 'Registered Nurse',        employer: EMPLOYER_WESTSIDE,   aww: 1480.00, tdRate: 986.67 },
  { first: 'Carlos',  last: 'Ruiz',     phone: '(818) 555-0106', dob: '1988-09-12', title: 'Home Health Aide II',     employer: EMPLOYER_WESTSIDE,   aww: 745.50, tdRate: 497.00 },
  { first: 'Emily',   last: 'Tran',     phone: '(818) 555-0107', dob: '1995-04-30', title: 'Personal Care Worker',    employer: EMPLOYER_WESTSIDE,   aww: 605.25, tdRate: 403.50 },
  { first: 'Marcus',  last: 'Williams', phone: '(310) 555-0108', dob: '1969-12-17', title: 'LVN Home Health',         employer: EMPLOYER_WESTSIDE,   aww: 1095.00, tdRate: 730.00 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString();
}
function dateDaysAgo(n) {
  return isoDaysAgo(n).split('T')[0];
}
function makeClaimId(idx) {
  return `claim_demo_${String(idx + 1).padStart(3, '0')}`;
}
function makeClaimNumber(idx) {
  const year = new Date().getFullYear();
  return `HHW-${year}-D${String(idx + 1).padStart(2, '0')}`;
}

// ── Lifecycle plans ───────────────────────────────────────────────────────────
//
// One entry per claim. Each picks a persona by index and declares the
// terminal status the claim should be in plus any side-effect rows
// (events, diaries, AI analysis, RFA, PD eval, settlement offer).
//
// daysAgo = how long ago the injury occurred so the demo always has
// plausibly-fresh dates regardless of when it's run.
//
const LIFECYCLE_PLANS = [
  {
    persona: 0, status: 'new_claim',          daysAgo: 1,
    bodyPart: 'Lumbar Spine / Lower Back',    injuryType: 'Lifting Injury',
    description: 'Felt sharp pain in lower back while transferring patient from bed to wheelchair.',
    priority: null, // no AI yet
  },
  {
    persona: 1, status: 'intake_complete',    daysAgo: 3,
    bodyPart: 'Wrist / Hand',                  injuryType: 'Strain / Sprain',
    description: 'Wrist pain after repetitive injection draws across long shift; gradual onset.',
    priority: null,
  },
  {
    persona: 2, status: 'under_investigation', daysAgo: 8,
    bodyPart: 'Shoulder',                      injuryType: 'Strain / Sprain',
    description: 'Right shoulder pain reported next morning; no witnesses; prior chiropractic care noted.',
    priority: 'High',
    aiCompensability: 'Questionable', aiConfidence: 62,
    aiRedFlags: ['No witnesses to mechanism', 'Prior shoulder treatment in claim history'],
  },
  {
    persona: 3, status: 'active_medical',      daysAgo: 21,
    bodyPart: 'Knee',                          injuryType: 'Slip & Fall',
    description: 'Slipped on wet floor in patient bathroom; right knee twisted, immediate swelling.',
    priority: 'Medium',
    aiCompensability: 'Likely Compensable', aiConfidence: 88,
    rfa: { decision: 'auto_approved', cpt: '97110', desc: 'Therapeutic exercise, 12 visits' },
  },
  {
    persona: 4, status: 'active_medical',      daysAgo: 28,
    bodyPart: 'Cervical Spine / Neck',         injuryType: 'Motor Vehicle',
    description: 'Rear-ended while driving home health route; immediate neck stiffness, EMS evaluated on scene.',
    priority: 'High',
    aiCompensability: 'Likely Compensable', aiConfidence: 91,
    aiRedFlags: ['SUBROGATION_POTENTIAL — third-party vehicle involved'],
    subrogationStatus: 'under_evaluation',
    rfa: { decision: null, cpt: '72141', desc: 'MRI cervical spine without contrast' },
  },
  {
    persona: 5, status: 'p_and_s',             daysAgo: 47,
    bodyPart: 'Lumbar Spine / Lower Back',     injuryType: 'Lifting Injury',
    description: 'Lumbar strain from patient lift; conservative care; treating physician declared P&S last week.',
    priority: 'Medium',
    aiCompensability: 'Likely Compensable',  aiConfidence: 86,
    pAndSDate: 4,
  },
  {
    persona: 6, status: 'pd_evaluation',       daysAgo: 55,
    bodyPart: 'Shoulder',                      injuryType: 'Repetitive Motion',
    description: 'Right shoulder impingement from repetitive overhead patient transfers; PR-4 received with WPI.',
    priority: 'Medium',
    aiCompensability: 'Likely Compensable',  aiConfidence: 89,
    pAndSDate: 12,
    pdEval: { wpi: 10, pdPercent: 16, pdWeeks: 48, pdWeeklyRate: 290, pdTotalValue: 13920 },
  },
  {
    persona: 7, status: 'settlement_discussions', daysAgo: 60,
    bodyPart: 'Knee',                          injuryType: 'Slip & Fall',
    description: 'Left knee meniscus tear from fall on stairs; surgery + PT; PD rated, C&R discussions opened.',
    priority: 'High',
    aiCompensability: 'Likely Compensable',  aiConfidence: 84,
    pAndSDate: 18,
    pdEval: { wpi: 15, pdPercent: 24, pdWeeks: 72.75, pdWeeklyRate: 290, pdTotalValue: 21097.50 },
    settlementOffer: { stipValue: 21097.50, cnrValue: 27500, cnrPremiumPct: 30.34 },
  },
];

// ── Wipe & seed ───────────────────────────────────────────────────────────────

/**
 * Wipe every demo claim plus child rows that FK into them.
 * Idempotent — safe to call when no demo data exists.
 */
async function wipeDemo() {
  const ids = [];
  for (let i = 0; i < LIFECYCLE_PLANS.length; i++) ids.push(makeClaimId(i));

  // Child tables first to avoid FK violations on real Postgres. The
  // in-memory mock ignores FKs but the order is still correct.
  const childTables = [
    'td_periods', 'pd_evaluations', 'settlement_offers',
    'rfas', 'rfa_evaluations',
    'diaries', 'claim_events', 'reserves', 'audit_log',
  ];
  for (const tbl of childTables) {
    for (const id of ids) {
      try { await supabase.from(tbl).delete().eq('claim_id', id); } catch { /* table may not exist */ }
    }
  }
  for (const id of ids) {
    try { await supabase.from('claims').delete().eq('id', id); } catch { /* ignore */ }
  }
  return ids.length;
}

/**
 * Seed all 8 demo claims. Idempotent: runs wipeDemo first.
 * Returns { count, ids, employers }.
 */
async function seedDemo() {
  await wipeDemo();

  // Upsert employers so the FK is satisfied. Both rows are safe to
  // re-upsert on re-run.
  for (const e of [EMPLOYER_BRIGHTCARE, EMPLOYER_WESTSIDE]) {
    try {
      await supabase.from('employers').upsert({
        id: e.id, name: e.name, address_state: 'CA', active: true,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
    } catch { /* employers table may have different shape in tests */ }
  }

  const created = [];
  for (let i = 0; i < LIFECYCLE_PLANS.length; i++) {
    const plan    = LIFECYCLE_PLANS[i];
    const persona = PERSONAS[plan.persona];
    const id      = makeClaimId(i);
    await _seedOneClaim(id, i, plan, persona);
    created.push(id);
  }

  logger.info({ msg: 'seedDemo: complete', count: created.length });
  return { count: created.length, ids: created,
    employers: [EMPLOYER_BRIGHTCARE.id, EMPLOYER_WESTSIDE.id] };
}

async function _seedOneClaim(id, idx, plan, persona) {
  const claimNumber = makeClaimNumber(idx);
  const doi  = dateDaysAgo(plan.daysAgo);
  const filed = isoDaysAgo(plan.daysAgo);

  const employeeSnapshot = {
    adpEmployeeId: `DEMO-${idx + 1}`,
    firstName:    persona.first,
    lastName:     persona.last,
    dob:          persona.dob,
    phone:        persona.phone,
    jobTitle:     persona.title,
    address:      { line1: '1234 Demo St', state: 'CA', zip: '90001' },
  };

  const aiAnalysis = plan.aiCompensability ? {
    compensability:           plan.aiCompensability,
    compensabilityScore:      plan.aiConfidence || 80,
    priority:                 plan.priority,
    suggestedMedicalReserve:   25000,
    suggestedIndemnityReserve: 18000,
    suggestedExpenseReserve:    4500,
    redFlags:                 plan.aiRedFlags || [],
    nextActions:              ['Confirm provider selection', 'Schedule MPN appointment'],
    analysisNotes:            'Demo-seeded analysis — values are illustrative; production AI run will overwrite.',
  } : null;

  await supabase.from('claims').insert({
    id,
    claim_number:        claimNumber,
    employer_id:         persona.employer.id,
    employer_name:       persona.employer.name,
    employee:            employeeSnapshot,
    status:              plan.status,
    date_of_injury:      doi,
    body_part:           plan.bodyPart,
    injury_type:         plan.injuryType,
    injury_description:  plan.description,
    aww:                 persona.aww,
    td_rate:             persona.tdRate,
    weeks_calculated:    52,
    ai_analysis:         aiAnalysis,
    priority:            plan.priority,
    subrogation_status:  plan.subrogationStatus || null,
    p_and_s_date:        plan.pAndSDate ? dateDaysAgo(plan.pAndSDate) : null,
    filed_at:            filed,
    metadata:            { demo: true, persona: `${persona.first} ${persona.last}` },
    created_at:          filed,
    updated_at:          filed,
  });

  // Event stream
  const events = [
    { type: 'claim_created',      offset: plan.daysAgo,     data: { source: 'demo_seed' } },
    { type: 'adp_pull_complete',  offset: plan.daysAgo,     data: { aww: persona.aww, tdRate: persona.tdRate } },
  ];
  if (aiAnalysis) events.push({ type: 'ai_analysis_complete', offset: Math.max(0, plan.daysAgo - 1), data: aiAnalysis });
  if (plan.status === 'p_and_s' || plan.status === 'pd_evaluation' || plan.status === 'settlement_discussions') {
    events.push({ type: 'p_and_s_recorded', offset: plan.pAndSDate || 5, data: { source: 'pr2' } });
  }
  if (plan.status === 'settlement_discussions') {
    events.push({ type: 'cnr_priced', offset: 1, data: { stip: plan.settlementOffer.stipValue, cnr: plan.settlementOffer.cnrValue } });
  }
  for (const e of events) {
    await supabase.from('claim_events').insert({
      claim_id: id, type: e.type,
      timestamp: isoDaysAgo(e.offset),
      data: e.data,
    });
  }

  // Diaries appropriate to status
  const diaryRows = _buildDiaries(id, plan);
  for (const d of diaryRows) {
    await supabase.from('diaries').insert(d);
  }

  // RFA if specified
  if (plan.rfa) {
    await supabase.from('rfas').insert({
      id:                   `rfa_demo_${idx + 1}`,
      claim_id:             id,
      received_at:          isoDaysAgo(Math.max(0, plan.daysAgo - 5)),
      requesting_physician: 'Dr. A. Demo',
      treatment_description: plan.rfa.desc,
      cpt_codes:            [plan.rfa.cpt],
      decision:             plan.rfa.decision,
      decision_made_at:     plan.rfa.decision ? isoDaysAgo(Math.max(0, plan.daysAgo - 4)) : null,
      created_at:           isoDaysAgo(Math.max(0, plan.daysAgo - 5)),
    });
  }

  // PD evaluation row driven from existing pdrs_lookup seed (5/10/15
  // WPI rows). Values in plan.pdEval are copied straight from those
  // seed rows — NOT computed here.
  if (plan.pdEval) {
    await supabase.from('pd_evaluations').insert({
      id:                    `pdeval_demo_${idx + 1}`,
      claim_id:              id,
      wpi:                   plan.pdEval.wpi,
      pd_percent:            plan.pdEval.pdPercent,
      pd_weeks:              plan.pdEval.pdWeeks,
      pd_weekly_rate:        plan.pdEval.pdWeeklyRate,
      pd_total_value:        plan.pdEval.pdTotalValue,
      apportionment_percent: 0,
      adjusted_pd_percent:   plan.pdEval.pdPercent,
      adjusted_total_value:  plan.pdEval.pdTotalValue,
      calculated_at:         isoDaysAgo(plan.pAndSDate || 5),
    });
  }

  // C&R offer if specified
  if (plan.settlementOffer) {
    await supabase.from('settlement_offers').insert({
      id:               `so_demo_${idx + 1}`,
      claim_id:         id,
      offer_type:       'cnr',
      stip_value:       plan.settlementOffer.stipValue,
      cnr_value:        plan.settlementOffer.cnrValue,
      cnr_premium_pct:  plan.settlementOffer.cnrPremiumPct,
      pricing_method:   'claude_ai',
      status:           'draft',
      created_at:       isoDaysAgo(1),
    });
  }
}

function _buildDiaries(claimId, plan) {
  const today = new Date().toISOString().split('T')[0];
  const inDays = (n) => {
    const d = new Date(); d.setDate(d.getDate() + n);
    return d.toISOString().split('T')[0];
  };
  const base = (type, dueOffset, priority, notes) => ({
    id:          `diy_demo_${claimId}_${type}`,
    claim_id:    claimId,
    diary_type:  type,
    due_date:    inDays(dueOffset),
    assigned_to: 'system@homecaretpa.com',
    priority,
    notes,
    status:      'open',
    fh_diary_id: `diy_${claimId}_${type}`,
    created_at:  new Date().toISOString(),
  });

  switch (plan.status) {
    case 'new_claim':
      return [base('DWC1_ISSUE', 1, 'HIGH', 'Issue DWC-1 claim form'),
              base('DWC7_NOTICE', 1, 'HIGH', 'Mail DWC-7 notice of rights')];
    case 'intake_complete':
      return [base('AI_ANALYSIS_PENDING', 0, 'MEDIUM', 'Run AI compensability analysis')];
    case 'under_investigation':
      return [base('COMPENSABILITY_DECISION_DUE', 60, 'CRITICAL', 'LC §5402 — accept or deny within 90 cal days')];
    case 'active_medical':
      return [base('PR2_FOLLOW_UP', 14, 'MEDIUM', 'Follow up on next PR-2 from treating physician'),
              base('TD_PAYMENT_REVIEW', 14, 'HIGH', 'Confirm TD payment continuity')];
    case 'p_and_s':
      return [base('PR4_SOLICITATION_DUE', 7, 'HIGH', 'Solicit PR-4 from treating physician (LC §4061)')];
    case 'pd_evaluation':
      return [base('PD_ADVANCE_DUE', 14, 'CRITICAL', 'Initiate PD advance within 14 cal days of TD end (LC §4650(b))')];
    case 'settlement_discussions':
      return [base('CNR_OFFER_FOLLOWUP', 14, 'MEDIUM', 'Follow up on C&R offer with worker / attorney')];
    default:
      return [];
  }
}

// ── CLI entry point ───────────────────────────────────────────────────────────
if (require.main === module) {
  seedDemo()
    .then(({ count, ids }) => {
      // eslint-disable-next-line no-console
      console.log(`✓ seeded ${count} demo claims: ${ids.join(', ')}`);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('✗ seedDemo failed:', err.message);
      process.exit(1);
    });
}

module.exports = { PERSONAS, EMPLOYER_BRIGHTCARE, EMPLOYER_WESTSIDE,
  LIFECYCLE_PLANS, isoDaysAgo, dateDaysAgo, makeClaimId, makeClaimNumber,
  seedDemo, wipeDemo };
