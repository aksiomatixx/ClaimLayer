'use strict';

/**
 * disbursementService.js — M14.5 Award Disbursement Queue.
 *
 * Responds to a WCAB award (stip F&A or C&R OACR) by computing a
 * disbursement bundle for adjuster approval. The bundle breaks the award
 * into:
 *   - Accrued PD due now (P&S date through award service date)
 *   - Scheduled forward PD (remaining weeks × weekly rate)
 *   - Attorney fee (flat or commuted off the far end via commutationService)
 *   - LC §5800 late-payment interest (at payment time)
 *   - Net to worker after paid advances and AA fee
 *
 * Apportionment: the award is ALREADY apportioned (what the judge ordered).
 * Weekly rate is invariant under apportionment; weeks are reduced.
 *
 * Disbursement lifecycle:
 *   proposed → approved → disbursed
 *   proposed → rejected
 *   (superseded: reserved for future re-propose workflow, not written today)
 *
 * CNR ordering rule: disbursementService.recordDisbursementPayment must be
 * called AFTER cnrService.recordPayment for a C&R bundle (cnrService handles
 * the claim-status transition; we merely finalize the disbursement row).
 */

const { supabase } = require('./supabase');
const logger       = require('../logger');

// Lazy requires to break cycles.
function _getPdService()         { return require('./pdService'); }
function _getCommutationService(){ return require('./commutationService'); }

// ── DISBURSEMENT_POLICY — inline constants, matches PD_RATES_2026 pattern ────
const DISBURSEMENT_POLICY = {
  STIP_PAY_BY_DAYS:                     10,   // LC §5814
  CNR_PAY_BY_DAYS:                      30,   // CCR §10880
  APPROVAL_DIARY_LEAD_DAYS:             3,
  APPORTIONMENT_MISMATCH_THRESHOLD_PCT: 5,
  AA_FEE_UNUSUAL_LOW_PCT:               10,
  AA_FEE_UNUSUAL_HIGH_PCT:              15,
  P_AND_S_DISCREPANCY_DAYS:             3,
  CNR_PAYMENT_ORDER_WINDOW_MINUTES:     5,
  // Penalty estimate clamp — speculative pre-M17A estimate only.
  PENALTY_ESTIMATE_CAP:                 10_000,
  PENALTY_ESTIMATE_PCT:                 0.10,
};

// ── Public exports (Pass 1 scaffolds — bodies filled in Pass 2) ──────────────

async function proposeDisbursement({ claimId, awardType, stipulationId, settlementOfferId, extraction, awardDocumentId }) { // eslint-disable-line no-unused-vars
  throw new Error('NOT_IMPLEMENTED');
}

async function approveDisbursement(disbursementId, { adjusterId, notes }) { // eslint-disable-line no-unused-vars
  throw new Error('NOT_IMPLEMENTED');
}

async function rejectDisbursement(disbursementId, { adjusterId, reason }) { // eslint-disable-line no-unused-vars
  throw new Error('NOT_IMPLEMENTED');
}

async function recordDisbursementPayment(disbursementId, { paidDate, reference }) { // eslint-disable-line no-unused-vars
  throw new Error('NOT_IMPLEMENTED');
}

async function getDisbursementsForClaim(claimId) { // eslint-disable-line no-unused-vars
  throw new Error('NOT_IMPLEMENTED');
}

async function getPendingDisbursements(limit = 50) { // eslint-disable-line no-unused-vars
  throw new Error('NOT_IMPLEMENTED');
}

// ── Private helper seats (filled in Pass 2) ──────────────────────────────────
function _addCalendarDays(dateStr, days) {
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00'));
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

async function _writeAuditLog(action, resourceId, description, newValue) {
  try {
    await supabase.from('audit_log').insert({
      action,
      resource_type: 'award_disbursement',
      resource_id:   resourceId,
      description,
      new_value:     newValue,
      user_role:     'system',
      created_at:    new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ msg: 'disbursementService: audit_log write failed', err: err.message, action, resourceId });
  }
}

module.exports = {
  DISBURSEMENT_POLICY,
  proposeDisbursement,
  approveDisbursement,
  rejectDisbursement,
  recordDisbursementPayment,
  getDisbursementsForClaim,
  getPendingDisbursements,
  // Exported for tests
  _addCalendarDays,
  _writeAuditLog,
  _getPdService,
  _getCommutationService,
};
