'use strict';

/**
 * cnrService.js — M14 Compromise and Release (no-MSA only).
 *
 * Workflow, mirroring pdService's stipulation lifecycle:
 *   draft → offered → accepted → signed → eams_ready → filed → oacr_received → paid
 *   draft   → rejected | withdrawn (terminal)
 *   offered → rejected | withdrawn (terminal)
 *
 * C&R is blocked when MSA is required. The pricing-time gate lives in
 * pdPricingService.priceCnr; this service re-checks at offerCnr so that an
 * MSA row written between pricing and offering still blocks the offer.
 *
 * Represented workers: attorney must receive the offer. offerCnr refuses
 * when claim.attorney_represented is true and offeredTo='worker', mirroring
 * the stip rule in pdService.sendStipToWorker.
 *
 * EAMS filing is always manual — system prepares package, adjuster files.
 * OACR = Order Approving Compromise and Release. Payment is due 30 calendar
 * days after OACR service (CCR §10880: 25 days + 5 for service). Late
 * payment triggers LC §5814 10% self-assessed penalty exposure.
 *
 * DIARY ASSIGNMENT: all CNR diaries route to system@homecaretpa.com for now,
 * matching existing stip diaries. M17B will introduce a resolveAssignee
 * utility and route the license-gated diaries (CNR_ADJUSTER_SIGN,
 * CNR_PAYMENT_DUE, and any future CNR_OFFER_DECISION) to the licensed
 * adjuster on the claim. See the M17B TODO comments at each call site.
 */

const { supabase } = require('./supabase');
const logger       = require('../logger');

// ── Lazy requires (avoid cycles) ─────────────────────────────────────────────
function _getClaimService() { return require('./claimService'); }
function _getPdPricing()    { return require('./pdPricingService'); }

