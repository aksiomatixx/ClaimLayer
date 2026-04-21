'use strict';

/**
 * wcisDeadlineMonitor.js — M22A daily cron: WCIS deadline
 * monitoring + ack-overdue detection + missed-deadline flagging.
 *
 * Runs daily at 06:00 UTC. Three passes:
 *   1. Approaching — pending/processing trigger rows with
 *      deadline_date <= today+3 → WCIS_DEADLINE_APPROACHING diary (CRITICAL).
 *   2. Ack overdue — transmitted transactions with no ack and
 *      transmitted_at < today − 5 business days →
 *      WCIS_ACK_OVERDUE diary (CRITICAL).
 *   3. Missed — pending trigger rows with deadline_date < today →
 *      WCIS_DEADLINE_MISSED diary (CRITICAL; LC §129.5(a)(3) exposure).
 *
 * Companion crons registered alongside:
 *   - wcisQueueScanner (every 30 min) → batchAndTransmit
 *   - wcisAckPoller    (every 15 min) → pollAcksForEnvironment
 *
 * All passes use query-level filters to approximate
 * FOR UPDATE SKIP LOCKED — overlap safety is best-effort via
 * time-window diary dedup.
 */

const { supabase } = require('../services/supabase');
const logger       = require('../logger');
const wcisTransmissionService = require('../services/wcisTransmissionService');
const { addBusinessDays } = require('../utils/businessDays');
const { ENVIRONMENTS }    = require('../constants/wcisConstants');

function _today() {
  return new Date().toISOString().slice(0, 10);
}

function _plusDays(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Pass 1: approaching ─────────────────────────────────────────
async function scanApproaching() {
  const threshold = _plusDays(3);
  const { data, error } = await supabase
    .from('wcis_trigger_queue')
    .select('id,claim_id,trigger_event,mtc_family,mtc_code,deadline_date,status');
  if (error) {
    logger.error({ msg: 'wcisDeadlineMonitor.scanApproaching: query failed', err: error.message });
    return 0;
  }
  const today = _today();
  const approaching = (data || []).filter((r) =>
    ['pending','processing'].includes(r.status) &&
    r.deadline_date <= threshold &&
    r.deadline_date >= today
  );
  for (const row of approaching) {
    await _createDiary(
      row.claim_id, 'WCIS_DEADLINE_APPROACHING', row.deadline_date,
      `${row.mtc_family} ${row.mtc_code} (${row.trigger_event}) due ${row.deadline_date}.`,
    );
  }
  return approaching.length;
}

// ─── Pass 2: ack overdue ─────────────────────────────────────────
async function scanAckOverdue() {
  const cutoff = addBusinessDays(_today(), -5).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('wcis_transactions')
    .select('id,claim_id,mtc_family,mtc_code,transmitted_at,status,ack_received_at');
  if (error) {
    logger.error({ msg: 'wcisDeadlineMonitor.scanAckOverdue: query failed', err: error.message });
    return 0;
  }
  const overdue = (data || []).filter((r) =>
    ['transmitted','stub_transmitted'].includes(r.status) &&
    !r.ack_received_at &&
    r.transmitted_at &&
    r.transmitted_at.slice(0, 10) < cutoff
  );
  for (const row of overdue) {
    await _createDiary(
      row.claim_id, 'WCIS_ACK_OVERDUE', _today(),
      `${row.mtc_family} ${row.mtc_code} transmitted ${row.transmitted_at} — no ack after 5 business days.`,
    );
  }
  return overdue.length;
}

// ─── Pass 3: missed ──────────────────────────────────────────────
async function scanMissed() {
  const today = _today();
  const { data, error } = await supabase
    .from('wcis_trigger_queue')
    .select('id,claim_id,trigger_event,mtc_family,mtc_code,deadline_date,status');
  if (error) {
    logger.error({ msg: 'wcisDeadlineMonitor.scanMissed: query failed', err: error.message });
    return 0;
  }
  const missed = (data || []).filter((r) =>
    r.status === 'pending' && r.deadline_date < today
  );
  for (const row of missed) {
    await _createDiary(
      row.claim_id, 'WCIS_DEADLINE_MISSED', today,
      `MISSED: ${row.mtc_family} ${row.mtc_code} (${row.trigger_event}) ` +
      `was due ${row.deadline_date}. LC §129.5(a)(3) penalty exposure.`,
    );
  }
  return missed.length;
}

async function _createDiary(claimId, diaryType, dueDate, notes) {
  // TODO(M17B): route CRITICAL / license-gated diaries to licensed
  // adjuster instead of system@homecaretpa.com.
  // Dedup: if an open diary of the same type exists on this claim
  // in the last 24h, skip.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: existing } = await supabase
    .from('diaries')
    .select('id,created_at,status')
    .eq('claim_id', claimId)
    .eq('diary_type', diaryType)
    .eq('status', 'open');
  if ((existing || []).some((d) => d.created_at >= since)) return;

  await supabase.from('diaries').insert({
    claim_id:    claimId,
    diary_type:  diaryType,
    due_date:    dueDate,
    assigned_to: 'system@homecaretpa.com',
    priority:    'CRITICAL',
    notes,
    status:      'open',
    fh_diary_id: `diy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    created_at:  new Date().toISOString(),
  });
}

// ─── run (entry point) ───────────────────────────────────────────
async function run() {
  const approaching = await scanApproaching();
  const overdue     = await scanAckOverdue();
  const missed      = await scanMissed();
  logger.info({
    msg: 'wcisDeadlineMonitor: complete',
    approaching, overdue, missed,
  });
  return { approaching, overdue, missed };
}

// ─── Companion cron: wcisQueueScanner ────────────────────────────
async function runQueueScanner() {
  let total = { transmissions_created: 0, transactions_sent: 0 };
  for (const env of ENVIRONMENTS) {
    const r = await wcisTransmissionService.batchAndTransmit(env);
    total.transmissions_created += r.transmissions_created;
    total.transactions_sent     += r.transactions_sent;
  }
  logger.info({ msg: 'wcisQueueScanner: complete', ...total });
  return total;
}

// ─── Companion cron: wcisAckPoller ───────────────────────────────
async function runAckPoller() {
  let applied = 0;
  for (const env of ENVIRONMENTS) {
    const r = await wcisTransmissionService.pollAcksForEnvironment(env);
    applied += r.applied;
  }
  logger.info({ msg: 'wcisAckPoller: complete', applied });
  return { applied };
}

module.exports = {
  run,
  runQueueScanner,
  runAckPoller,
  scanApproaching,
  scanAckOverdue,
  scanMissed,
  _createDiary,
};
