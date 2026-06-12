'use strict';

/**
 * seedDemo.js — idempotent demo seeder.
 *
 * Creates exactly 12 fake claims spanning the lifecycle so a reviewer
 * can clone, run `npm run dev:demo`, and immediately see a populated
 * console.
 *
 * IDs are deterministic ('claim_demo_001' .. 'claim_demo_013',
 * skipping 'claim_demo_009' which is reserved for the linked 2024
 * prior claim) and every row carries metadata.demo = true. The
 * /admin/demo-reset endpoint and the db:reset script use that flag to
 * wipe just the seed.
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
const config = require('../config');
const logger       = require('../logger');

// Personas, lifecycle plans, and the deterministic ID helpers live in
// demoData.js (dependency-free) so the test-document generator can
// share them without pulling in the service/config chain.
const {
  EMPLOYER_BRIGHTCARE, EMPLOYER_WESTSIDE, PERSONAS, LIFECYCLE_PLANS,
  isoDaysAgo, dateDaysAgo, makeClaimId, makeClaimNumber,
} = require('./demoData');

const SEED_MODEL = 'claude-sonnet-4-6';

// ── Wipe & seed ───────────────────────────────────────────────────────────────

/**
 * Wipe every demo claim plus child rows that FK into them.
 * Idempotent — safe to call when no demo data exists.
 */
async function wipeDemo() {
  const ids = [];
  for (let i = 0; i < LIFECYCLE_PLANS.length; i++) ids.push(makeClaimId(i));
  ids.push('claim_demo_009'); // the linked 2024 prior claim (CL-DEMO2)

  // Child tables first to avoid FK violations on real Postgres. The
  // in-memory mock ignores FKs but the order is still correct.
  const childTables = [
    'td_periods', 'pd_evaluations', 'settlement_offers',
    'rfas', 'rfa_evaluations', 'ai_decisions',
    'pr4_solicitations', 'mmi_evaluations',  // pr4 FKs into mmi — delete first
    'diaries', 'claim_events', 'reserves', 'reserve_line_items', 'audit_log',
    'claim_documents',
  ];
  for (const id of ids) {
    try { await supabase.from('claim_links').delete().eq('claim_id_a', id); } catch { /* ignore */ }
    try { await supabase.from('claim_links').delete().eq('claim_id_b', id); } catch { /* ignore */ }
  }
  try { await supabase.from('supervisor_alerts').delete().eq('recipient_user_id', 'supervisor@homecaretpa.com'); } catch { /* ignore */ }
  for (const tbl of childTables) {
    for (const id of ids) {
      try { await supabase.from(tbl).delete().eq('claim_id', id); } catch { /* table may not exist */ }
    }
  }
  for (const id of ids) {
    try { await supabase.from('claims').delete().eq('id', id); } catch { /* ignore */ }
  }

  // ── Legacy integration demo (M_legacy_integration) ────────────────────────
  // Wipe the mock legacy system tables + any claim rows the migration
  // service created from them. External IDs are deterministic so this is
  // safe to re-run.
  const legacyExternalIds = ['LEG-000', 'LEG-001', 'LEG-002', 'LEG-003'];
  for (const tbl of ['legacy_updates', 'legacy_diaries', 'legacy_documents']) {
    for (const ext of legacyExternalIds) {
      try { await supabase.from(tbl).delete().eq('external_claim_id', ext); } catch { /* table may not exist */ }
    }
  }
  for (const ext of legacyExternalIds) {
    try { await supabase.from('legacy_claims').delete().eq('external_id', ext); } catch { /* */ }
    try { await supabase.from('claims').delete().eq('external_claim_id', ext); } catch { /* */ }
  }
  return ids.length;
}

/**
 * Seed all 12 demo claims. Idempotent: runs wipeDemo first.
 * Returns { count, ids, employers }.
 */
async function _seedTriageDocument() {
  // A low-confidence inbound fax the agent refused to file — sits in the
  // human triage queue (the pipeline's core guardrail on display).
  await supabase.from('claim_documents').insert({
    id: 'doc_demo_triage_001',
    claim_id: null,
    title: 'Faxed medical note — illegible header',
    category: 'other',
    source: 'fax',
    received_at: isoDaysAgo(1),
    pages: 1,
    status: 'triage',
    ai_summary: 'Single-page handwritten clinical note. Patient name partially legible; no claim number found in text. Appears to reference knee treatment.',
    relevant_to: [],
    classification_confidence: 41,
    classification_model: SEED_MODEL,
    triage_status: 'pending',
    triage_reason: 'confidence_below_threshold (41 < 70)',
    version: 1,
    created_at: isoDaysAgo(1),
    updated_at: isoDaysAgo(1),
  });
}

async function _seedCarriersAndPolicies() {
  // One carried employer (BrightCare via Pacific Compass) and one
  // self-insured (Westside). DOI-windowed so resolvePolicy() exercises
  // the date-interval logic on the demo book.
  await supabase.from('insurers').insert({
    id: 'ins_demo_pacific', fein: '954000001', name: 'Pacific Compass Insurance Co.',
    naic_code: '12345', active: true,
    created_at: isoDaysAgo(400), updated_at: isoDaysAgo(400),
  });
  await supabase.from('policies').insert({
    id: 'pol_demo_brightcare_2026', employer_id: EMPLOYER_BRIGHTCARE.id,
    insurer_id: 'ins_demo_pacific', policy_number: 'WC-2026-88421',
    effective_date: '2026-01-01', expiration_date: '2026-12-31', self_insured: false,
    created_at: isoDaysAgo(400), updated_at: isoDaysAgo(400),
  });
  await supabase.from('policies').insert({
    id: 'pol_demo_westside_2026', employer_id: EMPLOYER_WESTSIDE.id,
    insurer_id: null, policy_number: 'SI-CERT-04417',
    effective_date: '2026-01-01', expiration_date: null, self_insured: true,
    created_at: isoDaysAgo(400), updated_at: isoDaysAgo(400),
  });
}

