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
const config = require('../config');
const logger       = require('../logger');
const jobQueue     = require('./jobQueue');
const { isRepresented } = require('../utils/representation');
const { runInTransaction } = require('../db/unitOfWork');

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

async function _writeEvent(claimId, type, data, tx = null) {
  const row = {
    claim_id: claimId, type, timestamp: new Date().toISOString(), data,
  };
  if (tx) {
    await tx.insert('claim_events', row);
  } else {
    await supabase.from('claim_events').insert(row);
  }
}

async function _writeAuditLog(action, offerId, description, newValue, tx = null, actor = null, claimId = null) {
  await require('./benefitAudit').recordAudit({
    tx, actor, claimId,
    action:       `cnr.${action.replace(/^cnr_/, '')}`,
    entityType:   'settlement_offer',
    entityId:     offerId,
    legacyAction: action,
    description,
    newValue,
  });
}

async function _createDiary(claimId, diaryType, dueDate, priority, notes, opts = {}, tx = null) {
  const row = {
    tenant_id:   tx?.tenantId || config.tenancy.defaultTenantId,
    claim_id:    claimId,
    diary_type:  diaryType,
    due_date:    dueDate,
    assigned_to: config.adjuster.email,
    priority,
    notes,
    status:      'open',
    no_snooze:   opts.noSnooze || false,
    fh_diary_id: `diy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    created_at:  new Date().toISOString(),
  };
  if (tx) {
    await tx.insert('diaries', row);
  } else {
    await supabase.from('diaries').insert(row);
  }
  await _writeEvent(claimId, 'diary_created', {
    diaryType, dueDate, priority, noSnooze: row.no_snooze,
  }, tx);
  return row;
}

async function _closeDiary(claimId, diaryType, tx = null) {
  const patch = { status: 'completed', updated_at: new Date().toISOString() };
  if (tx) {
    await tx.update('diaries', patch, { claim_id: claimId, diary_type: diaryType, status: 'open' });
  } else {
    await supabase.from('diaries')
      .update(patch)
      .eq('claim_id', claimId).eq('diary_type', diaryType).eq('status', 'open');
  }
}

async function _closeAllOpenCnrDiaries(claimId, tx = null) {
  const types = [
    'CNR_WORKER_FOLLOWUP', 'CNR_ATTORNEY_TRANSMIT',
    'CNR_ADJUSTER_SIGN', 'CNR_EAMS_FILE',
    'CNR_OACR_FOLLOWUP', 'CNR_PAYMENT_DUE',
  ];
  for (const t of types) await _closeDiary(claimId, t, tx);
}

async function _getLatestMsaScreening(claimId) {
  const { data } = await supabase
    .from('msa_screenings').select('*').eq('claim_id', claimId)
    .order('screened_at', { ascending: false });
  return (data && data.length > 0) ? data[0] : null;
}

async function _isRepresented(claimId) {
  // Reads the raw claims row so tests can seed attorney_represented directly,
  // then applies the shared representation check (M17B).
  const { data } = await supabase.from('claims').select('*').eq('id', claimId).single();
  return isRepresented(data);
}

async function _transitionClaimStatus(claimId, expectedFrom, newStatus, reason, tx = null) {
  let claim;
  if (tx) {
    claim = await tx.selectOne('claims', { id: claimId });
  } else {
    const res = await supabase.from('claims').select('*').eq('id', claimId).single();
    claim = res.data;
  }
  if (!claim) return;
  if (claim.status === newStatus) return;
  if (expectedFrom && claim.status !== expectedFrom) {
    logger.warn({
      msg: 'cnrService: unexpected claim status for transition',
      claimId, expected: expectedFrom, actual: claim.status, target: newStatus,
    });
  }
  const now = new Date().toISOString();
  const patch = { ...require('./claimService').statusAxesPatch(newStatus, claim), updated_at: now };
  if (tx) {
    await tx.update('claims', patch, { id: claimId });
  } else {
    await supabase.from('claims').update(patch).eq('id', claimId);
  }
  await _writeEvent(claimId, 'status_changed', {
    from: claim.status, to: newStatus, changedBy: 'system', reason,
  }, tx);
}

async function _updateOffer(offerId, patch, tx = null) {
  if (tx) {
    await tx.update('settlement_offers', patch, { id: offerId });
    return tx.selectOne('settlement_offers', { id: offerId });
  }
  const { data, error } = await supabase
    .from('settlement_offers').update(patch).eq('id', offerId).select().single();
  if (error) throw new Error(`cnrService: offer update failed — ${error.message}`);
  return data;
}

// ═════════════════════════════════════════════════════════════════════════════
// offerCnr — draft → offered
// ═════════════════════════════════════════════════════════════════════════════
async function offerCnr(offerId, { offeredTo }, opts = {}) {
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

  const run = async (tx) => {
    const updated = await _updateOffer(offerId, {
      status:     'offered',
      offered_at: now,
      offered_to: offeredTo,
      msa_screening_id: offer.msa_screening_id || msa.id,
      updated_at: now,
    }, tx);

    // Claim → settlement_discussions (if not already)
    await _transitionClaimStatus(
      offer.claim_id, 'pd_evaluation', 'settlement_discussions', 'C&R offered', tx,
    );

    // Follow-up diary
    if (offeredTo === 'attorney') {
      await _createDiary(
        offer.claim_id, 'CNR_ATTORNEY_TRANSMIT',
        _addCalendarDays(now.split('T')[0], 3), 'HIGH',
        `C&R offered to attorney on ${now.split('T')[0]}. Confirm attorney receipt and schedule worker signature.`,
        {},
        tx,
      );
    } else {
      await _createDiary(
        offer.claim_id, 'CNR_WORKER_FOLLOWUP',
        _addCalendarDays(now.split('T')[0], 21), 'MEDIUM',
        `C&R offered to worker on ${now.split('T')[0]}. Follow up if not signed within 21 days.`,
        {},
        tx,
      );
    }

    await _writeAuditLog(
      'cnr_offered', offerId,
      `C&R offered to ${offeredTo}. Value: $${offer.cnr_value}`,
      { offeredTo, cnrValue: offer.cnr_value, msaScreeningId: msa.id },
      tx,
      opts.actor,
      offer.claim_id,
    );
    await _writeEvent(offer.claim_id, 'cnr_offered', {
      offerId, offeredTo, cnrValue: offer.cnr_value,
    }, tx);

    return updated;
  };

  const tenantId = offer.tenant_id || opts.tenantId;
  const updated = opts.tx
    ? await run(opts.tx)
    : await runInTransaction({ tenantId, label: 'cnr.offer' }, run);

  // Link the adjuster's decision to extend the offer back to the
  // AI cnr_pricing decision (if any) so the audit trail closes the
  // model→human loop.
  try {
    await require('./aiDecisionsService').linkHumanDecision(offer.claim_id, 'cnr_pricing', {
      human_reviewer_id: null, human_decision: `offer_accepted_by_adjuster (${offeredTo})`,
    });
  } catch { /* non-fatal */ }

  logger.info({ msg: 'cnrService.offerCnr: complete', offerId, offeredTo });
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// recordWorkerAcceptance — offered → accepted
// ═════════════════════════════════════════════════════════════════════════════
async function recordWorkerAcceptance(offerId, opts = {}) {
  const offer = await _fetchOffer(offerId);
  _assertTransition(offer, 'accepted');

  const now = new Date().toISOString();

  const run = async (tx) => {
    const updated = await _updateOffer(offerId, {
      status:           'accepted',
      worker_signed_at: now,
      updated_at:       now,
    }, tx);

    await _closeDiary(offer.claim_id, 'CNR_WORKER_FOLLOWUP', tx);
    await _closeDiary(offer.claim_id, 'CNR_ATTORNEY_TRANSMIT', tx);

    await _createDiary(
      offer.claim_id, 'CNR_ADJUSTER_SIGN',
      _addCalendarDays(now.split('T')[0], 3), 'HIGH',
      'Worker signed C&R. Adjuster signature needed before EAMS filing.',
      {},
      tx,
    );

    await _writeAuditLog(
      'cnr_worker_accepted', offerId, 'Worker signed C&R', { workerSignedAt: now },
      tx,
      opts.actor,
      offer.claim_id,
    );
    await _writeEvent(offer.claim_id, 'cnr_worker_accepted', { offerId }, tx);

    return updated;
  };

  const tenantId = offer.tenant_id || opts.tenantId;
  const updated = opts.tx
    ? await run(opts.tx)
    : await runInTransaction({ tenantId, label: 'cnr.worker_acceptance' }, run);

  logger.info({ msg: 'cnrService.recordWorkerAcceptance: complete', offerId });
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// recordAdjusterSignature — accepted → signed → eams_ready (single-step)
// ═════════════════════════════════════════════════════════════════════════════
async function recordAdjusterSignature(offerId, adjusterId, opts = {}) {
  const offer = await _fetchOffer(offerId);
  _assertTransition(offer, 'signed');

  const now = new Date().toISOString();

  const run = async (tx) => {
    // Single-step: signed → eams_ready.
    const updated = await _updateOffer(offerId, {
      status:              'eams_ready',
      adjuster_signed_at:  now,
      adjuster_signed_by:  adjusterId,
      eams_package_ready:  true,
      updated_at:          now,
    }, tx);

    await _closeDiary(offer.claim_id, 'CNR_ADJUSTER_SIGN', tx);

    await _createDiary(
      offer.claim_id, 'CNR_EAMS_FILE',
      _addCalendarDays(now.split('T')[0], 7), 'HIGH',
      'C&R EAMS package ready (DWC-CA form 10214(c)). File manually at DWC. Mark filed when complete.',
      {},
      tx,
    );

    await _writeAuditLog(
      'cnr_adjuster_signed', offerId,
      'Adjuster signed C&R. EAMS package ready for manual filing.',
      { adjusterId, eamsReady: true },
      tx,
      opts.actor,
      offer.claim_id,
    );
    await _writeEvent(offer.claim_id, 'cnr_adjuster_signed', {
      offerId, adjusterId, eamsReady: true,
    }, tx);

    return updated;
  };

  const tenantId = offer.tenant_id || opts.tenantId;
  const updated = opts.tx
    ? await run(opts.tx)
    : await runInTransaction({ tenantId, label: 'cnr.adjuster_signature' }, run);

  logger.info({ msg: 'cnrService.recordAdjusterSignature: complete', offerId });
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// recordEAMSFiled — eams_ready → filed
// ═════════════════════════════════════════════════════════════════════════════
async function recordEAMSFiled(offerId, { filedDate, filedBy }, opts = {}) {
  const offer = await _fetchOffer(offerId);
  _assertTransition(offer, 'filed');
  if (!filedDate) throw new Error('filedDate is required');

  const now = new Date().toISOString();

  const run = async (tx) => {
    const updated = await _updateOffer(offerId, {
      status:         'filed',
      eams_filed_at:  filedDate,
      eams_filed_by:  filedBy || null,
      updated_at:     now,
    }, tx);

    await _closeDiary(offer.claim_id, 'CNR_EAMS_FILE', tx);

    // Judge review typically 30–45 days; no statutory deadline → MEDIUM not CRITICAL.
    await _createDiary(
      offer.claim_id, 'CNR_OACR_FOLLOWUP',
      _addCalendarDays(filedDate, 45), 'MEDIUM',
      `C&R filed with WCAB on ${filedDate}. Follow up on OACR (Order Approving C&R) if not received by due date.`,
      {},
      tx,
    );

    await _writeAuditLog(
      'cnr_eams_filed', offerId, `C&R filed at WCAB on ${filedDate}`,
      { filedDate, filedBy },
      tx,
      opts.actor,
      offer.claim_id,
    );
    await _writeEvent(offer.claim_id, 'cnr_eams_filed', { offerId, filedDate }, tx);

    return updated;
  };

  const tenantId = offer.tenant_id || opts.tenantId;
  const updated = opts.tx
    ? await run(opts.tx)
    : await runInTransaction({ tenantId, label: 'cnr.eams_filed' }, run);

  logger.info({ msg: 'cnrService.recordEAMSFiled: complete', offerId, filedDate });
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// recordOACRReceived — filed → oacr_received
// ═════════════════════════════════════════════════════════════════════════════
async function recordOACRReceived(offerId, { oacrDate }, opts = {}) {
  const offer = await _fetchOffer(offerId);
  _assertTransition(offer, 'oacr_received');
  if (!oacrDate) throw new Error('oacrDate is required');

  const now = new Date().toISOString();

  // CCR §10880: 25 days + 5 for service = 30 effective calendar days.
  const paymentDueDate = _addCalendarDays(oacrDate, 30);

  const run = async (tx) => {
    const updated = await _updateOffer(offerId, {
      status:                'oacr_received',
      wcab_oacr_received_at: oacrDate,
      payment_due_date:      paymentDueDate,
      updated_at:            now,
    }, tx);

    await _closeDiary(offer.claim_id, 'CNR_OACR_FOLLOWUP', tx);

    await _createDiary(
      offer.claim_id, 'CNR_PAYMENT_DUE',
      paymentDueDate, 'CRITICAL',
      `C&R PAYMENT DUE: ${paymentDueDate}. Payment must issue by this date. Late payment triggers LC §5814 10% self-assessed penalty. OACR received ${oacrDate}.`,
      { noSnooze: true },
      tx,
    );

    await _writeAuditLog(
      'cnr_oacr_received', offerId,
      `OACR received on ${oacrDate}. Payment due ${paymentDueDate}.`,
      { oacrDate, paymentDueDate },
      tx,
      opts.actor,
      offer.claim_id,
    );
    await _writeEvent(offer.claim_id, 'cnr_oacr_received', {
      offerId, oacrDate, paymentDueDate,
    }, tx);

    return updated;
  };

  const tenantId = offer.tenant_id || opts.tenantId;
  const updated = opts.tx
    ? await run(opts.tx)
    : await runInTransaction({ tenantId, label: 'cnr.oacr_received' }, run);

  logger.info({
    msg: 'cnrService.recordOACRReceived: complete', offerId, oacrDate, paymentDueDate,
  });
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// recordPayment — oacr_received → paid (and claim → closed)
// ═════════════════════════════════════════════════════════════════════════════
async function recordPayment(offerId, { paidDate }, opts = {}) {
  const offer = await _fetchOffer(offerId);
  _assertTransition(offer, 'paid');
  if (!paidDate) throw new Error('paidDate is required');

  const now = new Date().toISOString();

  const run = async (tx) => {
    const updated = await _updateOffer(offerId, {
      status:     'paid',
      paid_at:    paidDate,
      updated_at: now,
    }, tx);

    await _closeDiary(offer.claim_id, 'CNR_PAYMENT_DUE', tx);

    // C&R closes ALL rights to future benefits — claim → closed, NOT
    // future_medical_only. That's the structural difference from a stip.
    await _transitionClaimStatus(
      offer.claim_id, 'settlement_discussions', 'closed', 'C&R paid', tx,
    );

    await _writeAuditLog(
      'cnr_paid', offerId, `C&R paid on ${paidDate}. Claim closed.`,
      { paidDate },
      tx,
      opts.actor,
      offer.claim_id,
    );
    await _writeEvent(offer.claim_id, 'cnr_paid', { offerId, paidDate }, tx);

    // ── WCIS hook — M22A ──────────────────────────────────────────
    // Fire SROI PY with C&R breakdown payload, then SROI FN.
    // Both enqueued atomically; scanner batches them together.
    await jobQueue.enqueue({
      queue: 'wcis.cnr_paid', claimId: offer.claim_id,
      payload: { offerId, claimId: offer.claim_id, paidDate },
      idempotencyKey: `wcis.cnr_paid:${offerId}`,
    }, { tx });

    return updated;
  };

  const tenantId = offer.tenant_id || opts.tenantId;
  const updated = opts.tx
    ? await run(opts.tx)
    : await runInTransaction({ tenantId, label: 'cnr.record_payment' }, run);

  logger.info({ msg: 'cnrService.recordPayment: complete', offerId, paidDate });
  return updated;
}

// Job handler (wcis.cnr_paid): SROI PY with the C&R breakdown, then SROI FN.
// wcisTriggerService dedupes, so a retry after a partial run is safe.
async function _wcisOnPayment({ offerId, claimId, paidDate }) {
  const wcis = require('./wcisTriggerService');
  await wcis.enqueueIfReportable({
    claim_id:         claimId,
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
    claim_id:         claimId,
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
}

// ═════════════════════════════════════════════════════════════════════════════
// rejectOffer / withdrawOffer — terminal
// ═════════════════════════════════════════════════════════════════════════════
async function rejectOffer(offerId, { reason }, opts = {}) {
  const offer = await _fetchOffer(offerId);
  _assertTransition(offer, 'rejected');
  const now = new Date().toISOString();

  const run = async (tx) => {
    const updated = await _updateOffer(offerId, {
      status:          'rejected',
      rejected_at:     now,
      rejected_reason: reason || null,
      updated_at:      now,
    }, tx);

    await _closeAllOpenCnrDiaries(offer.claim_id, tx);

    await _writeAuditLog(
      'cnr_rejected', offerId, `C&R rejected: ${reason || 'no reason'}`,
      { reason, priorStatus: offer.status },
      tx,
      opts.actor,
      offer.claim_id,
    );
    await _writeEvent(offer.claim_id, 'cnr_rejected', { offerId, reason }, tx);

    return updated;
  };

  const tenantId = offer.tenant_id || opts.tenantId;
  const updated = opts.tx
    ? await run(opts.tx)
    : await runInTransaction({ tenantId, label: 'cnr.reject_offer' }, run);

  logger.info({ msg: 'cnrService.rejectOffer: complete', offerId });
  return updated;
}

async function withdrawOffer(offerId, { reason }, opts = {}) {
  const offer = await _fetchOffer(offerId);
  _assertTransition(offer, 'withdrawn');
  const now = new Date().toISOString();

  const run = async (tx) => {
    const updated = await _updateOffer(offerId, {
      status:           'withdrawn',
      withdrawn_at:     now,
      withdrawn_reason: reason || null,
      updated_at:       now,
    }, tx);

    await _closeAllOpenCnrDiaries(offer.claim_id, tx);

    await _writeAuditLog(
      'cnr_withdrawn', offerId, `C&R withdrawn: ${reason || 'no reason'}`,
      { reason, priorStatus: offer.status },
      tx,
      opts.actor,
      offer.claim_id,
    );
    await _writeEvent(offer.claim_id, 'cnr_withdrawn', { offerId, reason }, tx);

    return updated;
  };

  const tenantId = offer.tenant_id || opts.tenantId;
  const updated = opts.tx
    ? await run(opts.tx)
    : await runInTransaction({ tenantId, label: 'cnr.withdraw_offer' }, run);

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
  // Job handler (src/jobs/registry.js)
  _wcisOnPayment,
};
