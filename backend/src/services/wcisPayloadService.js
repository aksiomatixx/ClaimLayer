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

// ─── EXPORTS (filled in subsequent commits) ──────────────────────
module.exports = {
  // Exports populated by later wip commits — this module is built
  // incrementally. See commit log for per-function staging.
  _loaders: { DN77_CODES, DN85_CODES, DN95_CODES, DN85_DEPRECATED },
  _internal: { _loadCsv, _parseCsvLine, _expandDn95Ranges },
  WARNINGS,
  WcisValidationError,
  CODE_LIST_VALIDATION_STATUS,
  REPORTABLE_BENEFIT_CODES,
  COMPROMISED_PD_SCHEDULED,
  COMPROMISED_MEDICAL,
  COMPROMISED_UNSPECIFIED,
  CA_DATA_EDITS,
};
