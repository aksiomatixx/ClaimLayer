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

// ─── _hashPayloadContext ─────────────────────────────────────────
//
// Deterministic hash of payload_context for duplicate detection.
// Not cryptographically sensitive — just a stable fingerprint.
//
function _hashPayloadContext(payload_context) {
  const s = JSON.stringify(payload_context || {});
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return String(h);
}

// ─── _isBeforeWcisMandate ────────────────────────────────────────
function _isBeforeWcisMandate(mtc_family, doi) {
  if (!doi) return false;
  const cutoff = mtc_family === 'FROI'
    ? WCIS_MANDATE_CUTOFFS.FROI
    : WCIS_MANDATE_CUTOFFS.SROI;
  const doiStr = typeof doi === 'string' ? doi.slice(0, 10) : null;
  if (!doiStr) return false;
  return doiStr < cutoff;
}

// ─── _firstFroiAccepted ──────────────────────────────────────────
//
// Returns true if a prior FROI 00 has been accepted for this claim
// (per wcis_claim_state.first_froi_accepted_at).
//
async function _firstFroiAccepted(claim_id) {
  const { data } = await supabase
    .from('wcis_claim_state')
    .select('first_froi_accepted_at')
    .eq('claim_id', claim_id)
    .single();
  return !!(data && data.first_froi_accepted_at);
}

