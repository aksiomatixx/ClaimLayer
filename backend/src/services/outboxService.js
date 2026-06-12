'use strict';

/**
 * outboxService.js — transactional outbox for external side effects
 * (Finding 5 of the production-hardening pass).
 *
 * External systems (FileHandler today; the WCIS pipeline already has
 * its own queue in wcis_trigger_queue) must never be mutated as a
 * silent fire-and-forget from inside a local workflow. Instead the
 * workflow enqueues an integration_outbox row INSIDE its durable local
 * unit, and dispatch happens after — opportunistically right away, and
 * via the outbox worker for anything that fails.
 *
 *   pending    — enqueued, not yet attempted (or awaiting retry)
 *   processing — claimed by a dispatcher (conditional update)
 *   succeeded  — external call confirmed
 *   failed     — terminal after MAX_ATTEMPTS; surfaced as a CRITICAL
 *                INTEGRATION_SYNC_FAILED diary, never silently dropped
 *
 * Retries are idempotent on the external side by construction: the
 * supported operations (FileHandler add_note / complete_diary) repeat
 * the same payload; a duplicated note in the ledger is visible and
 * harmless, a lost decision note is neither.
 */

const crypto       = require('crypto');
const { supabase } = require('./supabase');
const config       = require('../config');
const logger       = require('../logger');

const MAX_ATTEMPTS  = 5;
const BASE_DELAY_MS = 60 * 1000; // doubles per attempt
const LOCK_TTL_MS   = 10 * 60 * 1000;

function _id() {
  return `obx_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Enqueue outbox rows. Called INSIDE a workflow's durable unit — an
 * insert failure throws so the workflow can roll back rather than
 * complete with its external effects silently lost.
 * Each entry: { target, operation, claim_id, payload }.
 * Returns the created rows (so a compensating rollback can remove them).
 */
async function enqueue(entries) {
  const now = new Date().toISOString();
  const rows = entries.map(e => ({
    id: _id(),
    target: e.target,
    operation: e.operation,
    claim_id: e.claim_id || null,
    payload: e.payload || {},
    status: 'pending',
    attempts: 0,
    last_error: null,
    next_attempt_at: now,
    created_at: now,
    updated_at: now,
  }));
  if (rows.length === 0) return [];
  const { error } = await supabase.from('integration_outbox').insert(rows);
  if (error) throw new Error(`outbox: enqueue failed — ${error.message}`);
  return rows;
}

/** Compensating removal of rows created inside a rolled-back unit. */
async function removeRows(ids) {
  for (const id of ids) {
    await supabase.from('integration_outbox').delete().eq('id', id).eq('status', 'pending');
  }
}

// ── Operation executors ───────────────────────────────────────────────────────

async function _execute(row) {
  if (row.target === 'filehandler') {
    const filehandler = require('./filehandler');
    const p = row.payload || {};
    // The outbox row id is the operation's stable idempotency key: a
    // stale-lock replay (external call succeeded, local success-write
    // lost) re-sends the SAME key, so the system of record can dedupe
    // instead of double-writing a ledger note / diary completion.
    const opts = { idempotencyKey: row.id };
    if (row.operation === 'add_note') {
      return filehandler.addNote(p.fh_claim_id, p.note_text, p.added_by || 'ADJUSTER', 'diary', opts);
    }
    if (row.operation === 'complete_diary') {
      return filehandler.completeDiary(p.fh_claim_id, p.fh_diary_id, p.completion_note, p.completed_by || 'ADJUSTER', opts);
    }
  }
  throw new Error(`outbox: unknown target/operation ${row.target}/${row.operation}`);
}

async function _surfaceTerminalFailure(row) {
  const now = new Date().toISOString();
  const { error } = await supabase.from('diaries').insert({
    id: `diy_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    claim_id: row.claim_id,
    diary_type: 'INTEGRATION_SYNC_FAILED',
    due_date: now.split('T')[0],
    assigned_to: config.adjuster.email,
    priority: 'CRITICAL',
    status: 'open',
    no_snooze: true,
    notes: `External sync ${row.target}/${row.operation} failed after ${row.attempts} attempts: ${row.last_error}. ` +
           'The system-of-record ledger is missing this entry until resolved.',
    created_at: now,
  });
  if (error) {
    logger.error({ msg: 'outbox: failed to surface terminal failure', outboxId: row.id, err: error.message });
  }
}

