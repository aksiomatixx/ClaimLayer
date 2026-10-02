'use strict';

/**
 * reserveLedgerService.js — Phase 3 Immutable Double-Entry Reserve Ledger.
 *
 * Implements the financial system of record for reserves. Every change to a
 * claim's reserve position is written to `reserve_transactions` as an immutable,
 * append-only entry with explicit `amount_delta`, `resulting_balance`, and
 * `incurred_delta`.
 *
 * Invariant:
 *   Total Incurred = Total Paid to Date + Outstanding Reserves
 *
 * Transaction Types:
 *   - 'initial_reserve': Initial baseline allocation (incurred_delta = amount_delta)
 *   - 'reserve_revision': Upward or downward adjustment (incurred_delta = amount_delta)
 *   - 'payment_reduction': Disbursement against reserves (incurred_delta = 0)
 *   - 'payment_void': Reversal of a payment_reduction (incurred_delta = 0; paid goes down)
 *   - 'recovery_subrogation': Third-party subrogation recovery (incurred_delta = -amount_delta)
 *   - 'closing_reduction': Final reserve zero-out at closure (incurred_delta = amount_delta)
 *
 * A category's balance is the SUM of its amount_delta — independent of row
 * order or timestamps — read under a per-claim transaction lock
 * (lockClaimLedger), so two concurrent postings cannot both start from the
 * same balance. resulting_balance is a stored snapshot of that sum.
 */

const crypto        = require('crypto');
const { supabase }  = require('./supabase');
const logger        = require('../logger');
const auditLedger   = require('./auditLedgerService');
const { runInTransaction } = require('../db/unitOfWork');
const config        = require('../config');

const CATEGORIES = Object.freeze(['medical', 'indemnity', 'expense']);
const TRANSACTION_TYPES = Object.freeze([
  'initial_reserve',
  'reserve_revision',
  'payment_reduction',
  'payment_void',
  'recovery_subrogation',
  'closing_reduction',
]);

const _round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Serialize every ledger posting on one claim for the rest of the
 * transaction (pg mode). Payment issuance takes it before its duplicate check,
 * so the check and the insert are one critical section. Reentrant within a
 * transaction. Compatibility mode has no transactions and no lock.
 */
async function lockClaimLedger(tx, claimId) {
  if (tx && tx.mode === 'pg') {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`claim-ledger:${claimId}`]);
  }
}

/** A category's balance: the sum of its deltas (order-independent). */
async function _getCategoryBalance(claimId, category, tx = null) {
  if (tx && tx.mode === 'pg') {
    const rows = await tx.query(
      `SELECT coalesce(sum(amount_delta), 0)::float8 AS balance, count(*)::int AS n
         FROM reserve_transactions WHERE claim_id = $1 AND category = $2`, [claimId, category]);
    return { balance: _round2(rows[0].balance), entries: rows[0].n };
  }
  const rows = tx
    ? await tx.select('reserve_transactions', { claim_id: claimId, category })
    : await _selectLedger(claimId, { category });
  return {
    balance: _round2(rows.reduce((sum, r) => sum + Number(r.amount_delta), 0)),
    entries: rows.length,
  };
}

async function _selectLedger(claimId, { category } = {}) {
  let query = supabase.from('reserve_transactions').select('*').eq('claim_id', claimId);
  if (category) query = query.eq('category', category);
  const { data, error } = await query;
  if (error) {
    logger.error({ msg: 'reserveLedgerService: ledger read failed', err: error.message, claimId });
    throw new Error(`Failed to read reserve ledger: ${error.message}`);
  }
  return data || [];
}

/**
 * Post a single transaction to the immutable reserve ledger.
 * Runs inside the caller's transaction (`opts.tx`) or initiates its own unit of work.
 */
