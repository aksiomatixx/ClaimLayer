'use strict';

/**
 * demoData.js — the demo book's personas, lifecycle plans, and
 * deterministic ID helpers, extracted so they can be shared between
 * the seeder (seedDemo.js) and the test-document generator
 * (generateTestDocuments.js) WITHOUT pulling in the service/config
 * chain. This module must stay dependency-free: the generator runs
 * offline with no backend environment.
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
  { first: 'Aisha',   last: 'Thompson', phone: '(310) 555-0109', dob: '1987-05-21', title: 'Home Health Aide II',     employer: EMPLOYER_BRIGHTCARE, aww: 760.50, tdRate: 507.00 },
  { first: 'Daniel',  last: 'Kim',      phone: '(213) 555-0110', dob: '1979-08-03', title: 'LVN Home Health',         employer: EMPLOYER_WESTSIDE,   aww: 1010.00, tdRate: 673.33 },
  { first: 'Sofia',   last: 'Alvarez',  phone: '(818) 555-0111', dob: '1992-10-11', title: 'Home Health Aide I',      employer: EMPLOYER_BRIGHTCARE, aww: 665.00, tdRate: 443.33 },
  { first: 'Grace',   last: 'Okafor',   phone: '(310) 555-0112', dob: '1975-02-27', title: 'Registered Nurse',        employer: EMPLOYER_WESTSIDE,   aww: 1395.00, tdRate: 930.00 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString();
}
function dateDaysAgo(n) {
  return isoDaysAgo(n).split('T')[0];
}
// Sequence number 9 is reserved: 'claim_demo_009' / 'HHW-2024-D09' is
// the linked 2024 prior Rosa Mendez claim (CL-DEMO2), so lifecycle-plan
// claims skip straight from 008 to 010.
function _seqNum(idx) {
  const n = idx + 1;
  return n >= 9 ? n + 1 : n;
}
function makeClaimId(idx) {
  return `claim_demo_${String(_seqNum(idx)).padStart(3, '0')}`;
}
function makeClaimNumber(idx) {
  const year = new Date().getFullYear();
  return `HHW-${year}-D${String(_seqNum(idx)).padStart(2, '0')}`;
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
    description: 'Right shoulder pain reported next morning; no witnesses. Worker had a prior right shoulder injury resolved by stipulated award under linked claim HHW-2024-D09 (DOI 2024).',
    priority: 'High',
    aiCompensability: 'Questionable', aiConfidence: 62,
    aiRationale: 'Synthetic demo rationale: the reported mechanism (overhead reach during a patient transfer) is consistent with a right shoulder strain, and the PR-1 attributes causation to the incident. Confidence is reduced because the injury was reported the next morning with no witnesses, and the file shows a prior right shoulder claim for the same worker (HHW-2024-D09, resolved by stipulated award). Recommend completing the investigation before the initial 14-day decision: pull the linked 2024 file, compare the PR-1 findings, and obtain the supervisor statement.',
    aiRedFlags: ['No witnesses to mechanism', 'Prior right shoulder treatment under linked claim HHW-2024-D09'],
    reserveWorksheet: [
      { category: 'medical', label: 'PTP office visits', shape: 'quantity', quantity: 5, unit_amount: 250,
        basis_note: 'PTP visits per PR-1 treatment plan (synthetic demo estimate)' },
      { category: 'medical', label: 'MRI — right shoulder', shape: 'quantity', quantity: 1, unit_amount: 1400,
        basis_note: 'Ordered if symptoms persist past 4 weeks (synthetic demo estimate, not a fee-schedule figure)' },
      { category: 'medical', label: 'Physical therapy sessions', shape: 'quantity', quantity: 12, unit_amount: 125,
        basis_note: '2x/week for 6 weeks per PR-1 plan (synthetic demo estimate)' },
      { category: 'medical', label: 'Pharmacy allowance', shape: 'flat', flat_amount: 600,
        basis_note: 'NSAIDs + muscle relaxant course (synthetic demo allowance)' },
      { category: 'indemnity', label: 'Temporary disability', shape: 'weeks_rate', quantity: 6, unit_amount: 414,
        basis_note: 'Estimated 6 weeks TD at the claim TD rate (synthetic demo estimate)' },
      { category: 'indemnity', label: 'Estimated permanent disability', shape: 'flat', flat_amount: 7500,
        basis_note: 'SYNTHETIC DEMO ESTIMATE — placeholder PD dollars pending rating; not a statutory or DEU figure' },
      { category: 'expense', label: 'Copy service / record retrieval', shape: 'quantity', quantity: 2, unit_amount: 85,
        basis_note: 'Prior treatment records retrieval (synthetic demo estimate)' },
    ],
    aiDecisions: [
      { type: 'compensability', tokens: { in: 800, out: 600 }, latency: 3500, daysOffset: 7, guardrails: [] },
    ],
  },
  {
    persona: 3, status: 'active_medical',      daysAgo: 21,
    bodyPart: 'Knee',                          injuryType: 'Slip & Fall',
    description: 'Slipped on wet floor in patient bathroom; right knee twisted, immediate swelling.',
    priority: 'Medium',
    aiCompensability: 'Likely Compensable', aiConfidence: 88,
    rfa: { decision: 'auto_approved', cpt: '97110', desc: 'Therapeutic exercise, 12 visits' },
    // 3-day waiting period per LC §4652. One open TTD period.
    tdPeriods: [{ benefit_type: 'TTD', startOffset: 3, endOffset: null, reason_started: 'initial_disability' }],
    aiDecisions: [
      { type: 'compensability', tokens: { in: 800, out: 600 }, latency: 3500, daysOffset: 20, guardrails: [] },
      { type: 'rfa_mtus',       tokens: { in: 600, out: 400 }, latency: 2200, daysOffset: 18,
        guardrails: [{ rule: 'no_auto_deny', triggered: false }] },
    ],
  },
  {
    persona: 4, status: 'active_medical',      daysAgo: 28,
    bodyPart: 'Cervical Spine / Neck',         injuryType: 'Motor Vehicle',
    description: 'Rear-ended while driving home health route; immediate neck stiffness, EMS evaluated on scene.',
    priority: 'High',
    aiCompensability: 'Likely Compensable', aiConfidence: 91,
    aiRedFlags: ['SUBROGATION_POTENTIAL — third-party vehicle involved'],
    subrogationStatus: 'under_evaluation',
    // 'pending_adjuster_review' is the decision value the live agent
    // writes when it routes to a human — it is what the RFA queue
    // filters on, so the seeded queue shows one waiting decision.
    rfa: { decision: 'pending_adjuster_review', cpt: '72141', desc: 'MRI cervical spine without contrast',
           physician: 'Anita Krishnan, M.D.' },
    tdPeriods: [{ benefit_type: 'TTD', startOffset: 3, endOffset: null, reason_started: 'initial_disability' }],
    aiDecisions: [
      { type: 'compensability', tokens: { in: 800, out: 600 }, latency: 3500, daysOffset: 27, guardrails: [] },
      // RFA still pending adjuster review — no human_decision yet.
      // daysOffset 2 matches the fresh seeded RFA (UR clock open).
      { type: 'rfa_mtus',       tokens: { in: 600, out: 400 }, latency: 2200, daysOffset: 2,
        guardrails: [{ rule: 'no_auto_deny', triggered: false }],
        pendingHuman: true },
    ],
  },
  {
    persona: 5, status: 'p_and_s',             daysAgo: 47,
    bodyPart: 'Lumbar Spine / Lower Back',     injuryType: 'Lifting Injury',
    description: 'Lumbar strain from patient lift; conservative care; treating physician declared P&S last week.',
    priority: 'Medium',
    aiCompensability: 'Likely Compensable',  aiConfidence: 86,
    pAndSDate: 4,
    // Closed TTD ending at the P&S date.
    tdPeriods: [{ benefit_type: 'TTD', startOffset: 3, endOffsetFromPS: 0, reason_started: 'initial_disability', reason_ended: 'mmi_reached' }],
    aiDecisions: [
      { type: 'compensability', tokens: { in: 800, out: 600 }, latency: 3500, daysOffset: 46, guardrails: [] },
    ],
  },
  {
    persona: 6, status: 'pd_evaluation',       daysAgo: 55,
    bodyPart: 'Shoulder',                      injuryType: 'Repetitive Motion',
    description: 'Right shoulder impingement from repetitive overhead patient transfers; PR-4 received with WPI.',
    priority: 'Medium',
    aiCompensability: 'Likely Compensable',  aiConfidence: 89,
    pAndSDate: 12,
    pdEval: { wpi: 10, pdPercent: 16, pdWeeks: 48, pdWeeklyRate: 290, pdTotalValue: 13920 },
    // (a) TTD doi+3 → doi+30 (rtw_modified). (b) TPD doi+31 → P&S (mmi).
    tdPeriods: [
      { benefit_type: 'TTD', startOffset: 3, endOffset: 30, reason_started: 'initial_disability',  reason_ended: 'rtw_modified' },
      { benefit_type: 'TPD', startOffset: 31, endOffsetFromPS: 0, weeklyRateMul: 0.6, reason_started: 'benefit_type_change', reason_ended: 'mmi_reached' },
    ],
    aiDecisions: [
      { type: 'compensability', tokens: { in: 800, out: 600 }, latency: 3500, daysOffset: 54, guardrails: [] },
    ],
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
    // (a) TTD doi+3 → doi+25 (rtw_full). (b) Reinstatement TTD
    // doi+35 → P&S (mmi). reinstated_from = (a).
    tdPeriods: [
      { benefit_type: 'TTD', startOffset: 3, endOffset: 25, reason_started: 'initial_disability', reason_ended: 'rtw_full' },
      { benefit_type: 'TTD', startOffset: 35, endOffsetFromPS: 0, reason_started: 'reinstatement', reason_ended: 'mmi_reached', reinstatedFromIdx: 0 },
    ],
    aiDecisions: [
      { type: 'compensability', tokens: { in: 800, out: 600 }, latency: 3500, daysOffset: 59, guardrails: [] },
      { type: 'cnr_pricing',    tokens: { in: 1200, out: 900 }, latency: 5800, daysOffset: 2,
        guardrails: [
          { rule: 'cnr_premium_cap_5x',     triggered: false, computed_premium: 1.30 },
          { rule: 'cnr_premium_cap_1.15x',  triggered: true,  action: 'flagged_above_premium_threshold', computed_premium: 1.30 },
        ] },
      { type: 'msa_screening',  tokens: null, latency: 1100, daysOffset: 3, guardrails: [] },
    ],
  },
  {
    // Compensability accepted; the claim's live work is TD payment
    // management — open TTD at the statutory rate, biweekly payment
    // review on the LC §4650 cadence.
    persona: 8, status: 'accepted',            daysAgo: 18,
    bodyPart: 'Ankle / Foot',                  injuryType: 'Slip & Fall',
    description: 'Rolled left ankle on exterior stairs leaving a patient home; accepted within the 14-day window. Off work per PTP; TTD running at the statutory rate.',
    priority: 'Medium',
    aiCompensability: 'Likely Compensable', aiConfidence: 90,
    tdPeriods: [{ benefit_type: 'TTD', startOffset: 3, endOffset: null, reason_started: 'initial_disability' }],
    aiDecisions: [
      { type: 'compensability', tokens: { in: 800, out: 600 }, latency: 3500, daysOffset: 16, guardrails: [] },
    ],
  },
  {
    // MMI approach: treatment has plateaued, the MMI agent recommended
    // soliciting a PR-4, the solicitation letter is out, and PD is
    // ESTIMATED on the reserve worksheet pending the rating. TTD still
    // running while the P&S determination is pending.
    persona: 9, status: 'active_medical',      daysAgo: 112,
    bodyPart: 'Lumbar Spine / Lower Back',     injuryType: 'Lifting Injury',
    description: 'Lumbar strain from a patient lift; PT course complete and recent PR-2s read "stable, at plateau." PR-4 solicited from the PTP — response pending; PD estimated on the reserve worksheet pending the rating.',
    priority: 'Medium',
    aiCompensability: 'Likely Compensable', aiConfidence: 87,
    tdPeriods: [{ benefit_type: 'TTD', startOffset: 3, endOffset: null, reason_started: 'initial_disability' }],
    mmi: {
      evaluatedDaysAgo: 9,
      solicitedDaysAgo: 6,
      physician: 'Dr. Elena Vasquez, M.D.',
      signals: [
        { type: 'pr2_stable_plateau',          weight: 2,
          description: 'Last two PR-2s describe the worker as "stable" and "at plateau" with no further functional gains expected from PT.' },
        { type: 'td_over_90_days_soft_tissue', weight: 2,
          description: 'TD paid for more than 90 days on a soft-tissue lumbar strain.' },
        { type: 'treatment_frequency_declining', weight: 1,
          description: 'RFA cadence has fallen from weekly active PT to monthly maintenance requests.' },
      ],
      rationale: 'Synthetic demo rationale: two weight-2 signals (plateau language in consecutive PR-2s, TD beyond 90 days on a soft-tissue injury) plus declining treatment frequency total weight 5 — solicit a PR-4 from the treating physician.',
    },
    reserveWorksheet: [
      { category: 'medical', label: 'PTP office visits (through P&S)', shape: 'quantity', quantity: 3, unit_amount: 250,
        basis_note: 'Remaining PTP visits to the P&S determination (synthetic demo estimate)' },
      { category: 'medical', label: 'Home exercise program transition', shape: 'quantity', quantity: 4, unit_amount: 125,
        basis_note: 'Maintenance PT taper per the last PR-2 (synthetic demo estimate)' },
      { category: 'indemnity', label: 'Temporary disability (to projected P&S)', shape: 'weeks_rate', quantity: 5, unit_amount: 673.33,
        basis_note: 'Estimated 5 more weeks TTD to the PR-4 response (synthetic demo estimate)' },
      { category: 'indemnity', label: 'Estimated permanent disability', shape: 'flat', flat_amount: 9500,
        basis_note: 'SYNTHETIC DEMO ESTIMATE — placeholder PD dollars pending the PR-4 rating; not a statutory or DEU figure' },
      { category: 'expense', label: 'PR-4 solicitation / med-legal handling', shape: 'flat', flat_amount: 450,
        basis_note: 'PR-4 report fee + handling (synthetic demo allowance)' },
    ],
    aiDecisions: [
      { type: 'compensability', tokens: { in: 800, out: 600 }, latency: 3500, daysOffset: 110, guardrails: [] },
    ],
  },
  {
    // Post-settlement posture: stipulated award paid, worker back at
    // full duty, indemnity closed — the file stays open only for the
    // future medical the stip left open.
    persona: 10, status: 'future_medical_only', daysAgo: 140,
    bodyPart: 'Wrist / Hand',                  injuryType: 'Repetitive Motion',
    description: 'Right wrist De Quervain tenosynovitis from repetitive medication preps. Resolved by stipulated award with future medical open; RTW full duty, indemnity closed, PRN flare-up care continues.',
    priority: 'Medium',
    aiCompensability: 'Likely Compensable', aiConfidence: 92,
    tdPeriods: [{ benefit_type: 'TTD', startOffset: 3, endOffset: 41, reason_started: 'initial_disability', reason_ended: 'rtw_full' }],
    aiDecisions: [
      { type: 'compensability', tokens: { in: 800, out: 600 }, latency: 3500, daysOffset: 138, guardrails: [] },
    ],
  },
  {
    // Litigated: applicant counsel filed an Application for
    // Adjudication over a disputed add-on body part. Underlying neck
    // claim accepted; modified duty RTW ended TD.
    persona: 11, status: 'litigated',          daysAgo: 95,
    bodyPart: 'Cervical Spine / Neck',         injuryType: 'Strain / Sprain',
    description: 'Cervical strain accepted; worker on modified duty. Applicant counsel filed an Application for Adjudication disputing a denied add-on right shoulder body part and the TD rate; QME panel process underway.',
    priority: 'High',
    aiCompensability: 'Likely Compensable', aiConfidence: 83,
    aiRedFlags: ['Represented — all contact through applicant counsel', 'Disputed add-on body part (right shoulder)'],
    tdPeriods: [{ benefit_type: 'TTD', startOffset: 3, endOffset: 60, reason_started: 'initial_disability', reason_ended: 'rtw_modified' }],
    aiDecisions: [
      { type: 'compensability', tokens: { in: 800, out: 600 }, latency: 3500, daysOffset: 93, guardrails: [] },
    ],
  },
];

module.exports = {
  EMPLOYER_BRIGHTCARE, EMPLOYER_WESTSIDE, PERSONAS, LIFECYCLE_PLANS,
  isoDaysAgo, dateDaysAgo, makeClaimId, makeClaimNumber,
};