/**
 * Attempt one outbox row. Claims it first (conditional update) so
 * concurrent dispatchers cannot double-execute. Returns the row's new
 * status, or null when the claim was lost.
 */
async function dispatchOne(rowId, workerId) {
  const { data: row, error } = await supabase
    .from('integration_outbox').select('*').eq('id', rowId).single();
  if (error || !row) return null;
  if (row.status !== 'pending') return null;

  const { data: claimed, error: claimErr } = await supabase
    .from('integration_outbox')
    .update({ status: 'processing', locked_by: workerId || 'inline', locked_at: new Date().toISOString() })
    .eq('id', rowId).eq('status', 'pending')
    .select();
  if (claimErr) throw new Error(`outbox: claim failed — ${claimErr.message}`);
  if (!claimed || claimed.length === 0) return null;

  const attempts = (row.attempts || 0) + 1;
  try {
    await _execute(row);
    await supabase.from('integration_outbox').update({
      status: 'succeeded', attempts, last_error: null,
      locked_by: null, locked_at: null,
      succeeded_at: new Date().toISOString(),
    }).eq('id', rowId);
    return 'succeeded';
  } catch (e) {
    const terminal = attempts >= MAX_ATTEMPTS;
    const nextAttempt = new Date(Date.now() + BASE_DELAY_MS * 2 ** (attempts - 1)).toISOString();
    await supabase.from('integration_outbox').update({
      status: terminal ? 'failed' : 'pending',
      attempts, last_error: e.message,
      locked_by: null, locked_at: null,
      next_attempt_at: terminal ? null : nextAttempt,
    }).eq('id', rowId);
    if (terminal) {
      logger.error({ msg: 'outbox: terminal failure', outboxId: rowId, target: row.target, operation: row.operation, err: e.message });
      await _surfaceTerminalFailure({ ...row, attempts, last_error: e.message });
      return 'failed';
    }
    logger.warn({ msg: 'outbox: attempt failed — will retry', outboxId: rowId, attempts, err: e.message });
    return 'pending';
  }
}

/**
 * Worker pass: dispatch every due pending row; reclaim stale
 * processing locks from crashed dispatchers.
 */
async function dispatchPending(workerId) {
  const owner = workerId || _id();
  const { data, error } = await supabase.from('integration_outbox').select('*');
  if (error) throw new Error(`outbox: scan failed — ${error.message}`);

  const now = Date.now();
  const outcomes = [];
  for (const row of data || []) {
    if (row.status === 'processing' && row.locked_at && (now - Date.parse(row.locked_at)) > LOCK_TTL_MS) {
      const { data: reclaimed } = await supabase
        .from('integration_outbox')
        .update({ status: 'pending', locked_by: null, locked_at: null })
        .eq('id', row.id).eq('status', 'processing').eq('locked_at', row.locked_at)
        .select();
      if (!reclaimed || reclaimed.length === 0) continue;
      row.status = 'pending';
    }
    if (row.status !== 'pending') continue;
    if (row.next_attempt_at && Date.parse(row.next_attempt_at) > now) continue;
    const result = await dispatchOne(row.id, owner);
    if (result) outcomes.push({ id: row.id, status: result });
  }
  return outcomes;
}

module.exports = {
  enqueue,
  removeRows,
  dispatchOne,
  dispatchPending,
  MAX_ATTEMPTS,
  LOCK_TTL_MS,
};