// ─── enqueueIfReportable ─────────────────────────────────────────
//
// Primary entry point. Service-layer hooks call this after their
// own commit. Returns:
//   { enqueued: true,  trigger_queue_id }
//   { enqueued: false, suppressed_reason }
//
// Suppression rules (in order):
//   1. claims.wcis_enabled=FALSE → 'WCIS_DISABLED_ON_CLAIM'
//   2. DOI before cutoff (FROI<2000-03-01 / SROI<2000-07-01)
//        → 'DOI_BEFORE_WCIS_MANDATE'
//   3. FROI 04 when FROI 00 already accepted → rerouted to SROI 04
//      (not a suppression — a conversion)
//   4. Duplicate (claim_id, mtc_code, payload_hash) within 24h in
//      non-terminal state → 'DUPLICATE_EVENT'
//   5. SROI CB when target benefit already in open_benefit_codes
//        → 'BENEFIT_ALREADY_OPEN'
//
async function enqueueIfReportable({
  claim_id,
  trigger_event,
  source_service,
  source_record_id,
  event_date,
  payload_context,
}) {
  if (!claim_id)       throw new Error('claim_id is required');
  if (!trigger_event)  throw new Error('trigger_event is required');
  if (!source_service) throw new Error('source_service is required');
  if (!event_date)     throw new Error('event_date is required');

  // Rule 1: WCIS disabled on this claim
  const enabled = await checkWcisEnabled(claim_id);
  if (!enabled) {
    logger.info({
      msg: 'wcisTriggerService: suppressed — WCIS disabled on claim',
      claim_id, trigger_event,
    });
    return { enqueued: false, suppressed_reason: SUPPRESSION_REASONS.WCIS_DISABLED_ON_CLAIM };
  }

  // Resolve MTC + deadline
  let resolved;
  try {
    resolved = resolveMtc({ trigger_event, payload_context });
  } catch (err) {
    logger.error({ msg: 'wcisTriggerService: resolveMtc failed', err: err.message });
    return { enqueued: false, suppressed_reason: 'UNKNOWN_TRIGGER_EVENT' };
  }
  let { mtc_family, mtc_code, deadline_type } = resolved;

  // Rule 2: DOI-cutoff gating — look up DOI on claim
  const { data: claim } = await supabase
    .from('claims')
    .select('date_of_injury')
    .eq('id', claim_id)
    .single();
  if (claim && _isBeforeWcisMandate(mtc_family, claim.date_of_injury)) {
    logger.info({
      msg: 'wcisTriggerService: suppressed — DOI before WCIS mandate',
      claim_id, trigger_event, doi: claim.date_of_injury,
    });
    return { enqueued: false, suppressed_reason: SUPPRESSION_REASONS.DOI_BEFORE_WCIS_MANDATE };
  }

  // Rule 3: FROI 04 rerouted to SROI 04 when FROI 00 already accepted
  if (trigger_event === 'claim_denied_no_payment' && await _firstFroiAccepted(claim_id)) {
    logger.info({
      msg: 'wcisTriggerService: FROI 04 → SROI 04 reroute (FROI 00 accepted)',
      claim_id,
    });
    trigger_event = 'claim_denied_after_payment';
    const alt = resolveMtc({ trigger_event });
    mtc_family    = alt.mtc_family;
    mtc_code      = alt.mtc_code;
    deadline_type = alt.deadline_type;
  }

  // Rule 5: BENEFIT_ALREADY_OPEN on CB
  if (mtc_code === 'CB' && payload_context?.to_benefit_code) {
    const { data: state } = await supabase
      .from('wcis_claim_state')
      .select('open_benefit_codes')
      .eq('claim_id', claim_id)
      .single();
    const open = (state && state.open_benefit_codes) || [];
    if (open.includes(payload_context.to_benefit_code)) {
      logger.info({
        msg: 'wcisTriggerService: suppressed — target benefit already open',
        claim_id, to: payload_context.to_benefit_code,
      });
      return { enqueued: false, suppressed_reason: SUPPRESSION_REASONS.BENEFIT_ALREADY_OPEN };
    }
  }

  // Compute deadline
  const calc = DEADLINE_TYPE_CALCULATORS[deadline_type];
  const deadlineDate = calc ? calc(event_date) : null;
  const deadlineStr = deadlineDate
    ? deadlineDate.toISOString().slice(0, 10)
    // next_submission: set to event_date so index scans still work
    : (typeof event_date === 'string' ? event_date.slice(0, 10) : event_date);

  // Rule 4: DUPLICATE_EVENT — same (claim_id, mtc_code, payload_hash)
  // within 24h in non-terminal status.
  const payloadHash = _hashPayloadContext(payload_context);
  const dedupeSince = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: dupes } = await supabase
    .from('wcis_trigger_queue')
    .select('id,status,payload_context,created_at')
    .eq('claim_id', claim_id)
    .eq('mtc_code', mtc_code);
  const duplicate = (dupes || []).find((row) => {
    if (['suppressed', 'abandoned', 'failed'].includes(row.status)) return false;
    if (row.created_at < dedupeSince) return false;
    return _hashPayloadContext(row.payload_context) === payloadHash;
  });
  if (duplicate) {
    logger.info({
      msg: 'wcisTriggerService: suppressed — duplicate within 24h',
      claim_id, mtc_code, existing_id: duplicate.id,
    });
    return { enqueued: false, suppressed_reason: SUPPRESSION_REASONS.DUPLICATE_EVENT };
  }

  // Insert
  const { data: inserted, error } = await supabase
    .from('wcis_trigger_queue')
    .insert({
      claim_id,
      trigger_event,
      source_service,
      source_record_id: source_record_id || null,
      mtc_family,
      mtc_code,
      event_date:
        typeof event_date === 'string' ? event_date.slice(0, 10) : event_date,
      deadline_date: deadlineStr,
      deadline_type,
      status: 'pending',
      payload_context: payload_context || null,
    })
    .select()
    .single();

  if (error) {
    logger.error({
      msg: 'wcisTriggerService: insert failed',
      err: error.message, claim_id, trigger_event,
    });
    return { enqueued: false, suppressed_reason: 'INSERT_FAILED', error: error.message };
  }

  logger.info({
    msg: 'wcisTriggerService: enqueued',
    claim_id, trigger_event, mtc_family, mtc_code,
    deadline_date: deadlineStr, trigger_queue_id: inserted.id,
  });

  return { enqueued: true, trigger_queue_id: inserted.id };
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
  enqueueIfReportable,
  resolveMtc,
  checkWcisEnabled,
  suppressPending,
  SUPPRESSION_REASONS,
  // Exported for tests
  _hashPayloadContext,
  _isBeforeWcisMandate,
  _firstFroiAccepted,
};