async function seedDemo() {
  await _seedCarriersAndPolicies();
  await _seedTriageDocument();
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

  // ── Legacy integration demo data ──────────────────────────────────────────
  // Three un-migrated legacy claims (the "Migrate" button pulls them in)
  // plus one already-migrated example so the round trip is visible without
  // clicking anything.
  await _seedPriorRosaClaim();
  await _seedSupervisorDemo();
  await _seedLegacyDemo();

  logger.info({ msg: 'seedDemo: complete', count: created.length });
  return { count: created.length, ids: created,
    employers: [EMPLOYER_BRIGHTCARE.id, EMPLOYER_WESTSIDE.id] };
}


// ── Supervisor daily-alert demo data (CL-SUP1) ───────────────────────────────
// A supervisor user (role-model row) plus diaries that guarantee a
// non-empty digest: one CRITICAL due TODAY and two OVERDUE diaries on
// different adjusters, so the panel demos grouped-by-adjuster well.
async function _seedSupervisorDemo() {
  await supabase.from('users').upsert({
    id:    'a0000000-0000-4000-8000-000000000001',
    email: 'supervisor@homecaretpa.com',
    role:  'supervisor',
    created_at: new Date().toISOString(),
  }, { onConflict: 'email' });

  // Match the alert service's clock: the digest date is computed in
  // America/Los_Angeles, so "due today" — and the overdue offsets —
  // must be anchored to LA-today, not UTC-today.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const past = (n) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().split('T')[0];
  };
  const extra = [
    { id: 'diy_demo_sup_due_today', claim_id: makeClaimId(3),  // David Park, active_medical
      diary_type: 'TD_PAYMENT_REVIEW', due_date: today, priority: 'CRITICAL', no_snooze: true,
      assigned_to: config.adjuster.email,
      notes: 'Biweekly TD payment review — due today (synthetic demo diary for the supervisor digest).' },
    { id: 'diy_demo_sup_overdue_1', claim_id: makeClaimId(4),  // Linda Chen
      diary_type: 'PR2_FOLLOW_UP', due_date: past(3), priority: 'MEDIUM',
      assigned_to: 'j.lee@homecaretpa.com',
      notes: 'PR-2 follow-up — 3 days overdue (synthetic demo diary for the supervisor digest).' },
    { id: 'diy_demo_sup_overdue_2', claim_id: makeClaimId(5),  // Carlos Ruiz
      diary_type: 'QME_REPORT_REVIEW', due_date: past(6), priority: 'HIGH',
      assigned_to: 'd.park@homecaretpa.com',
      notes: 'QME report review — 6 days overdue (synthetic demo diary for the supervisor digest).' },
  ];
  for (const d of extra) {
    await supabase.from('diaries').insert({
      ...d, status: 'open', created_at: new Date().toISOString(),
    });
  }
}

// ── Legacy integration seed (M_legacy_integration) ────────────────────────────
// Realistic CA home-health injuries; deterministic external IDs so re-seed
// is idempotent. LEG-000 is pre-migrated with simulated write-back history;
// LEG-001..003 are un-migrated, waiting for the demo "Migrate" button.
async function _seedLegacyDemo() {
  const UN_MIGRATED = [
    {
      external_id: 'LEG-001',
      claimant_name: 'Theresa Nguyen',
      employer_name: 'Westside Home Care Services',
      doi:        dateDaysAgo(45),
      body_part:  'Lumbar Spine / Lower Back',
      status:     'open',
      raw: {
        injury_type: 'Lifting Injury',
        injury_description: 'Patient transfer lift; sudden lumbar pain, declined ER, reported next shift.',
        aww: 812.50, tdRate: 541.67,
        employee: {
          firstName: 'Theresa', lastName: 'Nguyen', dob: '1983-07-22',
          phone: '(818) 555-0211', jobTitle: 'LVN Home Health',
          address: { line1: '6710 Sepulveda Blvd', state: 'CA', zip: '91411' },
        },
      },
    },
    {
      external_id: 'LEG-002',
      claimant_name: 'Robert Ortiz',
      employer_name: 'BrightCare Home Health, Inc.',
      doi:        dateDaysAgo(12),
      body_part:  'Shoulder',
      status:     'pending_review',
      raw: {
        injury_type: 'Repetitive Motion',
        injury_description: 'Right shoulder pain after week of repeat overhead patient repositioning.',
        aww: 695.25, tdRate: 463.50,
        employee: {
          firstName: 'Robert', lastName: 'Ortiz', dob: '1991-02-14',
          phone: '(213) 555-0322', jobTitle: 'Home Health Aide II',
          address: { line1: '4422 W Adams Blvd', state: 'CA', zip: '90016' },
        },
      },
    },
    {
      external_id: 'LEG-003',
      claimant_name: 'Jennifer Park',
      employer_name: 'Westside Home Care Services',
      doi:        dateDaysAgo(4),
      body_part:  'Wrist / Hand',
      status:     'in_progress',
      raw: {
        injury_type: 'Strain / Sprain',
        injury_description: 'Right wrist soreness after long shift of medication preps; no specific incident.',
        aww: 730.00, tdRate: 486.67,
        employee: {
          firstName: 'Jennifer', lastName: 'Park', dob: '1989-11-30',
          phone: '(818) 555-0444', jobTitle: 'Personal Care Worker',
          address: { line1: '15040 Burbank Blvd', state: 'CA', zip: '91411' },
        },
      },
    },
  ];

  for (const row of UN_MIGRATED) {
    try {
      await supabase.from('legacy_claims').insert({ ...row, created_at: isoDaysAgo(45) });
    } catch (err) {
      logger.warn({ msg: '_seedLegacyDemo: legacy_claims insert failed', external_id: row.external_id, err: err.message });
    }
  }

  // Pre-migrated example: LEG-000 already exists in the legacy system AND
  // already has a claims row in ClaimLayer (sync_status='synced') plus a
  // visible round-trip footprint.
  await _seedPreMigrated();
}

