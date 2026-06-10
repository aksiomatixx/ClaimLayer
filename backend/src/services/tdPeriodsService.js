'use strict';

/**
 * tdPeriodsService.js — Temporary disability period tracking.
 *
 * First-class record of when TD started, when it stopped, whether it
 * was suspended and restarted, what type (TTD vs TPD vs salary
 * continuation), and the cumulative weeks paid against the 104-week
 * statutory cap.
 *
 * STATUTORY AUTHORITY:
 *   - LC §4656(c)(2) — 104 aggregate weeks of TTD within 5 years of
 *     date of injury for ordinary injuries. The 240-week category for
 *     severe injuries (LC §4656(c)(3)) is OUT OF SCOPE for this
 *     milestone — full tdService will add a longer-cap path.
 *   - LC §4650 — first TD payment within 14 days of disability;
 *     §4650(d) imposes a 10% self-imposed penalty on late payments.
 *     Penalty automation is a HOOK in this file but not yet wired.
 *
 * WCIS TRIGGER HOOKS (tdService completion milestone):
 *   Every TD state change enqueues its SROI transaction via
 *   wcisTriggerService.enqueueIfReportable — IP on first indemnity,
 *   CA on rate change, CB on benefit-type change, S1/P1/S2/S3/S7 on
 *   suspension (mapped from reason_ended), RB on reinstatement, RE on
 *   reduced earnings, FS on salary continuation. Hooks are non-fatal:
 *   a queue failure logs an error but never blocks the benefit change
 *   (the deadline monitor cron surfaces missed enqueues).
 */

const { supabase } = require('./supabase');
const logger       = require('../logger');

// ── Constants ─────────────────────────────────────────────────────────────────
const STATUTORY_CAP_WEEKS = 104;        // LC §4656(c)(2)
const DAYS_PER_WEEK       = 7;
const MS_PER_DAY          = 24 * 60 * 60 * 1000;

const VALID_BENEFIT_TYPES   = ['TTD', 'TPD', 'salary_continuation'];
const VALID_REASON_STARTED  = [
  'initial_disability', 'reinstatement', 'rate_change', 'benefit_type_change',
];
const VALID_REASON_ENDED    = [
  'rtw_full', 'rtw_modified', 'mmi_reached', 'max_weeks_exhausted',
  'suspended_by_adjuster', 'med_noncompliance', 'settled', 'death',
  'rate_change', 'benefit_type_change', 'other',
];