// ── Valid state transitions ──────────────────────────────────────────────────
const VALID_TRANSITIONS = {
  draft:         ['offered', 'rejected', 'withdrawn'],
  offered:       ['accepted', 'rejected', 'withdrawn'],
  accepted:      ['signed'],
  signed:        ['eams_ready'],
  eams_ready:    ['filed'],
  filed:         ['oacr_received'],
  oacr_received: ['paid'],
  paid:          [],
  rejected:      [],
  withdrawn:     [],
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function _addCalendarDays(dateStr, days) {
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00'));
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

async function _fetchOffer(offerId) {
  const { data, error } = await supabase
    .from('settlement_offers').select('*').eq('id', offerId).single();
  if (error || !data) throw new Error(`Settlement offer not found: ${offerId}`);
  if (data.offer_type !== 'cnr') {
    throw new Error(`Offer ${offerId} is not a C&R offer (offer_type=${data.offer_type})`);
  }
  return data;
}

function _assertTransition(offer, nextStatus) {
  const allowed = VALID_TRANSITIONS[offer.status] || [];
  if (!allowed.includes(nextStatus)) {
    throw new Error(
      `Invalid C&R transition: ${offer.status} → ${nextStatus}`,
    );
  }
}

async function _writeEvent(claimId, type, data) {
  await supabase.from('claim_events').insert({
    claim_id: claimId, type, timestamp: new Date().toISOString(), data,
  });
}

async function _writeAuditLog(action, offerId, description, newValue) {
  try {
    await supabase.from('audit_log').insert({
      action,
      resource_type: 'settlement_offer',
      resource_id:   offerId,
      description,
      new_value:     newValue,
      user_role:     'system',
      created_at:    new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ msg: 'cnrService: audit_log write failed', err: err.message, action, offerId });
  }
}

async function _createDiary(claimId, diaryType, dueDate, priority, notes, opts = {}) {
  const row = {
    claim_id:   claimId,
    diary_type: diaryType,
    due_date:   dueDate,
    // M17B: resolveAssignee() will route CRITICAL/license-gated diaries
    // (CNR_ADJUSTER_SIGN, CNR_PAYMENT_DUE, CNR_OFFER_DECISION) to the
    // licensed adjuster on the claim instead of the system inbox.
    assigned_to: 'system@homecaretpa.com',
    priority,
    notes,
    status:      'open',
    no_snooze:   opts.noSnooze || false,
    fh_diary_id: `diy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    created_at:  new Date().toISOString(),
  };
  await supabase.from('diaries').insert(row);
  await _writeEvent(claimId, 'diary_created', {
    diaryType, dueDate, priority, noSnooze: row.no_snooze,
  });
  return row;
}

async function _closeDiary(claimId, diaryType) {
  await supabase.from('diaries')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('claim_id', claimId).eq('diary_type', diaryType).eq('status', 'open');
}

async function _closeAllOpenCnrDiaries(claimId) {
  const types = [
    'CNR_WORKER_FOLLOWUP', 'CNR_ATTORNEY_TRANSMIT',
    'CNR_ADJUSTER_SIGN', 'CNR_EAMS_FILE',
    'CNR_OACR_FOLLOWUP', 'CNR_PAYMENT_DUE',
  ];
  for (const t of types) await _closeDiary(claimId, t);
}

async function _getLatestMsaScreening(claimId) {
  const { data } = await supabase
    .from('msa_screenings').select('*').eq('claim_id', claimId)
    .order('screened_at', { ascending: false });
  return (data && data.length > 0) ? data[0] : null;
}

async function _isRepresented(claimId) {
  // Mirrors pdService.sendStipToWorker's represented check — reads the raw
  // claims row so tests can seed attorney_represented directly.
  const { data } = await supabase.from('claims').select('*').eq('id', claimId).single();
  if (!data) return false;
  return !!(
    data.attorney_represented ||
    data.attorneyName ||
    data.attorney_name ||
    data.representedBy
  );
}

async function _transitionClaimStatus(claimId, expectedFrom, newStatus, reason) {
  const { data: claim } = await supabase.from('claims').select('*').eq('id', claimId).single();
  if (!claim) return;
  if (claim.status === newStatus) return;
  if (expectedFrom && claim.status !== expectedFrom) {
    logger.warn({
      msg: 'cnrService: unexpected claim status for transition',
      claimId, expected: expectedFrom, actual: claim.status, target: newStatus,
    });
  }
  const now = new Date().toISOString();
  await supabase.from('claims')
    .update({ status: newStatus, updated_at: now }).eq('id', claimId);
  await _writeEvent(claimId, 'status_changed', {
    from: claim.status, to: newStatus, changedBy: 'system', reason,
  });
}

async function _updateOffer(offerId, patch) {
  const { data, error } = await supabase
    .from('settlement_offers').update(patch).eq('id', offerId).select().single();
  if (error) throw new Error(`cnrService: offer update failed — ${error.message}`);
  return data;
}

// ═════════════════════════════════════════════════════════════════════════════
// offerCnr — draft → offered
// ═════════════════════════════════════════════════════════════════════════════
async function offerCnr(offerId, { offeredTo }) {
  if (!['worker', 'attorney'].includes(offeredTo)) {
    throw new Error("offerCnr: offeredTo must be 'worker' or 'attorney'");
  }

  const offer = await _fetchOffer(offerId);
  _assertTransition(offer, 'offered');

  // MSA re-check (belt-and-suspenders — priceCnr also gates at pricing time)
  const msa = await _getLatestMsaScreening(offer.claim_id);
  if (!msa) {
    throw new Error('MSA_SCREENING_REQUIRED_BEFORE_CNR_OFFER');
  }
  if (msa.msa_required) {
    throw new Error('CNR_BLOCKED_MSA_REQUIRED');
  }

  // Guardrail check — refuse DONT_OFFER_CNR
  const pdPricing = _getPdPricing();
  const cmp = await pdPricing.compareOffers(offer.claim_id);
  if (cmp.flag === 'DONT_OFFER_CNR') {
    throw new Error(`CNR_BLOCKED_GUARDRAIL_${cmp.flag}: ${cmp.flagReason}`);
  }

  // Represented check — attorney must receive offers for represented workers
  const represented = await _isRepresented(offer.claim_id);
  if (represented && offeredTo === 'worker') {
    throw new Error('CNR_BLOCKED_REPRESENTED_WORKER_MUST_USE_ATTORNEY');
  }

  const now = new Date().toISOString();

  const updated = await _updateOffer(offerId, {
    status:     'offered',
    offered_at: now,
    offered_to: offeredTo,
    msa_screening_id: offer.msa_screening_id || msa.id,
    updated_at: now,
  });

  // Claim → settlement_discussions (if not already)
  await _transitionClaimStatus(
    offer.claim_id, 'pd_evaluation', 'settlement_discussions', 'C&R offered',
  );

  // Follow-up diary
  if (offeredTo === 'attorney') {
    await _createDiary(
      offer.claim_id, 'CNR_ATTORNEY_TRANSMIT',
      _addCalendarDays(now.split('T')[0], 3), 'HIGH',
      `C&R offered to attorney on ${now.split('T')[0]}. Confirm attorney receipt and schedule worker signature.`,
    );
  } else {
    await _createDiary(
      offer.claim_id, 'CNR_WORKER_FOLLOWUP',
      _addCalendarDays(now.split('T')[0], 21), 'MEDIUM',
      `C&R offered to worker on ${now.split('T')[0]}. Follow up if not signed within 21 days.`,
    );
  }

  await _writeAuditLog(
    'cnr_offered', offerId,
    `C&R offered to ${offeredTo}. Value: $${offer.cnr_value}`,
    { offeredTo, cnrValue: offer.cnr_value, msaScreeningId: msa.id },
  );
  await _writeEvent(offer.claim_id, 'cnr_offered', {
    offerId, offeredTo, cnrValue: offer.cnr_value,
  });

  logger.info({ msg: 'cnrService.offerCnr: complete', offerId, offeredTo });
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// recordWorkerAcceptance — offered → accepted
// ═════════════════════════════════════════════════════════════════════════════
async function recordWorkerAcceptance(offerId) {
  const offer = await _fetchOffer(offerId);
  _assertTransition(offer, 'accepted');

  const now = new Date().toISOString();

  const updated = await _updateOffer(offerId, {
    status:           'accepted',
    worker_signed_at: now,
    updated_at:       now,
  });

  await _closeDiary(offer.claim_id, 'CNR_WORKER_FOLLOWUP');
  await _closeDiary(offer.claim_id, 'CNR_ATTORNEY_TRANSMIT');

  // M17B: reassign CNR_ADJUSTER_SIGN to the licensed adjuster on the claim.
  await _createDiary(
    offer.claim_id, 'CNR_ADJUSTER_SIGN',
    _addCalendarDays(now.split('T')[0], 3), 'HIGH',
    'Worker signed C&R. Adjuster signature needed before EAMS filing.',
  );

  await _writeAuditLog(
    'cnr_worker_accepted', offerId, 'Worker signed C&R', { workerSignedAt: now },
  );
  await _writeEvent(offer.claim_id, 'cnr_worker_accepted', { offerId });

  logger.info({ msg: 'cnrService.recordWorkerAcceptance: complete', offerId });
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// recordAdjusterSignature — accepted → signed → eams_ready (single-step)
// ═════════════════════════════════════════════════════════════════════════════
async function recordAdjusterSignature(offerId, adjusterId) {
  const offer = await _fetchOffer(offerId);
  _assertTransition(offer, 'signed');

  const now = new Date().toISOString();

  // Single-step: signed → eams_ready.
  const updated = await _updateOffer(offerId, {
    status:              'eams_ready',
    adjuster_signed_at:  now,
    adjuster_signed_by:  adjusterId,
    eams_package_ready:  true,
    updated_at:          now,
  });

  await _closeDiary(offer.claim_id, 'CNR_ADJUSTER_SIGN');

  await _createDiary(
    offer.claim_id, 'CNR_EAMS_FILE',
    _addCalendarDays(now.split('T')[0], 7), 'HIGH',
    'C&R EAMS package ready (DWC-CA form 10214(c)). File manually at DWC. Mark filed when complete.',
  );

  await _writeAuditLog(
    'cnr_adjuster_signed', offerId,
    'Adjuster signed C&R. EAMS package ready for manual filing.',
    { adjusterId, eamsReady: true },
  );
  await _writeEvent(offer.claim_id, 'cnr_adjuster_signed', {
    offerId, adjusterId, eamsReady: true,
  });

  logger.info({ msg: 'cnrService.recordAdjusterSignature: complete', offerId });
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// recordEAMSFiled — eams_ready → filed
// ═════════════════════════════════════════════════════════════════════════════
async function recordEAMSFiled(offerId, { filedDate, filedBy }) {
  const offer = await _fetchOffer(offerId);
  _assertTransition(offer, 'filed');
  if (!filedDate) throw new Error('filedDate is required');

  const now = new Date().toISOString();

  const updated = await _updateOffer(offerId, {
    status:         'filed',
    eams_filed_at:  filedDate,
    eams_filed_by:  filedBy || null,
    updated_at:     now,
  });

  await _closeDiary(offer.claim_id, 'CNR_EAMS_FILE');

  // Judge review typically 30–45 days; no statutory deadline → MEDIUM not CRITICAL.
  await _createDiary(
    offer.claim_id, 'CNR_OACR_FOLLOWUP',
    _addCalendarDays(filedDate, 45), 'MEDIUM',
    `C&R filed with WCAB on ${filedDate}. Follow up on OACR (Order Approving C&R) if not received by due date.`,
  );

  await _writeAuditLog(
    'cnr_eams_filed', offerId, `C&R filed at WCAB on ${filedDate}`,
    { filedDate, filedBy },
  );
  await _writeEvent(offer.claim_id, 'cnr_eams_filed', { offerId, filedDate });

  logger.info({ msg: 'cnrService.recordEAMSFiled: complete', offerId, filedDate });
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// recordOACRReceived — filed → oacr_received
// ═════════════════════════════════════════════════════════════════════════════
async function recordOACRReceived(offerId, { oacrDate }) {
  const offer = await _fetchOffer(offerId);
  _assertTransition(offer, 'oacr_received');
  if (!oacrDate) throw new Error('oacrDate is required');

  const now = new Date().toISOString();

  // CCR §10880: 25 days + 5 for service = 30 effective calendar days.
  const paymentDueDate = _addCalendarDays(oacrDate, 30);

  const updated = await _updateOffer(offerId, {
    status:                'oacr_received',
    wcab_oacr_received_at: oacrDate,
    payment_due_date:      paymentDueDate,
    updated_at:            now,
  });

  await _closeDiary(offer.claim_id, 'CNR_OACR_FOLLOWUP');

  // M17B: CNR_PAYMENT_DUE reassigns to licensed adjuster (LC §5814 exposure).
  await _createDiary(
    offer.claim_id, 'CNR_PAYMENT_DUE',
    paymentDueDate, 'CRITICAL',
    `C&R PAYMENT DUE: ${paymentDueDate}. Payment must issue by this date. Late payment triggers LC §5814 10% self-assessed penalty. OACR received ${oacrDate}.`,
    { noSnooze: true },
  );

  await _writeAuditLog(
    'cnr_oacr_received', offerId,
    `OACR received on ${oacrDate}. Payment due ${paymentDueDate}.`,
    { oacrDate, paymentDueDate },
  );
  await _writeEvent(offer.claim_id, 'cnr_oacr_received', {
    offerId, oacrDate, paymentDueDate,
  });

  logger.info({
    msg: 'cnrService.recordOACRReceived: complete', offerId, oacrDate, paymentDueDate,
  });
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// recordPayment — oacr_received → paid (and claim → closed)
// ═════════════════════════════════════════════════════════════════════════════
async function recordPayment(offerId, { paidDate }) {
  const offer = await _fetchOffer(offerId);
  _assertTransition(offer, 'paid');
  if (!paidDate) throw new Error('paidDate is required');

  const now = new Date().toISOString();

  const updated = await _updateOffer(offerId, {
    status:     'paid',
    paid_at:    paidDate,
    updated_at: now,
  });

  await _closeDiary(offer.claim_id, 'CNR_PAYMENT_DUE');

  // C&R closes ALL rights to future benefits — claim → closed, NOT
  // future_medical_only. That's the structural difference from a stip.
  await _transitionClaimStatus(
    offer.claim_id, 'settlement_discussions', 'closed', 'C&R paid',
  );

  await _writeAuditLog(
    'cnr_paid', offerId, `C&R paid on ${paidDate}. Claim closed.`,
    { paidDate },
  );
  await _writeEvent(offer.claim_id, 'cnr_paid', { offerId, paidDate });

  // ── WCIS hook — M22A ──────────────────────────────────────────
  // Fire SROI PY with C&R breakdown payload, then SROI FN.
  // Both enqueued atomically; scanner batches them together.
  // Note: _transitionClaimStatus above directly updates claims.status
  // without going through claimService.updateStatus, so no
  // suppressWcisClose flag is needed — there's no competing enqueue.
  setImmediate(async () => {
    try {
      const wcis = require('./wcisTriggerService');
      await wcis.enqueueIfReportable({
        claim_id:         offer.claim_id,
        trigger_event:    'cnr_settlement_paid',
        source_service:   'cnrService',
        source_record_id: offerId,
        event_date:       paidDate,
        payload_context: {
          source:     'cnr_settlement',
          offer_id:   offerId,
          paid_date:  paidDate,
        },
      });
      await wcis.enqueueIfReportable({
        claim_id:         offer.claim_id,
        trigger_event:    'claim_closed',
        source_service:   'cnrService',
        source_record_id: offerId,
        event_date:       paidDate,
        payload_context: {
          source:             'cnr_settlement',
          offer_id:           offerId,
          closed_date:        paidDate,
          claim_status_code:  'C',
        },
      });
    } catch (err) {
      logger.error({
        msg: 'cnrService.recordPayment: WCIS hooks failed',
        offerId, err: err.message,
      });
    }
  });

  logger.info({ msg: 'cnrService.recordPayment: complete', offerId, paidDate });
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// rejectOffer / withdrawOffer — terminal
// ═════════════════════════════════════════════════════════════════════════════
async function rejectOffer(offerId, { reason }) {
  const offer = await _fetchOffer(offerId);
  _assertTransition(offer, 'rejected');
  const now = new Date().toISOString();

  const updated = await _updateOffer(offerId, {
    status:          'rejected',
    rejected_at:     now,
    rejected_reason: reason || null,
    updated_at:      now,
  });

  await _closeAllOpenCnrDiaries(offer.claim_id);

  await _writeAuditLog(
    'cnr_rejected', offerId, `C&R rejected: ${reason || 'no reason'}`,
    { reason, priorStatus: offer.status },
  );
  await _writeEvent(offer.claim_id, 'cnr_rejected', { offerId, reason });

  logger.info({ msg: 'cnrService.rejectOffer: complete', offerId });
  return updated;
}

async function withdrawOffer(offerId, { reason }) {
  const offer = await _fetchOffer(offerId);
  _assertTransition(offer, 'withdrawn');
  const now = new Date().toISOString();

  const updated = await _updateOffer(offerId, {
    status:           'withdrawn',
    withdrawn_at:     now,
    withdrawn_reason: reason || null,
    updated_at:       now,
  });

  await _closeAllOpenCnrDiaries(offer.claim_id);

  await _writeAuditLog(
    'cnr_withdrawn', offerId, `C&R withdrawn: ${reason || 'no reason'}`,
    { reason, priorStatus: offer.status },
  );
  await _writeEvent(offer.claim_id, 'cnr_withdrawn', { offerId, reason });

  logger.info({ msg: 'cnrService.withdrawOffer: complete', offerId });
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// getOfferWithTimeline
// ═════════════════════════════════════════════════════════════════════════════
async function getOfferWithTimeline(offerId) {
  const offer = await _fetchOffer(offerId);

  const { data: events } = await supabase
    .from('claim_events').select('*').eq('claim_id', offer.claim_id)
    .order('timestamp', { ascending: true });

  const cnrTypes = new Set([
    'cnr_offered', 'cnr_worker_accepted', 'cnr_adjuster_signed',
    'cnr_eams_filed', 'cnr_oacr_received', 'cnr_paid',
    'cnr_rejected', 'cnr_withdrawn',
  ]);
  const timeline = (events || [])
    .filter(e => cnrTypes.has(e.type) && (e.data?.offerId === offerId || e.data?.offer_id === offerId))
    .map(e => ({ type: e.type, timestamp: e.timestamp, data: e.data }));

  return { offer, timeline };
}

// ═════════════════════════════════════════════════════════════════════════════
// generateCnrDocument — DWC-CA form 10214(c) template NOT PROVIDED
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Generate the Compromise and Release (DWC-CA form 10214(c)) PDF for the
 * given offer. DELIBERATELY UNIMPLEMENTED — the official DWC-CA 10214(c)
 * form layout, section headings, and required release language are
 * authoritative regulatory data and must not be synthesized. Provide the
 * form and this function will be implemented; until then, callers receive
 * C&R_FORM_TEMPLATE_NOT_PROVIDED and must handle the document step manually.
 *
 * @param {string} offerId
 * @returns {Promise<Buffer>} — currently always throws
 * @throws {Error} 'C&R_FORM_TEMPLATE_NOT_PROVIDED'
 */
async function generateCnrDocument(offerId) {
  // eslint-disable-next-line no-unused-vars
  const _referenced = offerId;
  throw new Error('C&R_FORM_TEMPLATE_NOT_PROVIDED');
}

module.exports = {
  offerCnr,
  recordWorkerAcceptance,
  recordAdjusterSignature,
  recordEAMSFiled,
  recordOACRReceived,
  recordPayment,
  rejectOffer,
  withdrawOffer,
  getOfferWithTimeline,
  generateCnrDocument,
  // Exported for tests
  VALID_TRANSITIONS,
  _addCalendarDays,
};