async function _seedPreMigrated() {
  const externalId = 'LEG-000';
  const claimId    = `claim_legacy_${externalId}`;
  const doi        = dateDaysAgo(34);
  const filed      = isoDaysAgo(34);

  // Legacy-side seed row.
  try {
    await supabase.from('legacy_claims').insert({
      external_id:    externalId,
      claimant_name:  'Anthony Brooks',
      employer_name:  'BrightCare Home Health, Inc.',
      doi,
      body_part:      'Knee',
      status:         'in_progress',
      raw: {
        injury_type: 'Slip & Fall',
        injury_description: 'Slipped exiting patient bathroom; right knee twist + immediate swelling.',
        aww: 765.00, tdRate: 510.00,
        employee: {
          firstName: 'Anthony', lastName: 'Brooks', dob: '1976-09-04',
          phone: '(213) 555-0177', jobTitle: 'Home Health Aide II',
          address: { line1: '2200 W Olympic Blvd', state: 'CA', zip: '90006' },
        },
      },
      created_at: filed,
    });
  } catch { /* may already exist */ }

  // ClaimLayer-side migrated claim row.
  try {
    await supabase.from('claims').insert({
      id:                 claimId,
      claim_number:       `LEG-${externalId.slice(-6)}`,
      employer_id:        null,
      employer_name:      'BrightCare Home Health, Inc.',
      employee: {
        firstName: 'Anthony', lastName: 'Brooks', dob: '1976-09-04',
        phone: '(213) 555-0177', jobTitle: 'Home Health Aide II',
        address: { line1: '2200 W Olympic Blvd', state: 'CA', zip: '90006' },
      },
      status:             'active_medical',
      date_of_injury:     doi,
      body_part:          'Knee',
      injury_type:        'Slip & Fall',
      injury_description: 'Slipped exiting patient bathroom; right knee twist + immediate swelling.',
      aww:                765.00,
      td_rate:            510.00,
      filed_at:           filed,
      source_system:      'mock_legacy',
      external_claim_id:  externalId,
      sync_status:        'synced',
      last_synced_at:     isoDaysAgo(1),
      metadata:           { demo: true, migrated_from: 'mock_legacy' },
      created_at:         filed,
      updated_at:         isoDaysAgo(1),
    });
  } catch { /* */ }

  // Round-trip footprint: a diary + a notice + a status field update,
  // already pushed back to the legacy system. Lets the reviewer see what
  // "write-back" looks like without doing anything.
  try {
    await supabase.from('legacy_updates').insert({
      external_claim_id: externalId, field: 'status',
      old_value: 'open', new_value: 'in_progress',
      pushed_at: isoDaysAgo(20), created_at: isoDaysAgo(20),
    });
    await supabase.from('legacy_diaries').insert({
      external_claim_id: externalId, type: 'PR2_FOLLOW_UP',
      due_date: dateDaysAgo(-7),
      notes: 'Push from ClaimLayer: follow up on next PR-2 from treating physician',
      pushed_at: isoDaysAgo(15), created_at: isoDaysAgo(15),
    });
    await supabase.from('legacy_documents').insert({
      external_claim_id: externalId, doc_type: 'NOTICE_DWC7',
      title: 'DWC-7 Notice of Rights (generated by ClaimLayer)',
      summary: 'Statutory notice generated and pushed to legacy system-of-record.',
      pushed_at: isoDaysAgo(33), created_at: isoDaysAgo(33),
    });
  } catch (err) {
    logger.warn({ msg: '_seedPreMigrated: round-trip seed partial', err: err.message });
  }
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
    rationale:                plan.aiRationale ||
      'Synthetic demo rationale: mechanism, treatment pattern, and reporting timeline are consistent with a work-related injury; no disqualifying findings in the seeded file.',
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
    // Explicit source_system='native' so the Integrations "Migrated Claims"
    // view filters these out cleanly. The Postgres DEFAULT does this in
    // prod; setting it here makes the in-memory mock behave identically.
    source_system:       'native',
    sync_status:         'native',
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

  // Documents appropriate to status (with AI summaries for the decision brief)
  const docRows = _buildDocuments(id, idx, plan);
  for (const doc of docRows) {
    await supabase.from('claim_documents').insert(doc);
  }

  // Link open diaries to the source documents that queued them — the
  // document-to-action demo path the drawer renders end to end.
  for (const doc of docRows) {
    for (const dtype of (doc.relevant_to || [])) {
      await supabase.from('diaries')
        .update({ source_document_id: doc.id })
        .eq('claim_id', id).eq('diary_type', dtype).eq('status', 'open');
    }
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

  // TD periods — direct insert (NOT via tdPeriodsService.createPeriod):
  // the service writes audit_log + claim_event entries that are
  // meaningless for a synthetic seed, and rejects start_date <
  // active.start_date which would block seeding closed periods in any
  // order. Per-row IDs are deterministic so re-seed is idempotent.
  if (plan.tdPeriods && plan.tdPeriods.length > 0) {
    await _seedTdPeriods(id, plan, persona);
  }

  if (plan.aiDecisions && plan.aiDecisions.length > 0) {
    await _seedAiDecisions(id, idx, plan, persona);
  }

  if (plan.reserveWorksheet) {
    await _seedReserveWorksheet(id, plan.reserveWorksheet);
  }

  if (plan.mmi) {
    await _seedMmiSolicitation(id, idx, plan);
  }
}

// MMI-approach footprint (M12): the agent's mmi_evaluations row
// (recommendation solicit_pr4), the adjuster-acted pr4_solicitations
// row with the 30-day response clock running, and the matching claim
// events. Deterministic UUID-shaped ids so re-seed is idempotent.
async function _seedMmiSolicitation(claimId, idx, plan) {
  const m = plan.mmi;
  const evalId = `bbbbbbbb-bbbb-4${String(idx + 1).padStart(3, '0')}-8bbb-000000000001`;
  const pr4Id  = `cccccccc-cccc-4${String(idx + 1).padStart(3, '0')}-8ccc-000000000001`;
  const responseDue = dateDaysAgo(m.solicitedDaysAgo - 30); // 30 calendar days from solicitation

  await supabase.from('mmi_evaluations').insert({
    id:              evalId,
    claim_id:        claimId,
    evaluated_at:    isoDaysAgo(m.evaluatedDaysAgo),
    signals:         m.signals,
    signal_count:    m.signals.length,
    recommendation:  'solicit_pr4',
    rationale:       m.rationale,
    adjuster_action: 'pr4_solicited',
    acted_at:        isoDaysAgo(m.solicitedDaysAgo),
  });
  await supabase.from('pr4_solicitations').insert({
    id:                pr4Id,
    claim_id:          claimId,
    mmi_evaluation_id: evalId,
    solicitation_date: dateDaysAgo(m.solicitedDaysAgo),
    response_due_date: responseDue,
    physician_name:    m.physician,
    method:            'lob',
    lob_letter_id:     `ltr_demo_${claimId}`,
    status:            'sent',
    created_at:        isoDaysAgo(m.solicitedDaysAgo),
  });
  await supabase.from('claim_events').insert([
    { claim_id: claimId, type: 'mmi_evaluated', timestamp: isoDaysAgo(m.evaluatedDaysAgo),
      data: { evaluationId: evalId, recommendation: 'solicit_pr4', signalCount: m.signals.length, demo: true } },
    { claim_id: claimId, type: 'pr4_solicited', timestamp: isoDaysAgo(m.solicitedDaysAgo),
      data: { pr4Id, physicianName: m.physician, responseDueDate: responseDue, demo: true } },
  ]);
}

// Itemized reserve worksheet (CL-RSV1). Direct insert with
// deterministic ids so re-seed is idempotent. All amounts are
// SYNTHETIC demo values — basis notes say so; nothing here is a
// statutory or fee-schedule figure.
async function _seedReserveWorksheet(claimId, items) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const total = it.shape === 'flat'
      ? it.flat_amount
      : Math.round(it.quantity * it.unit_amount * 100) / 100;
    await supabase.from('reserve_line_items').insert({
      id:          `rli_demo_${claimId}_${i + 1}`,
      claim_id:    claimId,
      category:    it.category,
      label:       it.label,
      shape:       it.shape || 'quantity',
      quantity:    it.quantity ?? null,
      unit_amount: it.unit_amount ?? null,
      flat_amount: it.flat_amount ?? null,
      total,
      basis_note:  it.basis_note,
      created_by:  'seed@demo',
      created_at:  new Date().toISOString(),
      updated_at:  new Date().toISOString(),
    });
  }
}


