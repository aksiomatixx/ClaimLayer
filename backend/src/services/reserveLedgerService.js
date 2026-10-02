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
 *   - 'recovery_subrogation': Third-party subrogation recovery (incurred_delta = -amount_delta)
 *   - 'closing_reduction': Final reserve zero-out at closure (incurred_delta = amount_delta)
 */

const crypto        = require('crypto');
const { supabase }  = require('./supabase');
const logger        = require('../logger');
const auditLedger   = require('./auditLedgerService');
const { runInTransaction } = require('../db/unitOfWork');
const config        = require('../config');

let _reserveTxSeq = 0;

const CATEGORIES = Object.freeze(['medical', 'indemnity', 'expense']);
const TRANSACTION_TYPES = Object.freeze([
  'initial_reserve',
  'reserve_revision',
  'payment_reduction',
  'recovery_subrogation',
  'closing_reduction',
]);

const _round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Fetch the latest balance for a specific category on a claim.
 */
async function _getCategoryBalance(claimId, category, tx = null) {
  if (tx) {
    const rows = await tx.select('reserve_transactions', {
      claim_id: claimId,
      category,
    }, { orderBy: ['created_at', 'desc'], limit: 1 });
    return rows && rows.length ? Number(rows[0].resulting_balance) : 0;
  }

  const { data, error } = await supabase
    .from('reserve_transactions')
    .select('resulting_balance')
    .eq('claim_id', claimId)
    .eq('category', category)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    logger.error({ msg: 'reserveLedgerService._getCategoryBalance failed', err: error.message, claimId, category });
    throw new Error(`Failed to read reserve balance: ${error.message}`);
  }
  return data && data.length ? Number(data[0].resulting_balance) : 0;
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
    const currentBalance = await _getCategoryBalance(claimId, category, tx);
    const resultingBalance = _round2(currentBalance + delta);

    if (resultingBalance < 0) {
      throw new Error(
        `RESERVE_BALANCE_NEGATIVE: Cannot reduce ${category} reserve below 0. ` +
        `Current: ${currentBalance}, delta: ${delta}, resulting: ${resultingBalance}`
      );
    }

    // Incurred calculation
    let incurredDelta = 0;
    if (transactionType === 'payment_reduction') {
      // Payment moves dollars from reserve to paid; total incurred is unchanged
      incurredDelta = 0;
    } else if (transactionType === 'recovery_subrogation') {
      // Recovery reduces incurred
      incurredDelta = _round2(-delta);
    } else {
      // initial_reserve, reserve_revision, closing_reduction directly change incurred
      incurredDelta = delta;
    }

    const now = new Date(Date.now() + (++_reserveTxSeq)).toISOString();
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

    // Audit ledger event
    if (opts.audit !== false) {
      await auditLedger.append({
        actor: { type: 'human', id: createdBy || 'adjuster', role: 'adjuster' },
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

    // Claim event for UI timeline
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
  const { data: rows, error } = await supabase
    .from('reserve_transactions')
    .select('*')
    .eq('claim_id', claimId)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error({ msg: 'reserveLedgerService.getBalances failed', err: error.message, claimId });
    throw new Error(`Failed to load reserve ledger: ${error.message}`);
  }

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

    // Latest resulting balance
    categories[cat].outstanding = Number(t.resulting_balance);

    if (t.transaction_type === 'payment_reduction') {
      // Reductions from payments contribute to paid-to-date (delta is negative)
      categories[cat].paid_to_date = _round2(categories[cat].paid_to_date + Math.abs(delta));
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

module.exports = {
  CATEGORIES,
  TRANSACTION_TYPES,
  postTransaction,
  getBalances,
  getTransactions,
};
