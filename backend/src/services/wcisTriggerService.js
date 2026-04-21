'use strict';

/**
 * wcisTriggerService.js — M22A WCIS EDI trigger enqueue layer.
 *
 * Service-layer hooks (claimService.createClaim,
 * pdService.recordPDAdvancePayment, cnrService.recordPayment, etc.)
 * call enqueueIfReportable({claim_id, trigger_event, ...}) after
 * their own commit. This service:
 *   1. Checks claim-level gating (wcis_enabled flag).
 *   2. Checks DOI-cutoff gating (8 CCR §9702 mandate dates).
 *   3. Checks duplicate-event suppression.
 *   4. Reroutes FROI 04 → SROI 04 when prior FROI 00 is accepted.
 *   5. Writes a wcis_trigger_queue row with computed deadline.
 *
 * wcisPayloadService.buildPayload drains the queue and assembles
 * the MTC payload. wcisTransmissionService.batchAndTransmit groups
 * assembled transactions into batches for the configured adapter.
 *
 * Exports:
 *   enqueueIfReportable  — primary entry point for hooks
 *   suppressPending      — mark a pending trigger as suppressed
 *   checkWcisEnabled     — boolean gate helper
 *   resolveMtc           — pure: trigger_event → {mtc_family,
 *                          mtc_code, deadline_type}
 *
 * All reads and writes use the Supabase service-role client.
 */

const { supabase } = require('./supabase');
const logger       = require('../logger');
const {
  TRIGGER_EVENT_TO_MTC,
  DEADLINE_TYPE_CALCULATORS,
  WCIS_MANDATE_CUTOFFS,
} = require('../constants/wcisConstants');

// Suppression reasons — string constants so tests can assert on them
// without importing copies of the literal.
const SUPPRESSION_REASONS = Object.freeze({
  WCIS_DISABLED_ON_CLAIM:     'WCIS_DISABLED_ON_CLAIM',
  DOI_BEFORE_WCIS_MANDATE:    'DOI_BEFORE_WCIS_MANDATE',
  DUPLICATE_EVENT:            'DUPLICATE_EVENT',
  BENEFIT_ALREADY_OPEN:       'BENEFIT_ALREADY_OPEN',
});

// ─── resolveMtc ──────────────────────────────────────────────────
//
// Pure function. Given a trigger_event (and optionally a
// payload_context for events that branch by context), return the
// MTC family/code/deadline_type tuple.
//
function resolveMtc({ trigger_event, payload_context }) {
  const entry = TRIGGER_EVENT_TO_MTC[trigger_event];
  if (!entry) {
    throw new Error(
      `wcisTriggerService.resolveMtc: unknown trigger_event '${trigger_event}'`,
    );
  }
  void payload_context; // reserved for future context-dependent branches
  return {
    mtc_family:    entry.mtc_family,
    mtc_code:      entry.mtc_code,
    deadline_type: entry.deadline_type,
    wired:         entry.wired,
  };
}

// ─── checkWcisEnabled ────────────────────────────────────────────
//
// Returns true if the claim is eligible for WCIS reporting. False
// if claims.wcis_enabled is explicitly FALSE.
//
async function checkWcisEnabled(claim_id) {
  const { data, error } = await supabase
    .from('claims')
    .select('wcis_enabled')
    .eq('id', claim_id)
    .single();
  if (error || !data) return false;
  // DEFAULT TRUE column — null/undefined treated as enabled
  // for claims created before the M22A retrofit.
  return data.wcis_enabled !== false;
}

// ─── suppressPending ─────────────────────────────────────────────
//
// Mark all pending/processing trigger rows matching
// (claim_id, trigger_event) as suppressed with the given reason.
// Used when a superseding event cancels an earlier enqueue
// (e.g., FROI 00 rejected → supersede pending SROIs).
//
async function suppressPending({ claim_id, trigger_event, reason }) {
  const { data, error } = await supabase
    .from('wcis_trigger_queue')
    .update({
      status:             'suppressed',
      suppression_reason: reason,
      processed_at:       new Date().toISOString(),
    })
    .eq('claim_id',      claim_id)
    .eq('trigger_event', trigger_event);

  if (error) {
    logger.error({
      msg: 'wcisTriggerService.suppressPending: update failed',
      err: error.message, claim_id, trigger_event,
    });
    return { suppressed_count: 0, error: error.message };
  }
  const count = Array.isArray(data) ? data.length : 0;
  logger.info({
    msg: 'wcisTriggerService.suppressPending',
    claim_id, trigger_event, reason, suppressed_count: count,
  });
  return { suppressed_count: count };
}

module.exports = {
  resolveMtc,
  checkWcisEnabled,
  suppressPending,
  SUPPRESSION_REASONS,
};
