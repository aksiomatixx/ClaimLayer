'use strict';

/**
 * wcisPayloadService.js — M22A WCIS MTC payload assembly +
 * validation + IAIABC Release 1 flat-file rendering.
 *
 * Drains wcis_trigger_queue, assembles per-MTC payloads, validates
 * against CA edits (guide Section L) + structural rules (Section K)
 * + referential rules, renders IAIABC Release 1 flat-file, and
 * writes wcis_transactions rows.
 *
 * Exports:
 *   buildPayload(trigger_queue_id)      — enqueue → wcis_transactions row
 *   renderFlatFile(transaction_id)      — transactions → flat-file body
 *   validateCaEdits(payload, mtc_code)  — pre-commit validation
 *   regeneratePayload(transaction_id, {reason}) — generate CO correction
 *
 * CSVs loaded at require-time from docs/regulatory/. Throws at
 * init if any CSV is missing or has an implausible row count.
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { supabase } = require('./supabase');
const logger       = require('../logger');
const {
  REPORTABLE_BENEFIT_CODES,
  COMPROMISED_PD_SCHEDULED,
  COMPROMISED_MEDICAL,
  COMPROMISED_UNSPECIFIED,
  CA_DATA_EDITS,
  CODE_LIST_VALIDATION_STATUS,
} = require('../constants/wcisConstants');

// ─── CSV LOADING ─────────────────────────────────────────────────
//
// Each regulatory CSV in docs/regulatory/ is loaded once at module
// init. Comment-only lines (# prefix) and blank lines are stripped.
// Row counts are asserted against guide expectations; load-time
// mismatch throws hard (build constraint #1).
//
const REGULATORY_DIR = path.join(__dirname, '..', '..', '..', 'docs', 'regulatory');

function _loadCsv(filename) {
  const abs = path.join(REGULATORY_DIR, filename);
  if (!fs.existsSync(abs)) {
    throw new Error(`wcisPayloadService: regulatory CSV missing: ${abs}`);
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split(/\r?\n/);
  const rows = [];
  let header = null;
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith('#')) continue;
    const cols = _parseCsvLine(s);
    if (!header) { header = cols; continue; }
    const row = {};
    header.forEach((h, i) => { row[h] = cols[i] ?? ''; });
    rows.push(row);
  }
  return { header, rows };
}

// RFC 4180 minimal CSV parser — handles quoted fields with commas.
function _parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { inQ = false; continue; }
      cur += ch;
    } else {
      if (ch === '"') { inQ = true; continue; }
      if (ch === ',') { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function _expandDn95Ranges(rows) {
  // DN95 CSV (wcis_dn95_paid_to_date.csv) preserves range notation
  // (600-624, 650-674) verbatim per guide. Expand at load time.
  const expanded = [];
  for (const row of rows) {
    const code = row.code || '';
    const m = code.match(/^(\d+)-(\d+)$/);
    if (!m) { expanded.push(row); continue; }
    const lo = parseInt(m[1], 10);
    const hi = parseInt(m[2], 10);
    for (let n = lo; n <= hi; n++) {
      expanded.push({ ...row, code: String(n) });
    }
  }
  return expanded;
}

// Loaded at require-time. Throwing here prevents the service from
// starting with bad regulatory data.
const _dn77 = _loadCsv('wcis_dn77_late_reason.csv');
if (_dn77.rows.length < 20) {
  throw new Error(
    `wcisPayloadService: DN77 CSV row count implausible (${_dn77.rows.length} < 20)`,
  );
}
const _dn85 = _loadCsv('wcis_dn85_payment_adjustment.csv');
if (_dn85.rows.length < 25) {
  throw new Error(
    `wcisPayloadService: DN85 CSV row count implausible (${_dn85.rows.length} < 25)`,
  );
}
const _dn95raw = _loadCsv('wcis_dn95_paid_to_date.csv');
if (_dn95raw.rows.length < 20) {
  throw new Error(
    `wcisPayloadService: DN95 CSV row count implausible (${_dn95raw.rows.length} < 20)`,
  );
}
const _dn95 = { header: _dn95raw.header, rows: _expandDn95Ranges(_dn95raw.rows) };

// Stub CSVs — must have header only; any data row throws.
for (const stub of [
  'wcis_dn35_nature_of_injury.csv',
  'wcis_dn36_body_part.csv',
  'wcis_dn37_cause_of_injury.csv',
  'wcis_dn73_claim_status.csv',
]) {
  const loaded = _loadCsv(stub);
  if (loaded.rows.length > 0) {
    throw new Error(
      `wcisPayloadService: STUB_CSV_HAS_DATA — ${stub} is expected to be ` +
      `header-only until authoritative source is committed. Got ${loaded.rows.length} rows.`,
    );
  }
}

// Validated Sets — O(1) membership checks during assembly/validation.
const DN77_CODES = new Set(_dn77.rows.map((r) => r.code));
const DN85_CODES = new Set(_dn85.rows.map((r) => r.code));
const DN95_CODES = new Set(_dn95.rows.map((r) => r.code));
const DN85_DEPRECATED = new Set(
  _dn85.rows.filter((r) => r.deprecated === 'true').map((r) => r.code),
);

logger.info({
  msg: 'wcisPayloadService: CSVs loaded',
  dn77: _dn77.rows.length,
  dn85: _dn85.rows.length,
  dn85_deprecated: DN85_DEPRECATED.size,
  dn95_expanded: _dn95.rows.length,
});

// ─── WARNING / ERROR CONSTANTS ───────────────────────────────────
const WARNINGS = Object.freeze({
  CODE_LIST_NOT_VALIDATED:         'WCIS_CODE_LIST_NOT_VALIDATED',
  CNR_BREAKDOWN_PRE_OACR:          'WCIS_CNR_BREAKDOWN_PRE_OACR',
  CNR_BREAKDOWN_MISSING:           'WCIS_CNR_BREAKDOWN_MISSING',
  STIP_FUTURE_MEDICAL_NO_FN:       'WCIS_STIP_FUTURE_MEDICAL_NO_FN',
});

class WcisValidationError extends Error {
  constructor(errors, { fatal = true } = {}) {
    super(`WcisValidationError: ${errors.length} error(s)`);
    this.name   = 'WcisValidationError';
    this.errors = errors;
    this.fatal  = fatal;
  }
}

// ─── _buildBasePayload ───────────────────────────────────────────
//
// Common DNs shared across all MTCs. Returns a payload skeleton
// with claim demographics, employer, injury facts. MTC-specific
// assemblers extend this with their own DNs and benefit lines.
//
async function _buildBasePayload(claim_id, environment) {
  const { data: claim, error } = await supabase
    .from('claims')
    .select('*')
    .eq('id', claim_id)
    .single();
  if (error || !claim) {
    throw new Error(`wcisPayloadService: claim not found: ${claim_id}`);
  }

  // FEINs: prefer claim-level override, fall back to employer table.
  let insurerFein = claim.insurer_fein;
  let claimAdminFein = claim.claim_administrator_fein;
  let employerFein = claim.employer_fein;
  if (!insurerFein || !claimAdminFein || !employerFein) {
    const { data: employer } = await supabase
      .from('employers')
      .select('insurer_fein,fein,self_insured,name')
      .eq('id', claim.employer_id)
      .single();
    if (employer) {
      insurerFein = insurerFein || employer.insurer_fein;
      employerFein = employerFein || employer.fein;
      // If self-insured, employer is claim administrator.
      claimAdminFein = claimAdminFein || (employer.self_insured ? employer.fein : null);
    }
  }

  // wcis_claim_state carries JCN after FROI 00 accept.
  const { data: state } = await supabase
    .from('wcis_claim_state')
    .select('*')
    .eq('claim_id', claim_id)
    .single();

  const employee = claim.employee || {};

  return {
    _claim_id: claim_id,
    _environment: environment || 'production',

    // Jurisdiction + IDs (guide Section K)
    DN2_jurisdiction: CA_DATA_EDITS.JURISDICTION_CODE,
    DN5_jcn_or_null: (state && state.jcn) || null,
    DN6_insurer_fein: insurerFein || null,
    DN15_claim_admin_claim_number: claim.claim_number || claim_id,
    DN18_claim_administrator_fein: claimAdminFein || null,

    // Employee demographics
    DN42_employee_ssn: employee.ssn || null,
    DN43_employee_last_name: employee.last_name || employee.lastName || null,
    DN44_employee_first_name: employee.first_name || employee.firstName || null,
    DN46_employee_address_line_1: employee.address_line1 || null,
    DN47_employee_city: employee.city || null,
    DN48_employee_state: employee.state || 'CA',
    DN49_employee_postal_code: employee.postal_code || employee.zip || null,
    DN52_employee_date_of_birth: employee.dob || null,

    // Employer
    DN186_employer_name: claim.employer_name || null,
    DN187_employer_fein: employerFein || null,

    // Injury facts
    DN31_date_of_injury: claim.date_of_injury || null,
    DN35_nature_of_injury: claim.injury_type || null,
    DN36_body_part: claim.body_part || null,
    DN37_cause_of_injury: (claim.ai_analysis && claim.ai_analysis.cause) || null,

    // Financial (TD-rate / AWW — informational on FROI)
    DN64_average_weekly_wage: claim.aww != null ? String(claim.aww) : null,
    DN65_initial_temporary_disability_rate: claim.td_rate != null ? String(claim.td_rate) : null,
  };
}

// ─── FROI ASSEMBLERS ─────────────────────────────────────────────
//
// Each FROI assembler extends the base payload with MTC-specific
// DNs. Returns a payload object ready for validation.
// Guide Section N pg 86 — FROI MTC catalogue.
//

async function _assembleFroi00(base, triggerRow) {
  // FROI 00 Original — first notice of injury to WCIS.
  return {
    ...base,
    _mtc_family: 'FROI',
    _mtc_code: '00',
    DN41_date_claim_administrator_had_knowledge:
      triggerRow.event_date || base.DN31_date_of_injury,
    DN38_injury_description: (triggerRow.payload_context && triggerRow.payload_context.description) || null,
    payload_context: triggerRow.payload_context || {},
  };
}

async function _assembleFroi04(base, triggerRow) {
  // FROI 04 Denial (no payment made).
  return {
    ...base,
    _mtc_family: 'FROI',
    _mtc_code: '04',
    DN41_date_claim_administrator_had_knowledge:
      triggerRow.event_date || base.DN31_date_of_injury,
    DN289_denial_reason_code:
      (triggerRow.payload_context && triggerRow.payload_context.denial_reason_code) || null,
    DN290_denial_reason_narrative:
      (triggerRow.payload_context && triggerRow.payload_context.denial_reason) || null,
    payload_context: triggerRow.payload_context || {},
  };
}

async function _assembleFroiAu(base, triggerRow) {
  // FROI AU Acquired — book of business transfer from prior TPA.
  return {
    ...base,
    _mtc_family: 'FROI',
    _mtc_code: 'AU',
    DN41_date_claim_administrator_had_knowledge:
      triggerRow.event_date,
    DN258_acquired_claim_original_insurer_fein:
      (triggerRow.payload_context && triggerRow.payload_context.original_insurer_fein) || null,
    payload_context: triggerRow.payload_context || {},
  };
}

async function _assembleFroi01(base, triggerRow) {
  // FROI 01 Cancel — claim withdrawn (e.g., duplicate reported,
  // worker never filed).
  return {
    ...base,
    _mtc_family: 'FROI',
    _mtc_code: '01',
    DN82_cancel_reason_narrative:
      (triggerRow.payload_context && triggerRow.payload_context.cancel_reason) || null,
    payload_context: triggerRow.payload_context || {},
  };
}

async function _assembleFroi02(base, triggerRow) {
  // FROI 02 Change — changed claim data per FROI_DATA_CHANGE_FIELDS.
  return {
    ...base,
    _mtc_family: 'FROI',
    _mtc_code: '02',
    DN_changed_fields:
      (triggerRow.payload_context && triggerRow.payload_context.changed_fields) || [],
    payload_context: triggerRow.payload_context || {},
  };
}

async function _assembleFroiCo(base, triggerRow) {
  // FROI CO Correction — corrects a prior FROI that ack'd with TE.
  return {
    ...base,
    _mtc_family: 'FROI',
    _mtc_code: 'CO',
    DN_correction_of_transaction_id:
      (triggerRow.payload_context && triggerRow.payload_context.correcting_transaction_id) || null,
    DN_correction_narrative:
      (triggerRow.payload_context && triggerRow.payload_context.correction_narrative) || null,
    payload_context: triggerRow.payload_context || {},
  };
}

// ─── SROI ASSEMBLERS — core (non-PY) ─────────────────────────────
// Guide Section N pg 87 — SROI MTC catalogue.

async function _assembleSroiIp(base, triggerRow) {
  // SROI IP Initial Payment — first indemnity on a claim.
  // Benefit type depends on payload_context.benefit_code (default
  // to PD_SCHEDULED since that's the M22A-wired source from
  // pdService.recordPDAdvancePayment).
  const ctx = triggerRow.payload_context || {};
  const benefitCode = ctx.benefit_code || REPORTABLE_BENEFIT_CODES.PD_SCHEDULED;
  return {
    ...base,
    _mtc_family: 'SROI',
    _mtc_code: 'IP',
    DN34_date_disability_began: ctx.disability_begin_date || null,
    benefit_lines: [{
      DN85_benefit_type_code:       benefitCode,
      DN87_benefit_period_start:    ctx.period_start || triggerRow.event_date,
      DN88_benefit_period_end:      ctx.period_end || null,
      DN86_benefit_weekly_amount:   ctx.weekly_rate != null ? String(ctx.weekly_rate) : null,
      DN89_gross_weekly_amount_paid: ctx.amount_paid != null ? String(ctx.amount_paid) : null,
    }],
    payload_context: ctx,
  };
}

async function _assembleSroiAp(base, triggerRow) {
  // SROI AP Acquired / First Payment — first payment on an
  // acquired claim that already has prior payment history.
  const ctx = triggerRow.payload_context || {};
  return {
    ...base,
    _mtc_family: 'SROI',
    _mtc_code: 'AP',
    benefit_lines: [{
      DN85_benefit_type_code:    ctx.benefit_code || REPORTABLE_BENEFIT_CODES.TT,
      DN87_benefit_period_start: ctx.period_start || triggerRow.event_date,
      DN89_gross_weekly_amount_paid: ctx.amount_paid != null ? String(ctx.amount_paid) : null,
    }],
    payload_context: ctx,
  };
}

async function _assembleSroiCa(base, triggerRow) {
  // SROI CA Change in Benefit Amount — rate change (typically
  // annual COLA or retroactive correction).
  const ctx = triggerRow.payload_context || {};
  return {
    ...base,
    _mtc_family: 'SROI',
    _mtc_code: 'CA',
    benefit_lines: [{
      DN85_benefit_type_code:     ctx.benefit_code || REPORTABLE_BENEFIT_CODES.TT,
      DN86_benefit_weekly_amount: ctx.new_weekly_rate != null ? String(ctx.new_weekly_rate) : null,
      DN_previous_weekly_amount:  ctx.prior_weekly_rate != null ? String(ctx.prior_weekly_rate) : null,
    }],
    payload_context: ctx,
  };
}

async function _assembleSroiCb(base, triggerRow) {
  // SROI CB Change in Benefit Type — e.g., TT→PD when TD ends
  // and PD advances begin.
  const ctx = triggerRow.payload_context || {};
  return {
    ...base,
    _mtc_family: 'SROI',
    _mtc_code: 'CB',
    benefit_lines: [{
      DN85_benefit_type_code:    ctx.to_benefit_code || REPORTABLE_BENEFIT_CODES.PD_SCHEDULED,
      DN_previous_benefit_type:  ctx.from_benefit_code || null,
      DN87_benefit_period_start: ctx.period_start || triggerRow.event_date,
      DN86_benefit_weekly_amount: ctx.weekly_rate != null ? String(ctx.weekly_rate) : null,
    }],
    payload_context: ctx,
  };
}

async function _assembleSroiRe(base, triggerRow) {
  // SROI RE Reduced Earnings — worker returned to modified duty
  // with lower wages; DN95 600-624/650-674 range reporting.
  const ctx = triggerRow.payload_context || {};
  return {
    ...base,
    _mtc_family: 'SROI',
    _mtc_code: 'RE',
    benefit_lines: [{
      DN85_benefit_type_code:     ctx.benefit_code || REPORTABLE_BENEFIT_CODES.TP,
      DN86_benefit_weekly_amount: ctx.weekly_rate != null ? String(ctx.weekly_rate) : null,
      DN_reduced_earnings_code:   ctx.reduced_earnings_code || null,
      DN_reduced_earnings_amount: ctx.reduced_earnings_amount != null
        ? String(ctx.reduced_earnings_amount) : null,
    }],
    payload_context: ctx,
  };
}

async function _assembleSroiFs(base, triggerRow) {
  // SROI FS Full Salary Continuation — employer pays full salary
  // in lieu of TD. Worker receives nothing from insurer for the
  // FS period.
  const ctx = triggerRow.payload_context || {};
  return {
    ...base,
    _mtc_family: 'SROI',
    _mtc_code: 'FS',
    benefit_lines: [{
      DN85_benefit_type_code:    REPORTABLE_BENEFIT_CODES.EMPLOYER_PAID,
      DN87_benefit_period_start: ctx.period_start || triggerRow.event_date,
      DN88_benefit_period_end:   ctx.period_end || null,
    }],
    payload_context: ctx,
  };
}

// SUSPENSION_REASON_TO_MTC — maps payload_context.reason_code to the
// full suspension MTC. Guide Section N pg 87.
const SUSPENSION_REASON_TO_MTC = Object.freeze({
  rtw:                 { full: 'S1', partial: 'P1' }, // Return to Work
  med_noncomp:         { full: 'S2', partial: 'P2' }, // Medical noncompliance
  admin_noncomp:       { full: 'S3', partial: 'P3' }, // Admin noncompliance
  benefits_exhausted:  { full: 'S7', partial: 'P7' }, // Benefits exhausted
});

async function _assembleSroiSuspension(base, triggerRow) {
  // Sx/Px MTC family — triggerRow.mtc_code is already resolved
  // from trigger_event. We carry the reason and period in payload.
  const ctx = triggerRow.payload_context || {};
  return {
    ...base,
    _mtc_family: 'SROI',
    _mtc_code: triggerRow.mtc_code,
    DN57_date_return_to_work: ctx.rtw_date || null,
    benefit_lines: [{
      DN85_benefit_type_code: ctx.benefit_code || REPORTABLE_BENEFIT_CODES.TT,
      DN_suspension_reason_code: ctx.reason_code || null,
      DN_suspension_effective_date: ctx.effective_date || triggerRow.event_date,
    }],
    payload_context: ctx,
  };
}

// ─── _assembleSroiPy — settlement & advance payments ─────────────
//
// Three source variants per revised M22A spec §4:
//   source='cnr_settlement' — settlement_offers breakdown per §4.1
//   source='stip_disbursement' — award_disbursements breakdown per §4.2
//   source='pd_advance' (default) — single-line DN85 030 for PD advance
//
// Breakdown-available path for C&R:
//   Line 1: DN85 530 (compromised PD) = cnr_pd_amount
//   Line 2: DN85 501 (compromised medical) = cnr_medical_amount
//   Line 3: DN85 500 (compromised unspecified) = aa_fee + other
//
// Breakdown-unavailable / sum-mismatch path:
//   Line 1: DN85 500 (compromised unspecified) = cnr_value (full)
//   Warning: WCIS_CNR_BREAKDOWN_MISSING
//
async function _assembleSroiPy(base, triggerRow) {
  const ctx = triggerRow.payload_context || {};
  const source = ctx.source || 'pd_advance';

  if (source === 'cnr_settlement') {
    return _assembleSroiPyCnr(base, triggerRow, ctx);
  }
  if (source === 'stip_disbursement') {
    return _assembleSroiPyStip(base, triggerRow, ctx);
  }
  // Default: PD advance (single-line, scheduled BTC 030)
  return {
    ...base,
    _mtc_family: 'SROI',
    _mtc_code: 'PY',
    benefit_lines: [{
      DN85_benefit_type_code:        REPORTABLE_BENEFIT_CODES.PD_SCHEDULED,
      DN87_benefit_period_start:     ctx.period_start || triggerRow.event_date,
      DN88_benefit_period_end:       ctx.period_end   || triggerRow.event_date,
      DN89_gross_weekly_amount_paid: ctx.amount_paid != null ? String(ctx.amount_paid) : null,
    }],
    payload_context: ctx,
    _assembler_warnings: [],
  };
}

async function _assembleSroiPyCnr(base, triggerRow, ctx) {
  const { data: offer, error } = await supabase
    .from('settlement_offers')
    .select('*')
    .eq('id', ctx.offer_id)
    .single();
  if (error || !offer) {
    throw new Error(`wcisPayloadService._assembleSroiPyCnr: offer not found: ${ctx.offer_id}`);
  }

  const total = parseFloat(offer.cnr_value || '0');
  const pd    = offer.cnr_pd_amount != null ? parseFloat(offer.cnr_pd_amount) : null;
  const med   = offer.cnr_medical_amount != null ? parseFloat(offer.cnr_medical_amount) : null;
  const aa    = offer.cnr_attorney_fee_amount != null
    ? parseFloat(offer.cnr_attorney_fee_amount) : null;
  const other = offer.cnr_other_amount != null
    ? parseFloat(offer.cnr_other_amount) : null;

  const haveAll = [pd, med, aa, other].every((x) => x != null && Number.isFinite(x));
  const sum = haveAll ? (pd + med + aa + other) : null;
  const sumMatches = sum != null && Math.abs(sum - total) <= 1.00;

  const warnings = [];
  const paidDate = ctx.paid_date || triggerRow.event_date;

  if (haveAll && sumMatches) {
    // Breakdown-available: three lines
    if (offer.cnr_breakdown_source === 'estimate') {
      warnings.push({
        code: WARNINGS.CNR_BREAKDOWN_PRE_OACR,
        note: 'cnr breakdown flagged as estimate; OACR-final values not confirmed',
      });
    }
    return {
      ...base,
      _mtc_family: 'SROI',
      _mtc_code: 'PY',
      benefit_lines: [
        {
          DN85_benefit_type_code:        COMPROMISED_PD_SCHEDULED,
          DN87_benefit_period_start:     paidDate,
          DN88_benefit_period_end:       paidDate,
          DN89_gross_weekly_amount_paid: pd.toFixed(2),
        },
        {
          DN85_benefit_type_code:        COMPROMISED_MEDICAL,
          DN87_benefit_period_start:     paidDate,
          DN88_benefit_period_end:       paidDate,
          DN89_gross_weekly_amount_paid: med.toFixed(2),
        },
        {
          DN85_benefit_type_code:        COMPROMISED_UNSPECIFIED,
          DN87_benefit_period_start:     paidDate,
          DN88_benefit_period_end:       paidDate,
          DN89_gross_weekly_amount_paid: (aa + other).toFixed(2),
        },
      ],
      payload_context: ctx,
      _assembler_warnings: warnings,
    };
  }

  // Breakdown-missing / sum-mismatch fallback
  warnings.push({
    code: WARNINGS.CNR_BREAKDOWN_MISSING,
    note: haveAll
      ? `breakdown sum $${sum?.toFixed(2)} does not match cnr_value $${total.toFixed(2)}`
      : 'cnr breakdown columns not populated on settlement_offers',
    total, sum,
  });
  return {
    ...base,
    _mtc_family: 'SROI',
    _mtc_code: 'PY',
    benefit_lines: [{
      DN85_benefit_type_code:        COMPROMISED_UNSPECIFIED,
      DN87_benefit_period_start:     paidDate,
      DN88_benefit_period_end:       paidDate,
      DN89_gross_weekly_amount_paid: total.toFixed(2),
    }],
    payload_context: ctx,
    _assembler_warnings: warnings,
  };
}

async function _assembleSroiPyStip(base, triggerRow, ctx) {
  const { data: disb, error } = await supabase
    .from('award_disbursements')
    .select('*')
    .eq('id', ctx.disbursement_id)
    .single();
  if (error || !disb) {
    throw new Error(
      `wcisPayloadService._assembleSroiPyStip: disbursement not found: ${ctx.disbursement_id}`,
    );
  }

  // Read the linked stipulation for future_medical flag.
  let futureMedical = null;
  if (disb.stipulation_id) {
    const { data: stip } = await supabase
      .from('stipulations')
      .select('future_medical')
      .eq('id', disb.stipulation_id)
      .single();
    futureMedical = stip ? !!stip.future_medical : null;
  }

  const accrued   = parseFloat(disb.accrued_amount || '0');
  const scheduled = parseFloat(disb.scheduled_amount || '0');
  const aaFee     = parseFloat(disb.aa_fee_amount || '0');
  const paidDate  = ctx.paid_date || triggerRow.event_date;

  const lines = [];
  // Line 1: compromised PD scheduled = accrued + scheduled
  lines.push({
    DN85_benefit_type_code:        COMPROMISED_PD_SCHEDULED,
    DN87_benefit_period_start:     paidDate,
    DN88_benefit_period_end:       paidDate,
    DN89_gross_weekly_amount_paid: (accrued + scheduled).toFixed(2),
  });
  // Line 2: compromised unspecified = attorney fee
  if (aaFee > 0) {
    lines.push({
      DN85_benefit_type_code:        COMPROMISED_UNSPECIFIED,
      DN87_benefit_period_start:     paidDate,
      DN88_benefit_period_end:       paidDate,
      DN89_gross_weekly_amount_paid: aaFee.toFixed(2),
    });
  }

  const warnings = [];
  if (futureMedical === true) {
    // No FN will follow — signal data consumer.
    warnings.push({ code: WARNINGS.STIP_FUTURE_MEDICAL_NO_FN });
  }

  return {
    ...base,
    _mtc_family: 'SROI',
    _mtc_code: 'PY',
    benefit_lines: lines,
    payload_context: { ...ctx, future_medical: futureMedical },
    _assembler_warnings: warnings,
  };
}

// ─── VALIDATION — Layer 1: structural ────────────────────────────
//
// Checks that every required DN is present and format-valid per
// guide Section K. Field-level format:
//   - Dates: YYYY-MM-DD
//   - Money: NUMERIC, two decimal places
//   - FEINs: exactly 9 digits
//   - Claim numbers: no DN15_INVALID_CHARS
//
// Returns { valid, errors, warnings }. Caller interprets fatal.
//
function _validateStructural(payload, mtc_code) {
  const errors = [];
  const warnings = [];

  // Common required DNs for all MTCs
  const required = ['DN2_jurisdiction', 'DN5_jcn_or_null',
    'DN15_claim_admin_claim_number', 'DN31_date_of_injury'];

  for (const dn of required) {
    if (dn === 'DN5_jcn_or_null') continue; // JCN optional on FROI 00
    if (payload[dn] === undefined || payload[dn] === null || payload[dn] === '') {
      errors.push({ dn, severity: 'fatal', code: 'MISSING_REQUIRED_DN' });
    }
  }

  // DN2 must be 'CA' for HomeCare
  if (payload.DN2_jurisdiction && payload.DN2_jurisdiction !== CA_DATA_EDITS.JURISDICTION_CODE) {
    errors.push({
      dn: 'DN2_jurisdiction', severity: 'fatal', code: 'WRONG_JURISDICTION',
      got: payload.DN2_jurisdiction,
    });
  }

  // Date formats
  const dateDns = ['DN31_date_of_injury', 'DN34_date_disability_began',
    'DN57_date_return_to_work', 'DN41_date_claim_administrator_had_knowledge'];
  for (const dn of dateDns) {
    const v = payload[dn];
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      errors.push({ dn, severity: 'fatal', code: 'BAD_DATE_FORMAT', got: v });
    }
  }

  // DN15 claim admin claim number — no invalid chars
  const dn15 = payload.DN15_claim_admin_claim_number;
  if (dn15) {
    for (const bad of CA_DATA_EDITS.DN15_INVALID_CHARS) {
      if (dn15.includes(bad)) {
        errors.push({
          dn: 'DN15_claim_admin_claim_number', severity: 'fatal',
          code: 'INVALID_DELIMITER_CHAR', char: bad,
        });
      }
    }
  }

  // FEIN format — DN6, DN18, DN187 when present
  for (const dn of ['DN6_insurer_fein', 'DN18_claim_administrator_fein',
    'DN187_employer_fein']) {
    const v = payload[dn];
    if (v && !/^\d{9}$/.test(v)) {
      errors.push({ dn, severity: 'fatal', code: 'BAD_FEIN_FORMAT', got: v });
    }
  }

  void mtc_code; // reserved for MTC-specific structural rules
  return { valid: errors.length === 0, errors, warnings };
}

// ─── VALIDATION — Layer 2: CA-specific edits ─────────────────────
//
// Per guide Section L. Implements blocklist strings, SSN rules,
// DN85 deprecation, date ordering. Takes an options override for
// the AU acquired-claim pre-2005 P&S exception.
//
function _validateCaEdits(payload, mtc_code) {
  const errors = [];
  const warnings = [];

  const blockNorm = (s) =>
    String(s || '').trim().toLowerCase();

  // Blocklist strings on name / address / employer fields
  const nameFields = ['DN42_employee_ssn', 'DN43_employee_last_name',
    'DN44_employee_first_name', 'DN46_employee_address_line_1',
    'DN47_employee_city', 'DN186_employer_name'];
  for (const dn of nameFields) {
    const v = payload[dn];
    if (!v) continue;
    if (CA_DATA_EDITS.BLOCKLIST_STRINGS.includes(blockNorm(v))) {
      errors.push({
        dn, severity: 'fatal', code: 'BLOCKLIST_STRING', got: v,
      });
    }
  }

  // DN42 SSN rules
  const ssn = String(payload.DN42_employee_ssn || '').replace(/\D/g, '');
  if (ssn) {
    if (ssn.length !== 9) {
      errors.push({ dn: 'DN42_employee_ssn', severity: 'fatal', code: 'BAD_SSN_LENGTH' });
    } else if (CA_DATA_EDITS.SSN_BLOCKLIST.includes(ssn)) {
      errors.push({
        dn: 'DN42_employee_ssn', severity: 'fatal', code: 'SSN_BLOCKLISTED',
      });
    } else if (CA_DATA_EDITS.SSN_ALL_SAME_DIGIT_REGEX.test(ssn)) {
      errors.push({
        dn: 'DN42_employee_ssn', severity: 'fatal', code: 'SSN_ALL_SAME_DIGIT',
      });
    }
  }

  // DN85 deprecation — applies to payloads with benefit_lines
  // (SROI IP, PY, etc.) when mtc_code is 00/02/AU per C2/C3/C4.
  const acquiredPre2005 = !!(payload.payload_context &&
    payload.payload_context.acquired_claim_has_pre_2005_p_and_s);
  for (const line of payload.benefit_lines || []) {
    const btc = line.DN85_benefit_type_code;
    if (!btc) continue;

    // Always-deprecated (voc rehab ended 2009)
    if (CA_DATA_EDITS.ALWAYS_DEPRECATED_DN85.includes(btc)) {
      errors.push({
        dn: 'DN85_benefit_type_code', severity: 'fatal',
        code: 'DN85_ALWAYS_DEPRECATED', got: btc,
      });
      continue;
    }

    if (CA_DATA_EDITS.DEPRECATED_DN85_ON_NEW_ORIGIN.includes(btc)) {
      if (mtc_code === '00') {
        errors.push({
          dn: 'DN85_benefit_type_code', severity: 'fatal',
          code: 'DN85_DEPRECATED_ON_NEW_ORIGIN', got: btc,
        });
        continue;
      }
      if (mtc_code === 'AU' && !acquiredPre2005) {
        errors.push({
          dn: 'DN85_benefit_type_code', severity: 'fatal',
          code: 'DN85_DEPRECATED_AU_NO_OVERRIDE', got: btc,
        });
        continue;
      }
      // AU with override → allowed (preserve prior carrier reporting)
    }
  }

  // Date ordering: date_of_injury ≤ date_disability_began
  const doi = payload.DN31_date_of_injury;
  const dob = payload.DN34_date_disability_began;
  if (doi && dob && doi > dob) {
    errors.push({
      dn: 'DN34_date_disability_began', severity: 'fatal',
      code: 'DATE_DISABILITY_BEFORE_INJURY', doi, dob,
    });
  }

  // DN35/36/37/73: code list not validated — warn but don't fail
  // format check already done in structural layer.
  const unvalidatedDns = [];
  for (const dn of ['DN35_nature_of_injury', 'DN36_body_part',
    'DN37_cause_of_injury', 'DN73_claim_status_code']) {
    const v = payload[dn];
    if (v) {
      // Non-empty + no blocklist string (blocklist covered above
      // for name fields; here we just accept format-valid values).
      if (CA_DATA_EDITS.BLOCKLIST_STRINGS.includes(blockNorm(v))) {
        errors.push({
          dn, severity: 'fatal', code: 'BLOCKLIST_STRING', got: v,
        });
      } else {
        unvalidatedDns.push(dn);
      }
    }
  }
  if (unvalidatedDns.length > 0) {
    warnings.push({
      code: WARNINGS.CODE_LIST_NOT_VALIDATED,
      dns: unvalidatedDns,
      statuses: unvalidatedDns.map((d) => ({
        dn: d,
        status: CODE_LIST_VALIDATION_STATUS[d.replace(/_.*$/, '').replace(/^DN/, 'DN')]
          || CODE_LIST_VALIDATION_STATUS[d.split('_')[0]],
      })),
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ─── VALIDATION — Layer 3: referential ───────────────────────────
//
// Cross-row checks: JCN present on SROI, CB not duplicating an
// already-open benefit, FN not leaving open benefits.
//
async function _validateReferential(payload, mtc_code, mtc_family) {
  const errors = [];
  const warnings = [];

  const claim_id = payload._claim_id;
  if (!claim_id) {
    return { valid: true, errors, warnings };
  }

  // JCN required on SROI (except first SROI on acquired claim, out of scope)
  if (mtc_family === 'SROI') {
    const { data: state } = await supabase
      .from('wcis_claim_state')
      .select('jcn,open_benefit_codes')
      .eq('claim_id', claim_id)
      .single();
    const jcn = state && state.jcn;
    if (!jcn && !payload.DN5_jcn_or_null) {
      errors.push({
        dn: 'DN5_jcn_or_null', severity: 'fatal',
        code: 'SROI_REQUIRES_JCN',
      });
    }

    // DN73 FN rule per C7 — Section L
    if (mtc_code === 'FN') {
      const v = payload.DN73_claim_status_code;
      if (!['C', 'X'].includes(v)) {
        errors.push({
          dn: 'DN73_claim_status_code', severity: 'fatal',
          code: 'FN_REQUIRES_DN73_C_OR_X', got: v || null,
        });
      }
    }

    // CB: target benefit must not already be open
    if (mtc_code === 'CB') {
      const open = (state && state.open_benefit_codes) || [];
      const to = payload.payload_context && payload.payload_context.to_benefit_code;
      if (to && open.includes(to)) {
        errors.push({
          dn: 'DN85_benefit_type_code', severity: 'fatal',
          code: 'CB_BENEFIT_ALREADY_OPEN', to,
        });
      }
    }

    // FN: warn if open benefits remain
    if (mtc_code === 'FN') {
      const open = (state && state.open_benefit_codes) || [];
      if (open.length > 0) {
        warnings.push({ code: 'WCIS_FN_WITH_OPEN_BENEFITS', open_codes: open });
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ─── validateCaEdits — public entry point ────────────────────────
//
// Runs all three validation layers in order, short-circuiting on
// the first layer that produces fatal errors. Warnings accumulate
// across layers.
//
async function validateCaEdits(payload, mtc_code) {
  const mtc_family = payload._mtc_family
    || (['00', '01', '02', '04', 'AU', 'CO'].includes(mtc_code) ? 'FROI' : 'SROI');

  const warnings = [];
  const structural = _validateStructural(payload, mtc_code);
  warnings.push(...structural.warnings);
  if (!structural.valid) {
    return { valid: false, errors: structural.errors, warnings };
  }

  const caEdits = _validateCaEdits(payload, mtc_code);
  warnings.push(...caEdits.warnings);
  if (!caEdits.valid) {
    return { valid: false, errors: caEdits.errors, warnings };
  }

  const referential = await _validateReferential(payload, mtc_code, mtc_family);
  warnings.push(...referential.warnings);
  if (!referential.valid) {
    return { valid: false, errors: referential.errors, warnings };
  }

  return { valid: true, errors: [], warnings };
}

// ─── EXPORTS (filled in subsequent commits) ──────────────────────
module.exports = {
  // Exports populated by later wip commits — this module is built
  // incrementally. See commit log for per-function staging.
  validateCaEdits,
  _buildBasePayload,
  _assembleFroi00,
  _assembleFroi04,
  _assembleFroiAu,
  _assembleFroi01,
  _assembleFroi02,
  _assembleFroiCo,
  _assembleSroiIp,
  _assembleSroiAp,
  _assembleSroiCa,
  _assembleSroiCb,
  _assembleSroiRe,
  _assembleSroiFs,
  _assembleSroiSuspension,
  _assembleSroiPy,
  _assembleSroiPyCnr,
  _assembleSroiPyStip,
  SUSPENSION_REASON_TO_MTC,
  _loaders: { DN77_CODES, DN85_CODES, DN95_CODES, DN85_DEPRECATED },
  _internal: { _loadCsv, _parseCsvLine, _expandDn95Ranges,
    _validateStructural, _validateCaEdits, _validateReferential },
  WARNINGS,
  WcisValidationError,
  CODE_LIST_VALIDATION_STATUS,
  REPORTABLE_BENEFIT_CODES,
  COMPROMISED_PD_SCHEDULED,
  COMPROMISED_MEDICAL,
  COMPROMISED_UNSPECIFIED,
  CA_DATA_EDITS,
};