// ── Prior Rosa Mendez claim (CL-DEMO2) ───────────────────────────────────────
// A 2024 right-shoulder claim for the SAME worker (DEMO-3), closed by
// stipulated award, linked to the 2026 claim so the red flag on the
// open file is traceable to a real claim in the demo. Minimal document
// set, completed diaries, a closed-claim reserve worksheet, and the
// matching approved reserves row. All values synthetic.
async function _seedPriorRosaClaim() {
  const id = 'claim_demo_009';
  const claimNumber = 'HHW-2024-D09';
  const currentClaimId = makeClaimId(2);            // Rosa's 2026 claim
  const currentClaimNumber = makeClaimNumber(2);
  const persona = PERSONAS[2];
  const doi = '2024-03-12';
  const filed = '2024-03-13T16:00:00.000Z';
  const closedAt = '2024-09-20T18:00:00.000Z';

  await supabase.from('claims').insert({
    id,
    claim_number:       claimNumber,
    employer_id:        persona.employer.id,
    employer_name:      persona.employer.name,
    employee: {
      adpEmployeeId: 'DEMO-3',
      firstName:     persona.first,
      lastName:      persona.last,
      dob:           persona.dob,
      phone:         persona.phone,
      jobTitle:      persona.title,
      address:       { line1: '1234 Demo St', state: 'CA', zip: '90001' },
    },
    status:             'closed',
    date_of_injury:     doi,
    body_part:          'Shoulder',
    injury_type:        'Strain / Sprain',
    injury_description:
      'Right shoulder strain lifting a patient during a bed-to-chair transfer. ' +
      'Resolved by stipulated award (8% PD, future medical open). ' +
      `Worker subsequently reported a new right shoulder injury in 2026 under linked claim ${currentClaimNumber}.`,
    aww:                590.00,
    td_rate:            393.33,
    weeks_calculated:   52,
    ai_analysis:        null,
    priority:           null,
    filed_at:           filed,
    source_system:      'native',
    sync_status:        'native',
    metadata:           { demo: true, persona: `${persona.first} ${persona.last}`, resolution: 'stipulated_award' },
    created_at:         filed,
    updated_at:         closedAt,
  });

  await supabase.from('claim_events').insert([
    { claim_id: id, type: 'claim_created',  timestamp: filed,    data: { source: 'froi', demo: true } },
    { claim_id: id, type: 'status_changed', timestamp: closedAt, data: { from: 'settlement_discussions', to: 'closed', changedBy: 'adjuster@homecaretpa.com' } },
  ]);

  // Minimal document set — all summaries consistent with the right shoulder.
  const docs = [
    { slug: 'froi', received: '2024-03-13T16:00:00.000Z',
      title: 'DWC-1 / First Report of Injury', category: 'state_form', pages: 3,
      ai_summary: 'Employer first report (2024). Right shoulder strain during patient transfer; reported same day; employer does not contest.' },
    { slug: 'pr1', received: '2024-03-18T16:00:00.000Z',
      title: 'Initial treating physician report (PR-1)', category: 'medical', pages: 5,
      ai_summary: 'First visit report (2024). Dx: right shoulder strain. Reduced abduction ROM, positive impingement signs. Restrictions: limited overhead reach, no lifting >10 lbs. Resolved with conservative care.' },
    { slug: 'stip_award', received: '2024-09-15T16:00:00.000Z',
      title: 'Stipulations with Request for Award — approved', category: 'settlement', pages: 9,
      ai_summary: 'WCAB-approved stipulated award: 8% PD to the right shoulder, future medical open for the shoulder. Claim administratively closed after award payment.' },
  ];
  for (const d of docs) {
    await supabase.from('claim_documents').insert({
      id: `doc_demo_${id}_${d.slug}`,
      claim_id: id,
      title: d.title,
      category: d.category,
      source: 'inbound_mail',
      received_at: d.received,
      pages: d.pages,
      status: 'filed',
      ai_summary: d.ai_summary,
      relevant_to: [],
      classification_confidence: 90,
      classification_model: SEED_MODEL,
      triage_status: 'none',
      version: 1,
      created_at: d.received,
      updated_at: d.received,
    });
  }

  // Completed diaries — a closed file has no open work.
  const closedDiaries = [
    { type: 'COMPENSABILITY_NOTICE_DUE', due: '2024-03-27', completedAt: '2024-03-20T17:00:00.000Z',
      action: 'accept', note: 'Witnessed mechanism, immediate report, PR-1 causation clear (synthetic demo decision).' },
    { type: 'TD_PAYMENT_REVIEW', due: '2024-05-01', completedAt: '2024-05-01T17:00:00.000Z',
      action: 'suspend', note: 'Released to full duty after 5 weeks TD (synthetic demo decision).' },
    { type: 'CNR_ADJUSTER_SIGN', due: '2024-09-12', completedAt: '2024-09-12T17:00:00.000Z',
      action: 'complete', note: 'Stipulated award signed and filed (synthetic demo decision).' },
  ];
  for (const d of closedDiaries) {
    await supabase.from('diaries').insert({
      id: `diy_demo_${id}_${d.type}`,
      claim_id: id,
      diary_type: d.type,
      due_date: d.due,
      assigned_to: config.adjuster.email,
      priority: 'HIGH',
      status: 'completed',
      completed_at: d.completedAt,
      completed_by: 'adjuster@homecaretpa.com',
      decision_action: d.action,
      decision_note: d.note,
      created_at: '2024-03-13T16:00:00.000Z',
    });
  }

  // Closed-claim worksheet: final actuals, not projections.
  await _seedReserveWorksheet(id, [
    { category: 'medical', label: 'PTP visits (final)', shape: 'quantity', quantity: 6, unit_amount: 240,
      basis_note: 'Actual visits billed through claim closure (synthetic demo figure)' },
    { category: 'medical', label: 'Physical therapy (final)', shape: 'quantity', quantity: 10, unit_amount: 120,
      basis_note: 'Completed PT course (synthetic demo figure)' },
    { category: 'indemnity', label: 'Temporary disability (paid)', shape: 'weeks_rate', quantity: 5, unit_amount: 393.33,
      basis_note: '5 weeks TD actually paid at the 2024 claim rate (synthetic demo figure)' },
    { category: 'indemnity', label: 'PD per stipulated award', shape: 'flat', flat_amount: 6960,
      basis_note: 'SYNTHETIC DEMO FIGURE — 8% PD per the approved stipulation; not a DEU calculation' },
    { category: 'expense', label: 'Copy service / filing', shape: 'quantity', quantity: 1, unit_amount: 140,
      basis_note: 'EAMS filing + records (synthetic demo figure)' },
  ]);

  // The matching approved reserves row so the closed worksheet reads
  // 'approved' — the M3 control point, exercised at seed time.
  await supabase.from('reserves').insert({
    claim_id: id,
    medical: 2640, indemnity: 8926.65, expense: 140,
    reason: 'Final reserves at closure (stipulated award paid)',
    source: 'ADJUSTER',
    approved_by: 'adjuster@homecaretpa.com',
    created_at: closedAt,
  });

  // The symmetric link, through the real service.
  const claimLinks = require('../services/claimLinkService');
  await claimLinks.createLink(currentClaimId, id, {
    relation_type: 'prior_claim_same_worker',
    note: `Same worker (DEMO-3). 2024 right shoulder strain resolved by stipulated award; compare PR-1 findings against the ${currentClaimNumber} investigation.`,
  }, 'seed@demo');

  logger.info({ msg: 'seedDemo: prior claim linked', prior: claimNumber, current: currentClaimNumber });
}

