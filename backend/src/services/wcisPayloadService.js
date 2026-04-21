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