// reason_ended → WCIS suspension trigger event. Reasons not listed are
// reported by other services (mmi→PD CB via pdService, settled→cnr PY/FN,
// rate/type change→the superseding period's CA/CB) or deferred (death→CD,
// Injury Type Expansion milestone).
const REASON_ENDED_TO_WCIS_EVENT = {
  rtw_full:              'td_suspended_rtw',          // S1
  rtw_modified:          'td_partial_suspended_rtw',  // P1
  med_noncompliance:     'td_suspended_med_noncomp',  // S2
  suspended_by_adjuster: 'td_suspended_admin_noncomp',// S3
  max_weeks_exhausted:   'td_suspended_benefits_ex',  // S7
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function _today() {
  return new Date().toISOString().split('T')[0];
}

function _addDays(dateStr, n) {
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00Z'));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function _diffDaysInclusive(startDate, endDate) {
  const a = new Date(startDate + 'T00:00:00Z');
  const b = new Date(endDate   + 'T00:00:00Z');
  return Math.max(0, Math.round((b - a) / MS_PER_DAY) + 1);
}

function _weeksFromDays(days) {
  return Math.round((days / DAYS_PER_WEEK) * 100) / 100;
}

async function _writeAuditLog(action, resourceId, description, newValue, actorEmail) {
  try {
    await supabase.from('audit_log').insert({
      action,
      resource_type: 'td_period',
      resource_id:   resourceId,
      description,
      new_value:     newValue,
      user_role:     'admin',
      created_at:    new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ msg: 'tdPeriodsService: audit_log write failed', err: err.message, action, resourceId, actorEmail });
  }
}

async function _writeClaimEvent(claimId, type, data) {
  await supabase.from('claim_events').insert({
    claim_id:  claimId,
    type,
    timestamp: new Date().toISOString(),
    data:      data || {},
  });
}

// ── Read operations ──────────────────────────────────────────────────────────

/**
 * Non-fatal WCIS enqueue. A trigger-queue failure must never block a
 * benefit change — it logs loudly and the WCIS deadline monitor cron
 * is the backstop for anything missed.
 */
async function _enqueueWcis(claimId, triggerEvent, sourceRecordId, eventDate, payloadContext) {
  try {
    const wcis = require('./wcisTriggerService');
    await wcis.enqueueIfReportable({
      claim_id:         claimId,
      trigger_event:    triggerEvent,
      source_service:   'tdPeriodsService',
      source_record_id: sourceRecordId,
      event_date:       eventDate,
      payload_context:  payloadContext || {},
    });
  } catch (e) {
    logger.error({ msg: 'tdPeriodsService: WCIS enqueue failed (non-fatal)', triggerEvent, claimId, err: e.message });
  }
}

async function listForClaim(claimId) {
  const { data, error } = await supabase
    .from('td_periods')
    .select('*')
    .eq('claim_id', claimId)
    .order('start_date', { ascending: false });
  if (error) throw new Error(`tdPeriodsService.listForClaim: ${error.message}`);
  return data || [];
}

async function getActive(claimId) {
  const all = await listForClaim(claimId);
  return all.find(p => p.end_date == null) || null;
}

async function getById(periodId) {
  const { data, error } = await supabase
    .from('td_periods')
    .select('*')
    .eq('id', periodId)
    .single();
  if (error) return null;
  return data;
}

// ── Auto-complete TD_PAYMENT_SETUP diary on first period creation ────────────

async function _completeTdSetupDiaryIfFirst(claimId, periodId) {
  const periods = await listForClaim(claimId);
  if (periods.length !== 1) return;  // only on the very first period

  const { data: open } = await supabase
    .from('diaries')
    .select('*')
    .eq('claim_id', claimId)
    .eq('diary_type', 'TD_PAYMENT_SETUP')
    .eq('status', 'open');

  if (!open || open.length === 0) return;

  const note = `Completed by td_period creation: ${periodId}`;
  for (const d of open) {
    await supabase
      .from('diaries')
      .update({
        status:           'completed',
        completed_at:     new Date().toISOString(),
        completed_by:     'system',
        resolution_notes: note,
        updated_at:       new Date().toISOString(),
      })
      .eq('id', d.id);
  }
}

// ── createPeriod ──────────────────────────────────────────────────────────────

async function createPeriod(claimId, input, actorEmail) {
  const { benefit_type, start_date, weekly_rate, reason_started, notes } = input || {};

  if (!claimId) throw new Error('claimId is required');
  if (!VALID_BENEFIT_TYPES.includes(benefit_type)) {
    throw new Error(`benefit_type must be one of: ${VALID_BENEFIT_TYPES.join(', ')}`);
  }
  if (!start_date || !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
    throw new Error('start_date must be YYYY-MM-DD');
  }
  if (!(typeof weekly_rate === 'number' && weekly_rate > 0)) {
    throw new Error('weekly_rate must be a positive number');
  }
  if (reason_started && !VALID_REASON_STARTED.includes(reason_started)) {
    throw new Error(`reason_started must be one of: ${VALID_REASON_STARTED.join(', ')}`);
  }

  const { data: claim } = await supabase.from('claims').select('id').eq('id', claimId).single();
  if (!claim) throw new Error(`Claim not found: ${claimId}`);

  const active = await getActive(claimId);

  // If an active period exists, atomically close it (end_date = new
  // start_date - 1 day). The reason_ended depends on the diff:
  //   - benefit_type changed       → 'benefit_type_change'
  //   - weekly_rate changed only   → 'rate_change'
  //   - same type and rate         → 'rate_change' (still treat as a
  //     supersede; should never reach here in practice unless adjuster
  //     creates a duplicate)
  if (active) {
    const closingReason =
      active.benefit_type !== benefit_type ? 'benefit_type_change' : 'rate_change';
    const newStartDate = start_date;
    const closeDate = _addDays(newStartDate, -1);

    if (closeDate < active.start_date) {
      throw new Error('start_date must be on or after the active period start date');
    }

    await supabase
      .from('td_periods')
      .update({
        end_date:     closeDate,
        reason_ended: closingReason,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', active.id);

    await _writeClaimEvent(claimId, 'td_period_closed', {
      period_id:    active.id,
      end_date:     closeDate,
      reason_ended: closingReason,
      auto_close:   true,
      actor:        actorEmail,
    });

    await _writeAuditLog(
      'td_period_auto_closed',
      active.id,
      `Auto-closed active TD period on supersede (${closingReason})`,
      { end_date: closeDate, reason_ended: closingReason },
      actorEmail,
    );
  }

  const insertReasonStarted =
    reason_started || (active ? (active.benefit_type !== benefit_type ? 'benefit_type_change' : 'rate_change') : 'initial_disability');

  const row = {
    claim_id:                  claimId,
    benefit_type,
    start_date,
    end_date:                  null,
    weekly_rate,
    reason_started:            insertReasonStarted,
    reason_ended:              null,
    suspension_reason_code:    null,
    reinstated_from_period_id: null,
    notes:                     notes || null,
    created_at:                new Date().toISOString(),
    created_by:                actorEmail || null,
    updated_at:                new Date().toISOString(),
  };

  const { data: inserted, error } = await supabase
    .from('td_periods')
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(`tdPeriodsService.createPeriod: ${error.message}`);

  // Service-side enforcement of the unique-active-per-claim invariant.
  // The DB partial unique index also enforces this; this check is a
  // defensive guard for the in-memory test mock which does not enforce
  // partial unique indexes.
  const allOpen = (await listForClaim(claimId)).filter(p => p.end_date == null);
  if (allOpen.length > 1) {
    // Roll back the insert
    await supabase.from('td_periods').delete().eq('id', inserted.id);
    throw new Error('UNIQUE_ACTIVE_TD_PERIOD_VIOLATION');
  }

  await _writeClaimEvent(claimId, 'td_period_started', {
    period_id:    inserted.id,
    benefit_type,
    start_date,
    weekly_rate,
    actor:        actorEmail,
  });

  await _writeAuditLog(
    'td_period_started',
    inserted.id,
    `Started ${benefit_type} period at $${weekly_rate}/wk effective ${start_date}`,
    { benefit_type, start_date, weekly_rate, reason_started: insertReasonStarted },
    actorEmail,
  );

  // Auto-complete the TD_PAYMENT_SETUP diary on first period creation.
  await _completeTdSetupDiaryIfFirst(claimId, inserted.id);

  // WCIS HOOK — SROI IP / CA / CB / RE / FS.
  //   IP = first indemnity period ever on the claim
  //   FS = salary continuation start (full salary in lieu of TD)
  //   CA = rate change supersede; CB = benefit-type change supersede
  //   RE = reduced earnings (explicit flag from recordReducedEarnings)
  // Penalty hook (LC §4650(d)) remains deferred to the payment ledger.
  {
    const all = await listForClaim(claimId);
    const isFirstEver = all.length === 1;
    let wcisEvent = null;
    if (input && input.wcis_event_override) {
      wcisEvent = input.wcis_event_override;
    } else if (isFirstEver) {
      wcisEvent = benefit_type === 'salary_continuation' ? 'salary_continuation' : 'td_first_payment';
    } else if (insertReasonStarted === 'benefit_type_change') {
      wcisEvent = benefit_type === 'salary_continuation' ? 'salary_continuation' : 'td_benefit_type_changed';
    } else if (insertReasonStarted === 'rate_change') {
      wcisEvent = 'td_rate_changed';
    } else if (insertReasonStarted === 'initial_disability') {
      // New period after a gap that wasn't a reinstatement — report as
      // reinstatement of indemnity rather than a duplicate IP.
      wcisEvent = 'td_reinstated';
    }
    if (wcisEvent) {
      await _enqueueWcis(claimId, wcisEvent, inserted.id, start_date, {
        source: 'td_period', period_id: inserted.id, benefit_type, weekly_rate,
      });
    }
  }

  return inserted;
}

// ── closePeriod ───────────────────────────────────────────────────────────────

async function closePeriod(periodId, input, actorEmail) {
  const { end_date, reason_ended, notes } = input || {};

  if (!end_date || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
    throw new Error('end_date must be YYYY-MM-DD');
  }
  if (!VALID_REASON_ENDED.includes(reason_ended)) {
    throw new Error(`reason_ended must be one of: ${VALID_REASON_ENDED.join(', ')}`);
  }

  const period = await getById(periodId);
  if (!period) throw new Error(`TD period not found: ${periodId}`);
  if (period.end_date != null) {
    throw new Error('PERIOD_ALREADY_CLOSED');
  }
  if (end_date < period.start_date) {
    throw new Error('end_date must be on or after the period start_date');
  }

  const update = {
    end_date,
    reason_ended,
    updated_at: new Date().toISOString(),
  };
  if (notes) update.notes = period.notes ? `${period.notes}\n${notes}` : notes;

  const { data: updated, error } = await supabase
    .from('td_periods')
    .update(update)
    .eq('id', periodId)
    .select()
    .single();
  if (error) throw new Error(`tdPeriodsService.closePeriod: ${error.message}`);

  await _writeClaimEvent(period.claim_id, 'td_period_closed', {
    period_id:    periodId,
    end_date,
    reason_ended,
    auto_close:   false,
    actor:        actorEmail,
  });

  await _writeAuditLog(
    'td_period_closed',
    periodId,
    `Closed TD period (${reason_ended}) effective ${end_date}`,
    { end_date, reason_ended },
    actorEmail,
  );

  // WCIS HOOK — SROI Sx / Px per reason_ended (S1=rtw_full,
  // P1=rtw_modified, S2=med_noncompliance, S3=administrative,
  // S7=benefits exhausted). Reasons without an entry are reported by
  // other services or deferred — see REASON_ENDED_TO_WCIS_EVENT.
  const suspensionEvent = REASON_ENDED_TO_WCIS_EVENT[reason_ended];
  if (suspensionEvent) {
    await _enqueueWcis(period.claim_id, suspensionEvent, periodId, end_date, {
      source: 'td_period', period_id: periodId, reason_ended,
    });
  }

  return updated;
}

// ── reinstatePeriod ───────────────────────────────────────────────────────────

async function reinstatePeriod(claimId, fromPeriodId, input, actorEmail) {
  const { start_date, weekly_rate, notes } = input || {};

  if (!start_date || !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
    throw new Error('start_date must be YYYY-MM-DD');
  }
  if (!(typeof weekly_rate === 'number' && weekly_rate > 0)) {
    throw new Error('weekly_rate must be a positive number');
  }

  const source = await getById(fromPeriodId);
  if (!source) throw new Error(`Source TD period not found: ${fromPeriodId}`);
  if (source.claim_id !== claimId) {
    throw new Error('Source period does not belong to this claim');
  }
  if (source.end_date == null) {
    throw new Error('Cannot reinstate from an already-active period');
  }

  const active = await getActive(claimId);
  if (active) {
    throw new Error('Cannot reinstate while another active TD period exists');
  }

  if (start_date <= source.end_date) {
    throw new Error('reinstatement start_date must be after the source period end_date');
  }

  const row = {
    claim_id:                  claimId,
    benefit_type:              source.benefit_type,
    start_date,
    end_date:                  null,
    weekly_rate,
    reason_started:            'reinstatement',
    reason_ended:              null,
    suspension_reason_code:    null,
    reinstated_from_period_id: fromPeriodId,
    notes:                     notes || null,
    created_at:                new Date().toISOString(),
    created_by:                actorEmail || null,
    updated_at:                new Date().toISOString(),
  };

  const { data: inserted, error } = await supabase
    .from('td_periods')
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(`tdPeriodsService.reinstatePeriod: ${error.message}`);

  await _writeClaimEvent(claimId, 'td_period_reinstated', {
    period_id:                 inserted.id,
    reinstated_from_period_id: fromPeriodId,
    start_date,
    weekly_rate,
    actor:                     actorEmail,
  });

  await _writeAuditLog(
    'td_period_reinstated',
    inserted.id,
    `Reinstated TD period from ${fromPeriodId} at $${weekly_rate}/wk effective ${start_date}`,
    { start_date, weekly_rate, source_period_id: fromPeriodId },
    actorEmail,
  );

  // WCIS HOOK — SROI RB "Reinstatement of Benefits".
  await _enqueueWcis(claimId, 'td_reinstated', inserted.id, start_date, {
    source: 'td_period', period_id: inserted.id,
    reinstated_from_period_id: fromPeriodId, weekly_rate,
  });

  return inserted;
}

// ── updatePeriodMetadata ──────────────────────────────────────────────────────

async function updatePeriodMetadata(periodId, input, actorEmail) {
  const { notes, suspension_reason_code } = input || {};

  // Reject any attempt to mutate the structural fields. Adjusters who
  // need to change start_date / end_date / weekly_rate / benefit_type
  // must close the existing period and open a new one.
  const forbidden = ['start_date', 'end_date', 'weekly_rate', 'benefit_type'];
  for (const k of forbidden) {
    if (input && Object.prototype.hasOwnProperty.call(input, k)) {
      throw new Error(`Field '${k}' cannot be updated via metadata patch — close and re-open instead`);
    }
  }

  const period = await getById(periodId);
  if (!period) throw new Error(`TD period not found: ${periodId}`);

  const update = { updated_at: new Date().toISOString() };
  if (notes !== undefined)                  update.notes = notes;
  if (suspension_reason_code !== undefined) update.suspension_reason_code = suspension_reason_code;

  const { data: updated, error } = await supabase
    .from('td_periods')
    .update(update)
    .eq('id', periodId)
    .select()
    .single();
  if (error) throw new Error(`tdPeriodsService.updatePeriodMetadata: ${error.message}`);

  await _writeAuditLog(
    'td_period_metadata_updated',
    periodId,
    `Updated TD period metadata`,
    { notes, suspension_reason_code },
    actorEmail,
  );

  return updated;
}

// ── summary ───────────────────────────────────────────────────────────────────

async function summary(claimId) {
  const periods = await listForClaim(claimId);
  const today   = _today();

  let totalDays = 0;
  let totalIndemnity = 0;
  for (const p of periods) {
    const start = p.start_date;
    const end   = p.end_date || today;
    const days  = _diffDaysInclusive(start, end);
    const weeks = days / DAYS_PER_WEEK;
    totalDays      += days;
    totalIndemnity += weeks * Number(p.weekly_rate);
  }

  const totalWeeksPaid = _weeksFromDays(totalDays);
  const weeksRemaining = Math.max(0, Math.round((STATUTORY_CAP_WEEKS - totalWeeksPaid) * 100) / 100);

  const active = periods.find(p => p.end_date == null) || null;

  let projectedExhaustionDate = null;
  if (active && weeksRemaining > 0) {
    const projDays = Math.floor(weeksRemaining * DAYS_PER_WEEK);
    projectedExhaustionDate = _addDays(today, projDays);
  } else if (active && weeksRemaining === 0) {
    projectedExhaustionDate = today;
  }

  const activeBlock = active
    ? {
        id:           active.id,
        benefit_type: active.benefit_type,
        weekly_rate:  Number(active.weekly_rate),
        start_date:   active.start_date,
        days_in:      _diffDaysInclusive(active.start_date, today),
      }
    : null;

  return {
    active:                         activeBlock,
    total_weeks_paid:               totalWeeksPaid,
    total_indemnity_paid:           Math.round(totalIndemnity * 100) / 100,
    periods_count:                  periods.length,
    statutory_cap_weeks:            STATUTORY_CAP_WEEKS,   // LC §4656(c)(2)
    weeks_remaining:                weeksRemaining,
    projected_exhaustion_date:      projectedExhaustionDate,
    suspension_reason_code_active:  active ? (active.suspension_reason_code || null) : null,
  };
}

// ── Named TD operations (master-context API surface) ─────────────────────────
// Thin wrappers over createPeriod's supersede logic so callers (and the
// WCIS mapping) express intent explicitly.

async function changeTdRate(claimId, { new_rate, effective_date, notes }, actorEmail) {
  const active = await getActive(claimId);
  if (!active) throw new Error('No active TD period to change the rate on');
  return createPeriod(claimId, {
    benefit_type: active.benefit_type,
    start_date:   effective_date,
    weekly_rate:  new_rate,
    reason_started: 'rate_change',
    notes,
  }, actorEmail);
}

async function transitionBenefitType(claimId, { to_benefit_type, effective_date, weekly_rate, notes }, actorEmail) {
  const active = await getActive(claimId);
  if (!active) throw new Error('No active TD period to transition');
  if (active.benefit_type === to_benefit_type) {
    throw new Error('Claim is already on that benefit type');
  }
  return createPeriod(claimId, {
    benefit_type: to_benefit_type,
    start_date:   effective_date,
    weekly_rate:  weekly_rate != null ? weekly_rate : active.weekly_rate,
    reason_started: 'benefit_type_change',
    notes,
  }, actorEmail);
}

async function recordReducedEarnings(claimId, { effective_date, new_rate, notes }, actorEmail) {
  // Worker returned to work with wage loss — TPD on reduced earnings.
  // SROI RE rather than the generic CA/CB the supersede would fire.
  return createPeriod(claimId, {
    benefit_type: 'TPD',
    start_date:   effective_date,
    weekly_rate:  new_rate,
    reason_started: 'rate_change',
    notes,
    wcis_event_override: 'td_reduced_earnings',
  }, actorEmail);
}

async function startSalaryContinuation(claimId, { effective_date, weekly_rate, notes }, actorEmail) {
  return createPeriod(claimId, {
    benefit_type: 'salary_continuation',
    start_date:   effective_date,
    weekly_rate,
    notes,
  }, actorEmail);
}

module.exports = {
  changeTdRate,
  transitionBenefitType,
  recordReducedEarnings,
  startSalaryContinuation,
  listForClaim,
  getActive,
  getById,
  createPeriod,
  closePeriod,
  reinstatePeriod,
  updatePeriodMetadata,
  summary,
  // exposed for tests
  STATUTORY_CAP_WEEKS,
  VALID_BENEFIT_TYPES,
  VALID_REASON_ENDED,
};