// Seed ai_decisions rows so the admin Agents view has data on first
// load. Same rule as td_periods: direct insert, deterministic UUIDs.
async function _seedAiDecisions(claimId, idx, plan, persona) {
  const MODEL = 'claude-sonnet-4-6';
  for (let i = 0; i < plan.aiDecisions.length; i++) {
    const spec = plan.aiDecisions[i];
    const row = _buildAiDecisionRow(claimId, idx, i, spec, plan, persona, MODEL);
    await supabase.from('ai_decisions').insert(row);
  }
}

function _buildAiDecisionRow(claimId, claimIdx, decisionIdx, spec, plan, persona, MODEL) {
  // Deterministic UUID-shaped ID for re-seed idempotency.
  const id = `aaaaaaaa-aaaa-4${String(claimIdx + 1).padStart(3, '0')}-8aaa-${String(decisionIdx + 1).padStart(12, '0')}`;
  const created_at = isoDaysAgo(spec.daysOffset || 0);
  const PROMPT_MAP = {
    compensability: 'compensability_analysis',
    rfa_mtus:       'rfa_mtus_evaluation',
    cnr_pricing:    'cnr_pricing',
    msa_screening:  'msa_threshold_evaluation',
    voice_extract:  'voice_extraction',
  };
  const base = {
    id, claim_id: claimId, decision_type: spec.type,
    prompt_name: PROMPT_MAP[spec.type] || spec.type,
    model: spec.type === 'msa_screening' ? 'deterministic' : MODEL,
    input_snapshot: _buildInputSnapshot(spec.type, plan, persona),
    output_parsed:  _buildOutputParsed(spec.type, plan, persona),
    output_raw:     null,
    input_tokens:   spec.tokens?.in  ?? null,
    output_tokens:  spec.tokens?.out ?? null,
    latency_ms:     spec.latency || null,
    confidence:     _buildConfidence(spec.type, plan),
    guardrail_actions: spec.guardrails || [],
    human_decision: spec.pendingHuman ? null : _humanDecisionFor(spec.type, plan),
    human_decision_at: spec.pendingHuman ? null : isoDaysAgo(Math.max(0, (spec.daysOffset || 0) - 1)),
    created_at,
  };
  return base;
}

