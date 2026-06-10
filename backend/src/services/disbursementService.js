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
const config = require('../config');
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

async function proposeDisbursement({ claimId, awardType, stipulationId, settlementOfferId, extraction, awardDocumentId }) {
  if (!claimId) throw new Error('claimId is required');
  if (!['stip_f_and_a', 'cnr_oacr'].includes(awardType)) {
    throw new Error(`UNKNOWN_AWARD_TYPE: ${awardType}`);
  }
  if (!extraction || typeof extraction !== 'object') {
    throw new Error('extraction is required');
  }

  // (1) XOR link validation — matches award_disbursements_xor_link_chk.
  const hasStip  = !!stipulationId;
  const hasOffer = !!settlementOfferId;
  if (hasStip === hasOffer) {
    throw new Error('stipulationId XOR settlementOfferId required');
  }

  const flags = [];

  // (2) Lien check — M20 not built. Always flag for adjuster review.
  flags.push('LIEN_PRESENT_ADJUSTER_REVIEW');

  // (4) weeklyRate required.
  const weeklyRate = parseFloat(extraction.weeklyRate);
  if (!Number.isFinite(weeklyRate) || weeklyRate <= 0) {
    throw new Error('WEEKLY_RATE_REQUIRED');
  }

  const totalAward = parseFloat(extraction.totalAward);
  if (!Number.isFinite(totalAward) || totalAward <= 0) {
    throw new Error('TOTAL_AWARD_REQUIRED');
  }

  // Resolve dates with fallbacks; NOT NULL columns require values.
  const awardDate          = extraction.awardDate        || extraction.awardServiceDate || extraction.accruedStartDate || null;
  const awardServiceDate   = extraction.awardServiceDate || awardDate;
  const accruedStartDate   = extraction.accruedStartDate || awardServiceDate;
  if (!awardDate || !awardServiceDate || !accruedStartDate) {
    throw new Error('AWARD_DATES_REQUIRED');
  }

  // (11) Service-date missing flag (we used a fallback for the NOT NULL column).
  // When the service date is unknown we must still persist the bundle (NOT NULL
  // columns require a value), so we fall back to awardDate / accruedStartDate.
  // Consequence: the §5814 statutory pay-by date is derived from the fallback
  // and is UNRELIABLE for compliance until the adjuster corrects the service
  // date via re-extraction or manual update. PAYMENT_DUE_PROVISIONAL marks
  // that downstream consumers should treat pay-by as advisory, not binding.
  if (!extraction.awardServiceDate) {
    flags.push('SERVICE_DATE_MISSING');
    flags.push('PAYMENT_DUE_PROVISIONAL');
  }

  // (3) Statutory pay-by (not persisted on the row — recomputed at recordDisbursementPayment).
  // Intentional: the PAY_BY_DATE is derivable from (awardServiceDate, awardType).

  // (5) Week arithmetic. Apportionment is ALREADY baked into totalAward by the judge;
  // weekly rate is invariant under apportionment.
  const totalAwardWeeks = totalAward / weeklyRate;
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysElapsed = Math.max(
    0,
    (new Date(awardServiceDate + 'T00:00:00').getTime() -
     new Date(accruedStartDate + 'T00:00:00').getTime()) / msPerDay,
  );
  const weeksElapsed = daysElapsed / 7;

  const accruedWeeks      = Math.min(weeksElapsed, totalAwardWeeks);
  const accruedAmount     = Math.round(accruedWeeks * weeklyRate * 100) / 100;
  const scheduledWeeksRaw = Math.max(0, totalAwardWeeks - accruedWeeks);
  const scheduledWeeks    = Math.round(scheduledWeeksRaw * 10000) / 10000;
  const scheduledAmount   = Math.round(scheduledWeeks * weeklyRate * 100) / 100;

  // (6) DEU range check — if remaining PD exceeds Table 1, we can't commute.
  const deuRangeExceeded = scheduledWeeksRaw > _getCommutationService().DEU_POLICY.TABLE_1_MAX_WEEKS;
  if (deuRangeExceeded) flags.push('DEU_RANGE_EXCEEDED');

  // Load claim + cap context once.
  const { data: claim } = await supabase.from('claims').select('*').eq('id', claimId).single();
  if (!claim) throw new Error(`Claim not found: ${claimId}`);
  const capContext = _resolveCapContext(claim);

  // (7) AA fee — resolve flat vs percent, then maybe commute off far end.
  const feeResult = _resolveAaFee({
    totalAward,
    aaFeePct:    extraction.aaFeePct,
    aaFeeAmount: extraction.aaFeeAmount,
  });
  flags.push(...feeResult.flags);

  let aaFeeCommuted         = false;
  let aaFeeWeeksEliminated  = null;
  let aaFeePvAtCommutation  = null;

  if (
    extraction.commutationOrdered &&
    capContext.represented &&
    feeResult.aaFeeAmount > 0 &&
    !deuRangeExceeded &&
    scheduledWeeksRaw > 0
  ) {
    try {
      const comm = _getCommutationService().commutePdOffFarEnd({
        weeklyRate,
        weeksRemainingAtDoc: scheduledWeeksRaw,
        amountToCommute:     feeResult.aaFeeAmount,
        docDate:             awardServiceDate,
        actualPayDate:       awardServiceDate, // placeholder; interest recomputed at recordPayment
      });
      aaFeeCommuted         = true;
      aaFeeWeeksEliminated  = comm.weeksEliminated;
      aaFeePvAtCommutation  = comm.pvOfAmountToCommute;
    } catch (err) {
      logger.warn({ msg: 'disbursementService: commutation skipped', err: err.message, claimId });
    }
  }

  // (8) Offset paid advances.
  const adv = await _offsetAdvances(claimId, totalAward, capContext);
  flags.push(...adv.flags);

  // (9) Apportionment sanity check against latest pd_evaluations row.
  let apportionmentPct = extraction.apportionmentPct != null ? parseFloat(extraction.apportionmentPct) : null;
  try {
    const { data: pdEvals } = await supabase
      .from('pd_evaluations').select('*').eq('claim_id', claimId)
      .order('calculated_at', { ascending: false });
    if (pdEvals && pdEvals.length > 0) {
      const stored = parseFloat(pdEvals[0].apportionment_percent);
      if (apportionmentPct != null && Number.isFinite(stored)) {
        const diff = Math.abs(apportionmentPct - stored);
        if (diff > DISBURSEMENT_POLICY.APPORTIONMENT_MISMATCH_THRESHOLD_PCT) {
          flags.push('APPORTIONMENT_MISMATCH');
        }
      }
    }
  } catch (err) {
    logger.warn({ msg: 'disbursementService: apportionment check failed (non-fatal)', err: err.message });
  }

  // (10) P_AND_S_DISCREPANCY bubble-up from extraction warnings.
  if (Array.isArray(extraction.warnings) && extraction.warnings.includes('P_AND_S_DISCREPANCY')) {
    flags.push('P_AND_S_DISCREPANCY');
  }

  // (12) Net computations.
  const netNowRaw      = accruedAmount - adv.advancesOffsetApplied - (aaFeeCommuted ? feeResult.aaFeeAmount : 0);
  const netToWorkerNow = Math.round(Math.max(0, netNowRaw) * 100) / 100;
  if (netNowRaw < 0 && !flags.includes('OVERPAYMENT_RECOVERABLE')) {
    flags.push('OVERPAYMENT_RECOVERABLE');
  }
  const netToWorkerScheduled = Math.round(
    (scheduledAmount - (aaFeeCommuted ? 0 : feeResult.aaFeeAmount)) * 100,
  ) / 100;

  // (13) interest_owed = 0 at propose time.
  // (14) INSERT award_disbursements row.
  const now = new Date().toISOString();
  const insertRow = {
    claim_id:                 claimId,
    stipulation_id:           stipulationId      || null,
    settlement_offer_id:      settlementOfferId  || null,
    award_type:               awardType,
    award_document_id:        awardDocumentId    || null,
    award_date:               awardDate,
    award_service_date:       awardServiceDate,
    accrued_start_date:       accruedStartDate,
    total_award:              totalAward,
    apportionment_pct:        apportionmentPct,
    weekly_rate:              weeklyRate,
    accrued_weeks:            Math.round(accruedWeeks * 10000) / 10000,
    accrued_amount:           accruedAmount,
    scheduled_weeks:          scheduledWeeks,
    scheduled_amount:         scheduledAmount,
    aa_fee_pct:               feeResult.aaFeePct,
    aa_fee_amount:            feeResult.aaFeeAmount,
    aa_fee_commuted:          aaFeeCommuted,
    aa_fee_weeks_eliminated:  aaFeeWeeksEliminated,
    aa_fee_pv_at_commutation: aaFeePvAtCommutation,
    advances_paid_to_date:    adv.advancesPaidToDate,
    advances_offset_applied:  adv.advancesOffsetApplied,
    net_to_worker_now:        netToWorkerNow,
    net_to_worker_scheduled:  netToWorkerScheduled,
    interest_owed:            0,
    flags,
    status:                   'proposed',
    created_at:                now,
    updated_at:                now,
  };

  const { data: row, error } = await supabase
    .from('award_disbursements').insert(insertRow).select().single();
  if (error) throw new Error(`disbursementService.proposeDisbursement: insert failed — ${error.message}`);

  // (15) CRITICAL approval diary.
  // (authorizes a WC payment). For now routed to system@homecaretpa.com.
  const payBy       = _computeStatutoryPayBy(awardType, awardServiceDate);
  const diaryDue    = _addCalendarDays(payBy, -DISBURSEMENT_POLICY.APPROVAL_DIARY_LEAD_DAYS);
  await supabase.from('diaries').insert({
    claim_id:    claimId,
    diary_type:  'DISBURSEMENT_APPROVAL',
    due_date:    diaryDue,
    assigned_to: config.adjuster.email,
    priority:    'CRITICAL',
    notes:       `Disbursement bundle ready for approval. Pay-by ${payBy}. Net-now $${netToWorkerNow.toLocaleString()}. Flags: ${flags.join(', ') || 'none'}.`,
    status:      'open',
    no_snooze:   true,
    fh_diary_id: `diy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    created_at:  now,
  });

  await _writeAuditLog(
    'disbursement_proposed', row.id,
    `Disbursement proposed: ${awardType}, $${totalAward.toLocaleString()} award, net-now $${netToWorkerNow.toLocaleString()}`,
    { awardType, totalAward, netToWorkerNow, flags },
  );

  await supabase.from('claim_events').insert({
    claim_id: claimId, type: 'disbursement_proposed', timestamp: now,
    data:     { disbursementId: row.id, awardType, totalAward, flags },
  });

  logger.info({
    msg: 'disbursementService.proposeDisbursement: complete',
    claimId, disbursementId: row.id, totalAward, netToWorkerNow, flags,
  });

  return row;
}

async function approveDisbursement(disbursementId, { adjusterId, notes }) {
  const { data: row, error: fetchErr } = await supabase
    .from('award_disbursements').select('*').eq('id', disbursementId).single();
  if (fetchErr || !row) throw new Error(`Disbursement not found: ${disbursementId}`);
  if (row.status !== 'proposed') {
    throw new Error(`Cannot approve disbursement in status: ${row.status}`);
  }

  const now = new Date().toISOString();
  const { data: updated, error } = await supabase.from('award_disbursements')
    .update({
      status:         'approved',
      approved_by:    adjusterId || null,
      approved_at:    now,
      approval_notes: notes || null,
      updated_at:     now,
    })
    .eq('id', disbursementId)
    .select()
    .single();
  if (error) throw new Error(`disbursementService.approveDisbursement: ${error.message}`);

  // ai_decisions audit row — M14.5 disbursement approvals land here so the
  // human-review of the AI-extracted award is captured alongside the extract.
  try {
    await supabase.from('ai_decisions').insert({
      claim_id:       row.claim_id,
      decision_type:  'disbursement_approval',
      input_snapshot: { disbursementId, priorStatus: 'proposed', flags: row.flags || [] },
      output_raw:     JSON.stringify({ approvedBy: adjusterId, notes }),
      output_parsed:  { approvedBy: adjusterId, notes },
      review_action:  'approved',
      reviewed_by:    adjusterId || null,
      review_notes:   notes || null,
      reviewed_at:    now,
      created_at:     now,
    });
  } catch (err) {
    logger.error({ msg: 'disbursementService: ai_decisions approval write failed (non-fatal)', err: err.message });
  }

  await _writeAuditLog(
    'disbursement_approved', disbursementId,
    `Disbursement approved by ${adjusterId || 'unknown'}`,
    { adjusterId, notes },
  );
  await supabase.from('claim_events').insert({
    claim_id: row.claim_id, type: 'disbursement_approved', timestamp: now,
    data:     { disbursementId, adjusterId },
  });

  logger.info({ msg: 'disbursementService.approveDisbursement: complete', disbursementId });
  return updated;
}

async function rejectDisbursement(disbursementId, { adjusterId, reason }) {
  if (!reason) throw new Error('reason is required');

  const { data: row, error: fetchErr } = await supabase
    .from('award_disbursements').select('*').eq('id', disbursementId).single();
  if (fetchErr || !row) throw new Error(`Disbursement not found: ${disbursementId}`);
  if (row.status !== 'proposed') {
    throw new Error(`Cannot reject disbursement in status: ${row.status}`);
  }

  const now = new Date().toISOString();
  const { data: updated, error } = await supabase.from('award_disbursements')
    .update({
      status:          'rejected',
      rejected_reason: reason,
      updated_at:      now,
    })
    .eq('id', disbursementId)
    .select()
    .single();
  if (error) throw new Error(`disbursementService.rejectDisbursement: ${error.message}`);

  // Close the approval diary — no further action on this bundle.
  await supabase.from('diaries')
    .update({ status: 'completed', updated_at: now })
    .eq('claim_id', row.claim_id).eq('diary_type', 'DISBURSEMENT_APPROVAL').eq('status', 'open');

  await _writeAuditLog(
    'disbursement_rejected', disbursementId,
    `Disbursement rejected by ${adjusterId || 'unknown'}: ${reason}`,
    { adjusterId, reason },
  );
  await supabase.from('claim_events').insert({
    claim_id: row.claim_id, type: 'disbursement_rejected', timestamp: now,
    data:     { disbursementId, adjusterId, reason },
  });

  logger.info({ msg: 'disbursementService.rejectDisbursement: complete', disbursementId });
  return updated;
}

async function recordDisbursementPayment(disbursementId, { paidDate, reference }) {
  if (!paidDate) throw new Error('paidDate is required');

  const { data: row, error: fetchErr } = await supabase
    .from('award_disbursements').select('*').eq('id', disbursementId).single();
  if (fetchErr || !row) throw new Error(`Disbursement not found: ${disbursementId}`);
  if (row.status !== 'approved') {
    throw new Error(`Cannot record payment on disbursement in status: ${row.status}`);
  }

  const now          = new Date().toISOString();
  const commutation  = _getCommutationService();
  const payBy        = _computeStatutoryPayBy(row.award_type, row.award_service_date);
  const totalAward   = parseFloat(row.total_award);
  const interestOwed = commutation.computeLateInterest(totalAward, payBy, paidDate);

  // Merge new flags into existing ones (preserve propose-time flags).
  const mergedFlags = Array.isArray(row.flags) ? row.flags.slice() : [];
  if (interestOwed > 0 && !mergedFlags.includes('INTEREST_OWED_LATE_PAYMENT')) {
    mergedFlags.push('INTEREST_OWED_LATE_PAYMENT');
  }

  // CNR ordering guard — cnrService.recordPayment must fire first for C&R bundles.
  if (row.award_type === 'cnr_oacr') {
    if (!row.settlement_offer_id) throw new Error('CNR_OFFER_LINK_MISSING');
    const { data: offer } = await supabase
      .from('settlement_offers').select('*').eq('id', row.settlement_offer_id).single();
    if (!offer || offer.status !== 'paid' || !offer.paid_at) {
      throw new Error('CNR_PAYMENT_ORDER_VIOLATION');
    }
    const windowMs = DISBURSEMENT_POLICY.CNR_PAYMENT_ORDER_WINDOW_MINUTES * 60 * 1000;
    const updatedAtMs = new Date(offer.updated_at || offer.created_at || now).getTime();
    if (Date.now() - updatedAtMs > windowMs) {
      throw new Error('CNR_PAYMENT_ORDER_VIOLATION');
    }
  }

  // Finalize the row.
  const { data: updated, error } = await supabase.from('award_disbursements')
    .update({
      status:        'disbursed',
      disbursed_at:  now,
      interest_owed: interestOwed,
      flags:         mergedFlags,
      updated_at:    now,
    })
    .eq('id', disbursementId)
    .select()
    .single();
  if (error) throw new Error(`disbursementService.recordDisbursementPayment: ${error.message}`);

  // Close the approval diary.
  await supabase.from('diaries')
    .update({ status: 'completed', updated_at: now })
    .eq('claim_id', row.claim_id).eq('diary_type', 'DISBURSEMENT_APPROVAL').eq('status', 'open');

  // Penalty bridge row — M17A will consume these into penalty_exposures and
  // drop the deferred_penalty_flags table. Do not build new features against
  // this table beyond M14.5.
  if (interestOwed > 0) {
    const penaltyEstimate = Math.min(
      Math.round(totalAward * DISBURSEMENT_POLICY.PENALTY_ESTIMATE_PCT * 100) / 100,
      DISBURSEMENT_POLICY.PENALTY_ESTIMATE_CAP,
    );
    await supabase.from('deferred_penalty_flags').insert({
      claim_id:         row.claim_id,
      source_type:      'award_disbursement',
      source_id:        disbursementId,
      statute:          'LC_5814',
      event_date:       paidDate,
      deadline_date:    payBy,
      amount_at_risk:   totalAward,
      penalty_estimate: penaltyEstimate,
      notes:            `Late payment — paid ${paidDate} vs pay-by ${payBy}; interest $${interestOwed.toFixed(2)}. ${reference ? `Ref: ${reference}. ` : ''}Estimate clamped at $${DISBURSEMENT_POLICY.PENALTY_ESTIMATE_CAP.toLocaleString()}.`,
      created_at:       now,
    });
  }

  // Claim status transitions.
  if (row.award_type === 'stip_f_and_a') {
    // Look up the stipulation to determine future_medical.
    let futureMedical = false;
    if (row.stipulation_id) {
      const { data: stip } = await supabase
        .from('stipulations').select('*').eq('id', row.stipulation_id).single();
      if (stip) futureMedical = !!stip.future_medical;
    }
    const newClaimStatus = futureMedical ? 'future_medical_only' : 'closed';

    const { data: claim } = await supabase.from('claims').select('*').eq('id', row.claim_id).single();
    const priorStatus = claim ? claim.status : null;
    await supabase.from('claims')
      .update({ status: newClaimStatus, updated_at: now })
      .eq('id', row.claim_id);

    await _writeAuditLog(
      'claim_status_changed', disbursementId,
      `Claim ${row.claim_id}: ${priorStatus} → ${newClaimStatus} (stip paid, future_medical=${futureMedical})`,
      { priorStatus, newClaimStatus, futureMedical, disbursementId },
    );
    await supabase.from('claim_events').insert({
      claim_id: row.claim_id, type: 'status_changed', timestamp: now,
      data:     { from: priorStatus, to: newClaimStatus, changedBy: 'system', reason: 'stip disbursement paid', disbursementId },
    });
  }
  // cnr_oacr: cnrService.recordPayment already transitioned claim → closed.

  await _writeAuditLog(
    'disbursement_paid', disbursementId,
    `Disbursement paid on ${paidDate}. Interest owed: $${interestOwed.toFixed(2)}.`,
    { paidDate, reference, interestOwed, flags: mergedFlags },
  );
  await supabase.from('claim_events').insert({
    claim_id: row.claim_id, type: 'disbursement_paid', timestamp: now,
    data:     { disbursementId, paidDate, interestOwed, reference: reference || null },
  });

  // ── WCIS hook — M22A ──────────────────────────────────────────
  // Fire SROI PY with stip breakdown payload. If stipulation
  // future_medical = false, follow with SROI FN. If true, no FN
  // (claim stays future-medical-only).
  setImmediate(async () => {
    try {
      const wcis = require('./wcisTriggerService');

      await wcis.enqueueIfReportable({
        claim_id:         row.claim_id,
        trigger_event:    'stip_disbursement_paid',
        source_service:   'disbursementService',
        source_record_id: disbursementId,
        event_date:       paidDate,
        payload_context: {
          source:          'stip_disbursement',
          disbursement_id: disbursementId,
          paid_date:       paidDate,
        },
      });

      let futureMedical = null;
      if (row.stipulation_id) {
        const { data: stip } = await supabase
          .from('stipulations')
          .select('future_medical')
          .eq('id', row.stipulation_id)
          .single();
        futureMedical = stip ? !!stip.future_medical : null;
      }

      if (futureMedical === false) {
        await wcis.enqueueIfReportable({
          claim_id:         row.claim_id,
          trigger_event:    'claim_closed',
          source_service:   'disbursementService',
          source_record_id: disbursementId,
          event_date:       paidDate,
          payload_context: {
            source:             'stip_disbursement',
            disbursement_id:    disbursementId,
            closed_date:        paidDate,
            claim_status_code:  'C',
          },
        });
      } else if (futureMedical === true) {
        logger.info({
          msg: 'disbursementService.recordDisbursementPayment: future_medical=true, no FN',
          disbursementId,
        });
      }
    } catch (err) {
      logger.error({
        msg: 'disbursementService.recordDisbursementPayment: WCIS hook failed',
        disbursementId, err: err.message,
      });
    }
  });

  logger.info({
    msg: 'disbursementService.recordDisbursementPayment: complete',
    disbursementId, paidDate, interestOwed, flags: mergedFlags,
  });
  return updated;
}

async function getDisbursementsForClaim(claimId) {
  const { data, error } = await supabase
    .from('award_disbursements').select('*').eq('claim_id', claimId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function getPendingDisbursements(limit = 50) {
  const { data, error } = await supabase
    .from('award_disbursements').select('*').eq('status', 'proposed')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

// ── Private helper seats (filled in Pass 2) ──────────────────────────────────
function _addCalendarDays(dateStr, days) {
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00'));
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// Represented check — shared helper (M17B). Data-level consolidation onto a
// single attorney_represented column is still pending.
const _isRepresented = require('../utils/representation').isRepresented;

/**
 * Resolve the retro-advance cap context for a claim.
 * Returns { represented: boolean, retroCapThresholdPct: number }.
 *
 * The threshold comes from pdService.ADVANCE_CAP_POLICY.REPRESENTED_PCT
 * (0.85). We read it via lazy require so the constant stays single-source.
 * Before pdService exports the constant (M14.5 TODO #7) a literal fallback
 * is used.
 */
function _resolveCapContext(claim) {
  // Fallback for test isolation — pdService.ADVANCE_CAP_POLICY is the
  // authoritative source.
  let thresholdPct = 0.85;
  try {
    const pd = _getPdService();
    if (pd.ADVANCE_CAP_POLICY && typeof pd.ADVANCE_CAP_POLICY.REPRESENTED_PCT === 'number') {
      thresholdPct = pd.ADVANCE_CAP_POLICY.REPRESENTED_PCT;
    }
  } catch {
    // pdService unavailable — fall through to literal.
  }
  return { represented: _isRepresented(claim), retroCapThresholdPct: thresholdPct };
}

/**
 * Sum all paid pd_advance_payments rows for a claim and report the offset
 * to apply against totalAward.
 *
 *   advances_paid_to_date  = Σ amount_paid WHERE status='paid'
 *   advances_offset_applied = min(advances_paid_to_date, totalAward)
 *
 * Flags:
 *   OVERPAYMENT_RECOVERABLE              when paid > totalAward
 *   ADVANCE_CAP_RETROACTIVELY_EXCEEDED   when represented AND paid > threshold × totalAward
 */
async function _offsetAdvances(claimId, totalAward, capContext) {
  const { data: rows } = await supabase
    .from('pd_advance_payments')
    .select('*')
    .eq('claim_id', claimId);

  const paidRows = (rows || []).filter(r => r.status === 'paid');
  const advancesPaidToDate = Math.round(
    paidRows.reduce((acc, r) => acc + parseFloat(r.amount_paid || 0), 0) * 100,
  ) / 100;

  const award = parseFloat(totalAward) || 0;
  const advancesOffsetApplied = Math.min(advancesPaidToDate, award);

  const flags = [];
  if (advancesPaidToDate > award && award > 0) {
    flags.push('OVERPAYMENT_RECOVERABLE');
  }
  if (
    capContext.represented &&
    award > 0 &&
    advancesPaidToDate > capContext.retroCapThresholdPct * award
  ) {
    flags.push('ADVANCE_CAP_RETROACTIVELY_EXCEEDED');
  }

  return { advancesPaidToDate, advancesOffsetApplied, flags };
}

/**
 * Resolve AA fee from an extraction.
 *
 *   - If aaFeeAmount is present and >0, use it flat. aaFeePct may be null.
 *   - Else if aaFeePct is present, derive aaFeeAmount = totalAward × pct / 100.
 *   - Else both zero (no AA fee → unrepresented).
 *
 * Flags an unusual fee percent when aaFeePct falls outside
 * [AA_FEE_UNUSUAL_LOW_PCT, AA_FEE_UNUSUAL_HIGH_PCT]. No flag when the pct
 * is null (i.e. flat amount with no declared percent) or when there is
 * no AA fee at all.
 *
 * Does NOT apply commutation. The caller decides whether commutation
 * applies (represented + extraction.commutationOrdered) and delegates to
 * commutationService.commutePdOffFarEnd separately.
 */
function _resolveAaFee({ totalAward, aaFeePct, aaFeeAmount }) {
  const flags = [];
  let pct = aaFeePct != null && aaFeePct !== '' ? parseFloat(aaFeePct) : null;
  let amt = aaFeeAmount != null && aaFeeAmount !== '' ? parseFloat(aaFeeAmount) : null;

  if (!Number.isFinite(pct)) pct = null;
  if (!Number.isFinite(amt)) amt = null;

  if (amt != null && amt > 0) {
    // Flat amount provided — keep pct as-is (may be null).
  } else if (pct != null && pct > 0) {
    const award = parseFloat(totalAward) || 0;
    amt = Math.round(award * pct / 100 * 100) / 100;
  } else {
    amt = 0;
    pct = pct != null && pct >= 0 ? pct : null;
  }

  if (pct != null && amt > 0) {
    if (pct < DISBURSEMENT_POLICY.AA_FEE_UNUSUAL_LOW_PCT || pct > DISBURSEMENT_POLICY.AA_FEE_UNUSUAL_HIGH_PCT) {
      flags.push('AA_FEE_UNUSUAL');
    }
  }

  return { aaFeePct: pct, aaFeeAmount: amt, flags };
}

/**
 * Statutory pay-by date for an award.
 *   stip_f_and_a: awardServiceDate + 10 calendar days (LC §5814).
 *   cnr_oacr:     awardServiceDate + 30 calendar days (CCR §10880).
 *
 * Expects awardServiceDate as 'YYYY-MM-DD'. Returns 'YYYY-MM-DD'.
 */
function _computeStatutoryPayBy(awardType, awardServiceDate) {
  if (!awardServiceDate) throw new Error('SERVICE_DATE_REQUIRED');
  if (awardType === 'stip_f_and_a') {
    return _addCalendarDays(awardServiceDate, DISBURSEMENT_POLICY.STIP_PAY_BY_DAYS);
  }
  if (awardType === 'cnr_oacr') {
    return _addCalendarDays(awardServiceDate, DISBURSEMENT_POLICY.CNR_PAY_BY_DAYS);
  }
  throw new Error(`UNKNOWN_AWARD_TYPE: ${awardType}`);
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
  _computeStatutoryPayBy,
  _isRepresented,
  _resolveCapContext,
  _resolveAaFee,
  _offsetAdvances,
  _writeAuditLog,
  _getPdService,
  _getCommutationService,
};
