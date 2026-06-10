'use strict';

/**
 * wcisConstants.js — M22A regulatory constants for California WCIS EDI.
 *
 * Authority:
 *   LC §138.6 (WCIS establishment)
 *   8 CCR §§9700-9704 (WCIS reporting rules)
 *   CA EDI Implementation Guide for FROI/SROI v3.1 (Mar 27, 2018)
 *   (docs/regulatory/wcis_edi_guide_v3.1.pdf)
 *
 * Every enumerated value carries an inline comment citing the guide
 * page/section. Do not add MTC codes, DN values, BTCs, or reason
 * codes that are not present in the authoritative guide.
 *
 * Per build constraint #6: no MTC code, DN number, benefit type
 * code, payment/adjustment code, reason code, or other regulatory
 * value may be hardcoded as a magic string in business logic. All
 * such values come from either this module or docs/regulatory/*.csv.
 */

const { addBusinessDays } = require('../utils/businessDays');

// ─── TRIGGER_EVENT_TO_MTC ─────────────────────────────────────────
//
// Full mapping from internal trigger events to WCIS Maintenance Type
// Codes. 32 entries total. Entries tagged "WIRED in M22A" have a
// service hook wired in this milestone; entries tagged "SCAFFOLDED"
// are future-proofed — payload assemblers exist but no hook wires
// the event yet.
//
// Guide references:
//   - FROI MTCs: Section N pg 86
//   - SROI MTCs: Section N pg 87
//   - Deadlines: Section L "Reporting Timeframes" pgs 78-82
//
const TRIGGER_EVENT_TO_MTC = {
  // ── WIRED in M22A ────────────────────────────────────────────────
  claim_created: {
    mtc_family: 'FROI', mtc_code: '00',
    deadline_type: 'business_days_10',
    // Guide Section N pg 86 — FROI 00 "Original"; deadline per
    // 8 CCR §9702(a)(1): 10 business days from knowledge.
    wired: true,
  },
  claim_denied_no_payment: {
    mtc_family: 'FROI', mtc_code: '04',
    deadline_type: 'business_days_10',
    // Guide Section N pg 86 — FROI 04 "Denial (no payment made)".
    wired: true,
  },
  claim_denied_after_payment: {
    mtc_family: 'SROI', mtc_code: '04',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI 04 "Denial (payment made)".
    wired: true,
  },
  pd_advance_benefit_transition: {
    mtc_family: 'SROI', mtc_code: 'CB',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI CB "Change in Benefit Type"
    // (e.g., TT → PD scheduled when TD ends and PD advances begin).
    wired: true,
  },
  pd_advance_after_suspended_td: {
    mtc_family: 'SROI', mtc_code: 'RB',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI RB "Reinstatement of Benefits".
    // Option C: RB reinstates indemnity generally; DWC trading
    // partner contact pending if WCIS rejects.
    wired: true,
  },
  pd_first_advance_as_initial: {
    mtc_family: 'SROI', mtc_code: 'IP',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI IP "Initial Payment"
    // (used when the first indemnity on a claim is a PD advance).
    wired: true,
  },
  pd_advance_paid: {
    mtc_family: 'SROI', mtc_code: 'PY',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI PY "Payment Report" (lump sum
    // or advance). Carries DN85 BTC per line.
    wired: true,
  },
  cnr_settlement_paid: {
    mtc_family: 'SROI', mtc_code: 'PY',
    deadline_type: 'business_days_15',
    // Guide Section M pg 83 — settlement payments reported via PY
    // with DN85 5xx compromised BTCs.
    wired: true,
  },
  stip_disbursement_paid: {
    mtc_family: 'SROI', mtc_code: 'PY',
    deadline_type: 'business_days_15',
    // Guide Section M pg 83 — stip F&A disbursements reported via
    // PY with DN85 5xx compromised BTCs.
    wired: true,
  },
  claim_closed: {
    mtc_family: 'SROI', mtc_code: 'FN',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI FN "Final" (claim closed,
    // no further benefits). DN73 Claim Status must = 'C' or 'X'
    // per guide Section L (enforced in _assembleSroiFn).
    wired: true,
  },
  specific_benefit_denied: {
    mtc_family: 'SROI', mtc_code: '4P',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI 4P "Specific Benefit Denied".
    wired: true,
  },
  correction_after_te: {
    mtc_family: 'SROI', mtc_code: 'CO',
    deadline_type: 'calendar_days_60',
    // Guide Section N pg 87 — SROI CO "Correction"; 60 calendar
    // days to correct a TE (accepted-with-error) ack per Section L.
    wired: true,
  },

  // ── SCAFFOLDED — no hook wired in M22A ───────────────────────────
  claim_acquired: {
    mtc_family: 'FROI', mtc_code: 'AU',
    deadline_type: 'business_days_10',
    // Guide Section N pg 86 — FROI AU "Acquired". Deferred until
    // claim-acquisition flow built.
    wired: false,
    deferral: 'Claim-acquisition flow not implemented.',
  },
  froi_data_changed: {
    mtc_family: 'FROI', mtc_code: '02',
    deadline_type: 'next_submission',
    // Guide Section N pg 86 — FROI 02 "Change". Wired by M17B for the
    // claim-reopen pathway (claimService.reopenClaim).
    wired: true, // M17B remainder milestone
  },
  froi_incomplete_fill: {
    mtc_family: 'FROI', mtc_code: '02',
    deadline_type: 'calendar_days_60',
    // Guide Section N pg 86 — FROI 02 "Change" for filling in
    // optional fields after the fact. Deferred with froi_data_changed.
    wired: false,
    deferral: 'No mechanism to detect incomplete-fill events.',
  },
  froi_cancel: {
    mtc_family: 'FROI', mtc_code: '01',
    deadline_type: 'business_days_10',
    // Guide Section N pg 86 — FROI 01 "Cancel". Deferred: no
    // cancel flow exists.
    wired: false,
    deferral: 'Claim-cancel flow not implemented.',
  },
  froi_correction: {
    mtc_family: 'FROI', mtc_code: 'CO',
    deadline_type: 'calendar_days_60',
    // Guide Section N pg 86 — FROI CO "Correction". Deferred
    // pending adjuster-facing correction UI.
    wired: false,
    deferral: 'Correction UI not implemented in M22A.',
  },

  // TD-family events — wired by the tdService completion milestone
  // (hooks live in tdPeriodsService create/close/reinstate paths).
  td_first_payment: {
    mtc_family: 'SROI', mtc_code: 'IP',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI IP.
    wired: true, // tdService completion milestone
  },
  td_acquired_first_payment: {
    mtc_family: 'SROI', mtc_code: 'AP',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI AP "Acquired / Payment".
    wired: false,
    deferral: 'Scaffolded for future tdService milestone. No hook in M22A.',
  },
  td_rate_changed: {
    mtc_family: 'SROI', mtc_code: 'CA',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI CA "Change in Benefit Amount".
    wired: true, // tdService completion milestone
  },
  td_benefit_type_changed: {
    mtc_family: 'SROI', mtc_code: 'CB',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI CB. (pdService hooks the
    // PD-from-TD variant as pd_advance_benefit_transition.)
    wired: true, // tdService completion milestone
  },
  td_suspended_rtw: {
    mtc_family: 'SROI', mtc_code: 'S1',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI S1 "Suspension, Return to Work".
    wired: true, // tdService completion milestone
  },
  td_partial_suspended_rtw: {
    mtc_family: 'SROI', mtc_code: 'P1',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI P1 "Partial Suspension, RTW".
    wired: true, // tdService completion milestone
  },
  td_suspended_med_noncomp: {
    mtc_family: 'SROI', mtc_code: 'S2',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI S2 "Suspension, Medical Noncompliance".
    wired: true, // tdService completion milestone
  },
  td_partial_suspended_med: {
    mtc_family: 'SROI', mtc_code: 'P2',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI P2.
    wired: false,
    deferral: 'Scaffolded for future tdService milestone. No hook in M22A.',
  },
  td_suspended_admin_noncomp: {
    mtc_family: 'SROI', mtc_code: 'S3',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI S3 "Suspension, Administrative".
    wired: true, // tdService completion milestone
  },
  td_partial_suspended_admin: {
    mtc_family: 'SROI', mtc_code: 'P3',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI P3.
    wired: false,
    deferral: 'Scaffolded for future tdService milestone. No hook in M22A.',
  },
  td_suspended_benefits_ex: {
    mtc_family: 'SROI', mtc_code: 'S7',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI S7 "Suspension, Benefits Exhausted".
    wired: true, // tdService completion milestone
  },
  td_reduced_earnings: {
    mtc_family: 'SROI', mtc_code: 'RE',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI RE "Reduced Earnings".
    wired: true, // tdService completion milestone
  },
  salary_continuation: {
    mtc_family: 'SROI', mtc_code: 'FS',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI FS "Full Salary Continuation".
    wired: true, // tdService completion milestone
  },

  td_reinstated: {
    mtc_family: 'SROI', mtc_code: 'RB',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI RB "Reinstatement of Benefits".
    // TD reinstated after a suspension (tdPeriodsService.reinstatePeriod).
    wired: true, // tdService completion milestone
  },

  worker_died_industrial: {
    mtc_family: 'SROI', mtc_code: 'CD',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI CD "Compensable Death".
    wired: false,
    deferral: 'Deferred to Injury Type Expansion fatal-handling milestone.',
  },
  representation_changed: {
    mtc_family: 'SROI', mtc_code: '02',
    deadline_type: 'business_days_15',
    // Guide Section N pg 87 — SROI 02 "Change" (representation
    // and other non-rate claim data changes).
    wired: true, // M17B remainder milestone — claimService.setAttorneyRepresentation
  },
};

// ─── REPORTABLE_BENEFIT_CODES — DN85 standard (non-compromised) ──
//
// Values verified against docs/regulatory/wcis_dn85_payment_adjustment.csv.
// Do not add '071' — it does not exist in the guide.
// Do not add '090' as any TD/PD alias — '090' is "Permanent Partial
// Disfigurement" (per CSV).
//
const REPORTABLE_BENEFIT_CODES = Object.freeze({
  TT:              '050', // Temporary Total — csv wcis_dn85_payment_adjustment.csv
  TP:              '070', // Temporary Partial — csv wcis_dn85_payment_adjustment.csv
  PD_SCHEDULED:    '030', // Permanent Partial Scheduled — csv wcis_dn85_payment_adjustment.csv
  PERMANENT_TOTAL: '020', // Permanent Total — csv wcis_dn85_payment_adjustment.csv
  FATAL:           '010', // Fatal — csv wcis_dn85_payment_adjustment.csv
  EMPLOYER_PAID:   '240', // Employer Paid — csv wcis_dn85_payment_adjustment.csv
});

// ─── COMPROMISED_BENEFIT_CODES — DN85 compromised (5xx) ──────────
//
// Used by settlement SROI PY assemblers. Values verified against
// docs/regulatory/wcis_dn85_payment_adjustment.csv.
//
const COMPROMISED_PD_SCHEDULED = '530'; // csv wcis_dn85_payment_adjustment.csv
const COMPROMISED_MEDICAL      = '501'; // csv wcis_dn85_payment_adjustment.csv
const COMPROMISED_UNSPECIFIED  = '500'; // csv wcis_dn85_payment_adjustment.csv

// ─── DEADLINE_TYPE_CALCULATORS ───────────────────────────────────
//
// Pure functions keyed by deadline_type. Each returns a Date.
// Reuses backend/src/utils/businessDays.js for business-day math
// (already CA-holiday-aware via Gov Code §6700).
//
function _addCalendarDays(date, n) {
  const d = typeof date === 'string'
    ? new Date(date + (date.includes('T') ? '' : 'T00:00:00Z'))
    : new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

const DEADLINE_TYPE_CALCULATORS = Object.freeze({
  // Guide Section L — 8 CCR §9702(a)(1): FROI within 10 business days.
  business_days_10: (eventDate) => addBusinessDays(eventDate, 10),
  // Guide Section L — 8 CCR §9702(a)(2): SROI within 15 business days.
  business_days_15: (eventDate) => addBusinessDays(eventDate, 15),
  // Guide Section L — TE-ack correction window: 60 calendar days.
  calendar_days_60: (eventDate) => _addCalendarDays(eventDate, 60),
  // Guide Section L — "next scheduled submission" is a no-op at
  // enqueue time; the scanner batches it into the next transmission.
  next_submission:  () => null,
});

// ─── CA_DATA_EDITS — guide Section L ─────────────────────────────
const CA_DATA_EDITS = Object.freeze({
  JURISDICTION_CODE: 'CA', // Guide Section L pg 77 — DN3.
  BLOCKLIST_STRINGS: Object.freeze([
    // Guide Section L pg 78 — "Unknown" variants rejected on M/F fields.
    'unk', 'unknown', 'dk', "don't know", 'na', 'n/a',
  ]),
  SSN_BLOCKLIST: Object.freeze([
    // Guide Section L pg 78 — DN42 rejection list.
    '123456789', '987654321',
  ]),
  // Guide Section L pg 78 — DN42 "all same digit" rejection.
  SSN_ALL_SAME_DIGIT_REGEX: /^(\d)\1{8}$/,
  // Guide Section L pg 78 — DN15 (claim admin claim number) must
  // not contain '*' or '~' (delimiter characters).
  DN15_INVALID_CHARS: Object.freeze(['*', '~']),
  // Guide Section N pg 92 — deprecated DN85 codes that should NOT
  // appear on new-origin (FROI 00) claims. Pre-2005 P&S carried
  // through FROI AU acquired claims may retain these via the
  // acquired_claim_has_pre_2005_p_and_s override.
  DEPRECATED_DN85_ON_NEW_ORIGIN: Object.freeze([
    '021', '040', '051', '080', '410', '521', '541', '540', '551', '580',
  ]),
  // Guide Section N pg 92 — voc rehab program ended 2009-01-01.
  // These are fatal on ALL transaction types (no AU override).
  // SJDB payments go to DN95 BTC 390.
  ALWAYS_DEPRECATED_DN85: Object.freeze(['410', '541']),
});

// ─── FROI_DATA_CHANGE_FIELDS ─────────────────────────────────────
//
// Fields whose mutation after FROI 00 accept should trigger FROI 02.
// Used by claimService.updateClaimData hook when that function
// exists. Not wired in M22A.
//
const FROI_DATA_CHANGE_FIELDS = Object.freeze([
  // Guide Section K — MR (mandatory reported) DNs whose change
  // requires a FROI 02 Change transaction.
  'employee_last_name',
  'employee_first_name',
  'employee_address_line_1',
  'employee_city',
  'employee_state',
  'employee_postal_code',
  'employee_date_of_birth',
  'employer_name',
  'employer_address_line_1',
  'body_part',
  'injury_type',
  'date_of_injury',
]);

// ─── CODE_LIST_VALIDATION_STATUS ─────────────────────────────────
//
// Tracks which DN code lists have authoritative CSVs committed to
// docs/regulatory/. DN35/36/37 reference WCIO code lists that
// require a paid-document license. DN73 references IAIABC Release 1.
// For NOT_VALIDATED DNs, wcisPayloadService checks format and
// blocklist only and attaches WCIS_CODE_LIST_NOT_VALIDATED warning.
//
const CODE_LIST_VALIDATION_STATUS = Object.freeze({
  DN35: 'NOT_VALIDATED_PENDING_WCIO_SOURCE',   // Nature of Injury
  DN36: 'NOT_VALIDATED_PENDING_WCIO_SOURCE',   // Part of Body
  DN37: 'NOT_VALIDATED_PENDING_WCIO_SOURCE',   // Cause of Injury
  DN73: 'NOT_VALIDATED_PENDING_IAIABC_SOURCE', // Claim Status
  DN77: 'VALIDATED', // wcis_dn77_late_reason.csv
  DN85: 'VALIDATED', // wcis_dn85_payment_adjustment.csv
  DN95: 'VALIDATED', // wcis_dn95_paid_to_date.csv
});

// ─── ENVIRONMENTS ────────────────────────────────────────────────
const ENVIRONMENTS = Object.freeze(['test', 'pilot', 'production']);

// ─── WCIS MANDATE DATE CUTOFFS ───────────────────────────────────
//
// 8 CCR §9702: FROI required for DOI ≥ 2000-03-01; SROI required
// for DOI ≥ 2000-07-01. Claims with DOI before these cutoffs are
// suppressed with reason 'DOI_BEFORE_WCIS_MANDATE'.
//
const WCIS_MANDATE_CUTOFFS = Object.freeze({
  FROI: '2000-03-01', // 8 CCR §9702(a)
  SROI: '2000-07-01', // 8 CCR §9702(a)
});

module.exports = {
  TRIGGER_EVENT_TO_MTC,
  REPORTABLE_BENEFIT_CODES,
  COMPROMISED_PD_SCHEDULED,
  COMPROMISED_MEDICAL,
  COMPROMISED_UNSPECIFIED,
  DEADLINE_TYPE_CALCULATORS,
  CA_DATA_EDITS,
  FROI_DATA_CHANGE_FIELDS,
  CODE_LIST_VALIDATION_STATUS,
  ENVIRONMENTS,
  WCIS_MANDATE_CUTOFFS,
  // Exported for tests
  _addCalendarDays,
};