function _buildInputSnapshot(type, plan, persona) {
  if (type === 'compensability') return {
    bodyPart: plan.bodyPart, injuryType: plan.injuryType,
    injuryDescription: plan.description, jobTitle: persona.title,
    aww: persona.aww, tdRate: persona.tdRate, stateOfJurisdiction: 'CA',
  };
  if (type === 'rfa_mtus') return {
    requestedTreatment: plan.rfa?.desc, requestedCptCodes: [plan.rfa?.cpt],
    bodyPart: plan.bodyPart, stateOfJurisdiction: 'CA',
  };
  if (type === 'cnr_pricing') return {
    bodyPart: plan.bodyPart, stipValue: plan.settlementOffer?.stipValue,
    pdPercent: plan.pdEval?.pdPercent, wpi: plan.pdEval?.wpi,
  };
  if (type === 'msa_screening') return {
    ageAtScreening: 56, ssdiReceiving: false,
    projectedSettlementValue: plan.settlementOffer?.cnrValue || 0,
    thresholds: { MEDICARE_ELIGIBLE_SETTLEMENT: 25000, LIKELY_ELIGIBLE_SETTLEMENT: 250000, MEDICARE_AGE: 65, LIKELY_ELIGIBLE_MIN_AGE: 35 },
  };
  return {};
}

function _buildOutputParsed(type, plan, persona) {
  if (type === 'compensability') return {
    compensability:   plan.aiCompensability || 'Likely Compensable',
    compensabilityScore: plan.aiConfidence || 88,
    priority:         plan.priority || 'Medium',
    suggestedMedicalReserve:   25000,
    suggestedIndemnityReserve: 18000,
    suggestedExpenseReserve:    4500,
    redFlags:         plan.aiRedFlags || [],
  };
  if (type === 'rfa_mtus') return {
    recommendedAction: plan.rfa?.decision === 'auto_approved' ? 'auto_approve' : 'physician_review',
    mtusConsistency:   plan.rfa?.decision === 'auto_approved' ? 'consistent' : 'inconsistent',
    confidence:        plan.rfa?.decision === 'auto_approved' ? 92 : 64,
  };
  if (type === 'cnr_pricing') return {
    cnrValueLow:  Math.round((plan.settlementOffer?.cnrValue || 0) * 0.85),
    cnrValueMid:  plan.settlementOffer?.cnrValue || 0,
    cnrValueHigh: Math.round((plan.settlementOffer?.cnrValue || 0) * 1.20),
    recommendation: 'adjuster_review',
  };
  if (type === 'msa_screening') return {
    medicare_eligible: false, msa_required: false,
    msa_required_reason: null,
  };
  return {};
}

function _buildConfidence(type, plan) {
  if (type === 'compensability') return plan.aiConfidence || 88;
  if (type === 'rfa_mtus') return plan.rfa?.decision === 'auto_approved' ? 92 : 64;
  return null;
}

function _humanDecisionFor(type, plan) {
  if (type === 'compensability' && plan.status !== 'new_claim' && plan.status !== 'intake_complete' && plan.status !== 'under_investigation') {
    return 'accepted by adjuster@homecaretpa.com';
  }
  if (type === 'rfa_mtus' && plan.rfa?.decision === 'auto_approved') {
    return 'auto_approved (no override)';
  }
  if (type === 'cnr_pricing' && plan.settlementOffer) {
    return 'offer_accepted_by_adjuster (worker)';
  }
  return null;
}