async function postTransaction({
  tenantId,
  claimId,
  category,
  amountDelta,
  transactionType,
  reason,
  source = 'ADJUSTER',
  createdBy = null,
  actionRequestId = null,
}, opts = {}) {
  if (!claimId) throw new Error('claimId is required');
  if (!CATEGORIES.includes(category)) {
    throw new Error(`category must be one of: ${CATEGORIES.join(', ')}`);
  }
  if (!TRANSACTION_TYPES.includes(transactionType)) {
    throw new Error(`transactionType must be one of: ${TRANSACTION_TYPES.join(', ')}`);
  }

  const delta = _round2(amountDelta);
  if (!Number.isFinite(delta)) {
    throw new Error('amountDelta must be a finite number');
  }

  const effectiveTenantId = tenantId || opts.tenantId || config.tenancy.defaultTenantId;

  const run = async (tx) => {
    await lockClaimLedger(tx, claimId);
    const { balance: currentBalance } = await _getCategoryBalance(claimId, category, tx);
    const resultingBalance = _round2(currentBalance + delta);

    if (resultingBalance < 0) {
      throw new Error(
        `RESERVE_BALANCE_NEGATIVE: Cannot reduce ${category} reserve below 0. ` +
        `Current: ${currentBalance}, delta: ${delta}, resulting: ${resultingBalance}`
      );
    }

    // Incurred calculation
    let incurredDelta = 0;
    if (transactionType === 'payment_reduction' || transactionType === 'payment_void') {
      // A payment (or its void) moves dollars between reserve and paid;
      // total incurred is unchanged.
      incurredDelta = 0;
    } else if (transactionType === 'recovery_subrogation') {
      // Recovery reduces incurred
      incurredDelta = _round2(-delta);
    } else {
      // initial_reserve, reserve_revision, closing_reduction directly change incurred
      incurredDelta = delta;
    }

    const now = new Date().toISOString();
    const row = {
      id: crypto.randomUUID(),
      tenant_id: effectiveTenantId,
      claim_id: claimId,
      action_request_id: actionRequestId || null,
      category,
      transaction_type: transactionType,
      amount_delta: delta,
      resulting_balance: resultingBalance,
      incurred_delta: incurredDelta,
      reason: reason || null,
      source: source || 'ADJUSTER',
      created_by: createdBy || null,
      created_at: now,
    };

    if (tx) {
      await tx.insert('reserve_transactions', row);
    } else {
      const { error: insErr } = await supabase.from('reserve_transactions').insert(row);
      if (insErr) throw new Error(`reserveLedger: insert failed — ${insErr.message}`);
    }

    // Audit ledger event. A caller that records the business action in the
    // ledger itself (reserve approval, payment issue/void) passes audit: false.
    if (opts.audit !== false) {
      await auditLedger.append({
        actor: opts.actor || (createdBy
          ? { type: 'human', id: createdBy, role: 'adjuster' }
          : { type: 'system', id: 'system', role: 'system' }),
        action: 'reserve.transaction_posted',
        entity: { type: 'claim', id: claimId },
        claimId,
        tenantId: effectiveTenantId,
        payload: {
          transaction_id: row.id,
          category,
          transaction_type: transactionType,
          amount_delta: delta,
          resulting_balance: resultingBalance,
          incurred_delta: incurredDelta,
          reason: row.reason,
        },
        evidence: actionRequestId ? [{ type: 'action_request', id: actionRequestId }] : [],
      }, { tx });
    }

    // Claim event for the UI timeline (the caller's own event may stand in).
    if (opts.event === false) return row;
    const eventRow = {
      claim_id: claimId,
      type: 'reserve_transaction_posted',
      timestamp: now,
      data: {
        transactionId: row.id,
        category,
        transactionType,
        amountDelta: delta,
        resultingBalance,
        incurredDelta,
        actionRequestId,
        createdBy,
      },
    };
    if (tx) {
      await tx.insert('claim_events', eventRow);
    } else {
      await supabase.from('claim_events').insert(eventRow);
    }

    return row;
  };

  return opts.tx
    ? run(opts.tx)
    : runInTransaction({ tenantId: effectiveTenantId, label: 'reserve.post_transaction' }, run);
}

/**
 * Get comprehensive financial balances for a claim:
 *   - outstanding reserves per category & total
 *   - paid to date per category & total
 *   - total incurred per category & total
 */
async function getBalances(claimId, opts = {}) {
  const rows = opts.tx
    ? (opts.tx.mode === 'pg'
      ? await opts.tx.query('SELECT * FROM reserve_transactions WHERE claim_id = $1', [claimId])
      : await opts.tx.select('reserve_transactions', { claim_id: claimId }))
    : await _selectLedger(claimId);

  const txs = rows || [];
  const categories = {};
  for (const cat of CATEGORIES) {
    categories[cat] = {
      outstanding: 0,
      paid_to_date: 0,
      total_incurred: 0,
    };
  }

  for (const t of txs) {
    const cat = t.category;
    if (!categories[cat]) continue;

    const delta = Number(t.amount_delta);
    const incDelta = Number(t.incurred_delta);

    categories[cat].outstanding = _round2(categories[cat].outstanding + delta);

    if (t.transaction_type === 'payment_reduction') {
      // A payment moves its amount into paid-to-date (delta is negative)
      categories[cat].paid_to_date = _round2(categories[cat].paid_to_date - delta);
    } else if (t.transaction_type === 'payment_void') {
      // Its void moves it back out (delta is positive)
      categories[cat].paid_to_date = _round2(categories[cat].paid_to_date - delta);
    }

    categories[cat].total_incurred = _round2(categories[cat].total_incurred + incDelta);
  }

  const totals = {
    outstanding_reserves: _round2(CATEGORIES.reduce((s, c) => s + categories[c].outstanding, 0)),
    paid_to_date: _round2(CATEGORIES.reduce((s, c) => s + categories[c].paid_to_date, 0)),
    total_incurred: _round2(CATEGORIES.reduce((s, c) => s + categories[c].total_incurred, 0)),
  };

  return {
    claim_id: claimId,
    categories,
    totals,
  };
}

/**
 * Query transaction history for a claim.
 */
async function getTransactions(claimId, filters = {}) {
  let query = supabase
    .from('reserve_transactions')
    .select('*')
    .eq('claim_id', claimId)
    .order('created_at', { ascending: false });

  if (filters.category) {
    query = query.eq('category', filters.category);
  }
  if (filters.transactionType) {
    query = query.eq('transaction_type', filters.transactionType);
  }

  const { data, error } = await query;
  if (error) {
    logger.error({ msg: 'reserveLedgerService.getTransactions failed', err: error.message, claimId });
    throw new Error(`Failed to load reserve transactions: ${error.message}`);
  }

  return data || [];
}

/**
 * Move each category's outstanding reserve to an approved target, posting
 * only the differences — inside the caller's unit of work, under the claim
 * ledger lock. Used by reserve approval (claimService), which records the
 * approval itself in the audit ledger and the claim timeline.
 */
async function postToTargets({ tenantId, claimId, targets, reason, createdBy, actionRequestId = null }, opts = {}) {
  if (!opts.tx) throw new Error('postToTargets requires the caller\'s unit of work (opts.tx)');
  await lockClaimLedger(opts.tx, claimId);
  const posted = [];
  for (const category of CATEGORIES) {
    if (targets[category] === undefined || targets[category] === null) continue;
    const target = _round2(targets[category]);
    if (!Number.isFinite(target) || target < 0) throw new Error(`${category} reserve target must be a non-negative number`);
    const { balance, entries } = await _getCategoryBalance(claimId, category, opts.tx);
    const delta = _round2(target - balance);
    if (delta === 0) continue;
    posted.push(await postTransaction({
      tenantId, claimId, category, amountDelta: delta,
      transactionType: entries === 0 ? 'initial_reserve' : 'reserve_revision',
      reason, source: 'ADJUSTER', createdBy, actionRequestId,
    }, { ...opts, audit: false, event: false }));
  }
  return posted;
}

module.exports = {
  CATEGORIES,
  TRANSACTION_TYPES,
  lockClaimLedger,
  postToTargets,
  postTransaction,
  getBalances,
  getTransactions,
};