// Resolve a tdPeriods spec into concrete dated rows. startOffset /
// endOffset are days after DOI; endOffsetFromPS is days after the
// claim's pAndSDate (typically 0 = exactly at P&S).
async function _seedTdPeriods(claimId, plan, persona) {
  const insertedIds = [];
  for (let i = 0; i < plan.tdPeriods.length; i++) {
    const spec = plan.tdPeriods[i];
    const startDaysAgo = plan.daysAgo - spec.startOffset;
    const start = dateDaysAgo(startDaysAgo);

    let end = null;
    if (spec.endOffset != null) {
      end = dateDaysAgo(plan.daysAgo - spec.endOffset);
    } else if (spec.endOffsetFromPS != null) {
      const psDays = (plan.pAndSDate || 0) - spec.endOffsetFromPS;
      end = dateDaysAgo(psDays);
    }

    const rate = persona.tdRate * (spec.weeklyRateMul || 1);
    const periodId = `tdp_demo_${claimId}_${i + 1}`;
    const reinstFrom = spec.reinstatedFromIdx != null ? insertedIds[spec.reinstatedFromIdx] : null;

    await supabase.from('td_periods').insert({
      id:                        periodId,
      claim_id:                  claimId,
      benefit_type:              spec.benefit_type,
      start_date:                start,
      end_date:                  end,
      weekly_rate:               Math.round(rate * 100) / 100,
      reason_started:            spec.reason_started,
      reason_ended:              spec.reason_ended || null,
      suspension_reason_code:    null,
      reinstated_from_period_id: reinstFrom,
      notes:                     null,
      created_at:                isoDaysAgo(startDaysAgo),
      created_by:                'system@demo',
      updated_at:                isoDaysAgo(startDaysAgo),
    });
    insertedIds.push(periodId);
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
    assigned_to: config.adjuster.email,
    priority,
    notes,
    status:      'open',
    fh_diary_id: `diy_${claimId}_${type}`,
    created_at:  new Date().toISOString(),
  });

  // MMI solicitation in flight overrides the status default: the open
  // work is the PR-4 response clock, not a generic PR-2 follow-up.
  if (plan.mmi) {
    const dueIn = Math.max(0, 30 - (plan.mmi.solicitedDaysAgo || 0));
    return [base('PR4_RESPONSE_DUE', dueIn, 'HIGH',
              `PR-4 response due from ${plan.mmi.physician} (30 calendar days from solicitation). Follow up if not received.`),
            base('TD_PAYMENT_REVIEW', 7, 'HIGH',
              'TTD continues pending the P&S determination — confirm payment continuity.')];
  }

  switch (plan.status) {
    case 'new_claim':
      return [base('DWC1_ISSUE', 1, 'HIGH', 'Issue DWC-1 claim form'),
              base('DWC7_NOTICE', 1, 'HIGH', 'Mail DWC-7 notice of rights')];
    case 'intake_complete':
      return [base('AI_ANALYSIS_PENDING', 0, 'MEDIUM', 'Run AI compensability analysis')];
    case 'under_investigation':
      // Corrected model: accept/deny/delay within 14 calendar days of
      // claim form receipt. The seed's receipt day is daysAgo, so the
      // diary lands at (14 - daysAgo) from today. The 90-day diary only
      // exists after an explicit delay decision.
      return [{
        ...base('COMPENSABILITY_NOTICE_DUE', 14 - plan.daysAgo, 'CRITICAL',
          'Accept, deny, or delay within 14 calendar days of claim form receipt. ' +
          'A delay issues the delay notice and sets the final decision on the LC §5402 presumption date (90 calendar days from claim form receipt).'),
        statutory_deadline: inDays(14 - plan.daysAgo),
        no_snooze: true,
      }];
    case 'accepted':
      return [base('TD_PAYMENT_REVIEW', 2, 'HIGH',
                'Biweekly TD payment due — confirm issuance within the LC §4650 window.'),
              base('PR2_FOLLOW_UP', 10, 'MEDIUM',
                'First PR-2 due from treating physician — confirm treatment trajectory.')];
    case 'active_medical':
      return [base('PR2_FOLLOW_UP', 14, 'MEDIUM', 'Follow up on next PR-2 from treating physician'),
              base('TD_PAYMENT_REVIEW', 14, 'HIGH', 'Confirm TD payment continuity')];
    case 'future_medical_only':
      return [base('PR2_FOLLOW_UP', 30, 'LOW',
                'Future-medical check-in — confirm continuing care remains related and necessary.')];
    case 'litigated':
      return [base('LEGAL_REVIEW', 5, 'HIGH',
                'Review Application for Adjudication and prepare the MSC position with defense counsel.'),
              base('QME_REPORT_REVIEW', 21, 'MEDIUM',
                'QME evaluation pending on the disputed body part — calendar the report due date.')];
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

// ── Demo documents ───────────────────────────────────────────────────────────
// Every incoming document is ingested, labeled, and summarized — the drawer
// links the original next to its AI summary so the adjuster never has to
// hunt for source material behind a queued decision.
function _buildDocuments(claimId, idx, plan) {
  const doc = (slug, offset, fields) => ({
    id:          `doc_demo_${claimId}_${slug}`,
    claim_id:    claimId,
    received_at: isoDaysAgo(offset),
    source:      'inbound_mail',
    pages:       fields.pages || 2,
    status:      'filed',
    classification_confidence: fields.classification_confidence ?? 88 + (offset % 10),
    classification_model: SEED_MODEL,
    triage_status: 'none',
    version:     1,
    created_at:  isoDaysAgo(offset),
    ...fields,
  });

  const common = [
    doc('froi', plan.daysAgo, {
      title: 'DWC-1 / First Report of Injury', category: 'state_form', source: 'employer', pages: 3,
      ai_summary: 'Employer first report. Injury reported same day; mechanism consistent with the worker statement. No witnesses listed; employer does not contest.',
      relevant_to: ['DWC1_ISSUE', 'COMPENSABILITY_NOTICE_DUE'],
    }),
  ];

  // MMI solicitation in flight: the file shows the plateau PR-2 that
  // triggered the evaluation and the outbound PR-4 solicitation letter.
  if (plan.mmi) {
    return [...common,
      doc('pr2_plateau', 14, {
        title: 'PR-2 progress report — plateau', category: 'medical', source: 'provider', pages: 4,
        ai_summary: 'Treating physician progress report. Worker described as stable and at plateau; PT transitioned to a home exercise program; no further functional improvement expected. Remains TTD pending a P&S determination.',
        relevant_to: ['TD_PAYMENT_REVIEW'],
      }),
      doc('pr4_solicitation', plan.mmi.solicitedDaysAgo, {
        title: 'PR-4 solicitation letter — sent to PTP', category: 'correspondence', source: 'internal', pages: 2,
        ai_summary: `PR-4 solicitation letter generated and mailed to ${plan.mmi.physician}. Requests a P&S determination with WPI, work restrictions, future medical, and apportionment. Response due 30 calendar days from solicitation.`,
        relevant_to: ['PR4_RESPONSE_DUE'],
      })];
  }

  switch (plan.status) {
    case 'new_claim':
      return common;
    case 'intake_complete':
      return [...common, doc('intake_media', plan.daysAgo - 1, {
        title: 'Worker intake — voice transcript & photos', category: 'correspondence', source: 'employee_portal',
        ai_summary: 'Voice intake transcript (Spanish, auto-translated). Worker describes lifting injury during patient transfer; photos of the work area attached. Extraction confidence high; all fields pending human verification.',
        relevant_to: ['AI_ANALYSIS_PENDING'],
      })];
    case 'under_investigation':
      return [...common,
        doc('med_initial', plan.daysAgo - 3, {
          title: 'Initial treating physician report (PR-1)', category: 'medical', source: 'provider', pages: 6,
          ai_summary: 'First visit report. Dx: right shoulder strain/sprain. Objective findings: reduced active ROM in abduction and forward flexion, positive impingement signs, tenderness over the supraspinatus. Work restrictions: limited overhead reach, no lifting >10 lbs for 2 weeks. Causation attributed to the reported incident.',
          relevant_to: ['COMPENSABILITY_NOTICE_DUE'],
        }),
        doc('wage_stmt', plan.daysAgo - 2, {
          title: 'Wage statement (12 months)', category: 'wage', source: 'employer',
          ai_summary: 'Payroll export covering 52 weeks. Supports the calculated AWW; two unpaid gaps consistent with scheduled leave, not disputed time.',
          relevant_to: ['COMPENSABILITY_NOTICE_DUE'],
        })];
    case 'accepted':
      return [...common,
        doc('pr1', plan.daysAgo - 4, {
          title: 'Initial treating physician report (PR-1)', category: 'medical', source: 'provider', pages: 5,
          ai_summary: 'First visit report. Dx: left ankle inversion sprain, grade II. Objective findings: lateral swelling, tenderness over the ATFL, antalgic gait. Off work 2 weeks, then re-evaluate. Causation attributed to the reported fall.',
          relevant_to: ['PR2_FOLLOW_UP'],
        }),
        doc('work_status', plan.daysAgo - 4, {
          title: 'Work status report — off work', category: 'work_status', source: 'provider', pages: 1,
          ai_summary: 'Off-work order through the next re-evaluation; TTD supported at the current rate. No modified duty available per the employer.',
          relevant_to: ['TD_PAYMENT_REVIEW'],
        })];
    case 'future_medical_only':
      return [...common,
        doc('rtw_release', plan.daysAgo - 41, {
          title: 'Work status report — full duty release', category: 'work_status', source: 'provider', pages: 1,
          ai_summary: 'Full-duty release with no restrictions; TD ended on the release date. Future flare-up care to remain available under the stipulated award.',
          relevant_to: [],
        }),
        doc('pr2_maint', 30, {
          title: 'PR-2 progress report — PRN flare-up visit', category: 'medical', source: 'provider', pages: 3,
          ai_summary: 'PRN visit for a right wrist flare-up; splint refit and home program reviewed. No work restrictions; treatment remains within the future-medical scope of the award.',
          relevant_to: ['PR2_FOLLOW_UP'],
        })];
    case 'litigated':
      return [...common,
        doc('atty_rep', 40, {
          title: 'Notice of representation — applicant attorney', category: 'legal', source: 'attorney', pages: 2,
          ai_summary: 'Applicant retained counsel; all contact through counsel going forward. Representation change processed and benefit notices redirected.',
          relevant_to: ['LEGAL_REVIEW'],
        }),
        doc('application', 30, {
          title: 'Application for Adjudication of Claim (WCAB)', category: 'legal', source: 'attorney', pages: 4,
          ai_summary: 'WCAB application filed. Disputes the denied add-on right shoulder body part and the TD rate; venue Los Angeles. Answer due and a QME panel request expected.',
          relevant_to: ['LEGAL_REVIEW'],
        })];
    case 'active_medical':
      return [...common,
        doc('pr2', 4, {
          title: 'PR-2 progress report', category: 'medical', source: 'provider', pages: 4,
          ai_summary: 'Treating physician progress report. Symptoms improving with PT; remains TTD. Next re-evaluation in 3 weeks. No new body parts claimed.',
          relevant_to: ['TD_PAYMENT_REVIEW'],
        }),
        doc('work_status', 2, {
          title: 'Work status report', category: 'work_status', source: 'provider', pages: 1,
          ai_summary: 'Off-work order extended 21 days. TTD continues at the current rate; no modified-duty release offered by the employer yet.',
          relevant_to: ['TD_PAYMENT_REVIEW'],
        })];
    case 'p_and_s':
    case 'pd_evaluation':
      return [...common,
        doc('pr4', 6, {
          title: 'PR-4 permanent & stationary report', category: 'medical', source: 'provider', pages: 9,
          ai_summary: 'P&S report. WPI 8% lumbar spine with apportionment 90/10 industrial. Future medical: PRN flare-ups. Supports moving to PD rating.',
          relevant_to: ['PD_ADVANCE_DUE'],
        }),
        doc('qme_panel', 10, {
          title: 'QME panel assignment letter', category: 'legal', source: 'dwc', pages: 2,
          ai_summary: 'Panel issued in orthopedic surgery. Strike deadline computed and diarised; two panelists within 30 miles of the worker.',
          relevant_to: ['PD_ADVANCE_DUE'],
        })];
    case 'settlement_discussions':
      return [...common,
        doc('cnr_draft', 3, {
          title: 'Draft Compromise & Release (DWC-CA 10214c)', category: 'settlement', source: 'internal', pages: 12,
          ai_summary: 'C&R draft at the agent-priced value inside the 1.15×–5.0× stipulated band. MSA screen: no Medicare interest (worker under 65, no SSDI application). Open issue: future medical buyout language.',
          relevant_to: ['CNR_OFFER_FOLLOWUP', 'CNR_ADJUSTER_SIGN'],
        }),
        doc('atty_letter', 5, {
          title: 'Applicant attorney correspondence', category: 'legal', source: 'attorney', pages: 2,
          ai_summary: 'Counsel acknowledges the offer and requests the MSA screening basis. Tone cooperative; counter expected within two weeks. Reminder: worker is represented — all contact through counsel.',
          relevant_to: ['CNR_OFFER_FOLLOWUP'],
        }),
        doc('pr4', 12, {
          title: 'PR-4 permanent & stationary report', category: 'medical', source: 'provider', pages: 9,
          ai_summary: 'P&S report underlying the rating. WPI 8% with standard apportionment; future medical limited to PRN care — priced into the C&R.',
          relevant_to: ['CNR_OFFER_FOLLOWUP'],
        })];
    default:
      return common;
  }
}

module.exports = { PERSONAS, EMPLOYER_BRIGHTCARE, EMPLOYER_WESTSIDE,
  LIFECYCLE_PLANS, isoDaysAgo, dateDaysAgo, makeClaimId, makeClaimNumber,
  seedDemo, wipeDemo };
