'use strict';

/**
 * lossFundService.js — Phase 3 Client Loss-Fund Escrow & Bank Reconciliation.
 *
 * Implements escrow management for staffing clients:
 *   1. Escrow Balance Tracking: Client-funded accounts dedicated to benefit disbursements.
 *   2. Automated Replenishment Alerts: Flags accounts when balance falls below threshold
 *      and calculates required client funding.
 *   3. Bank Statement Reconciliation: Matches bank clearing feed against issued
 *      payment transactions, finalizing the payment lifecycle.
 */

const crypto        = require('crypto');
const { supabase }  = require('./supabase');
const logger        = require('../logger');
const auditLedger   = require('./auditLedgerService');
const { runInTransaction } = require('../db/unitOfWork');
const { toCents, fromCents } = require('../utils/money');
const config        = require('../config');

const _round2 = (n) => Math.round(Number(n) * 100) / 100;

// The principal an escrow movement is attributed to (routes pass the human).
function _actor(actor) {
  if (actor && actor.type && actor.id) return actor;
  return { type: 'system', id: 'system', role: 'system' };
}

// Status after a balance change. A frozen or closed account keeps its status:
// money movements never reopen it (that is a separate, deliberate decision).
function _statusAfter(account, newBalance) {
  if (account.status === 'frozen' || account.status === 'closed') return account.status;
  return newBalance >= Number(account.minimum_threshold) ? 'active' : 'replenishment_needed';
}

// Re-read the account under a row lock inside the unit, so two concurrent
// movements cannot both start from the same balance.
async function _lockAccount(tx, accountId, tenantId) {
  const account = await tx.selectOne('loss_fund_accounts', { id: accountId }, { forUpdate: true });
  if (!account || (tenantId && account.tenant_id !== tenantId)) {
    throw new Error(`Loss fund account not found: ${accountId}`);
  }
  return account;
}

async function createAccount(input, opts = {}) {
  const {
    tenantId,
    employerId,
    accountNumber,
    bankName,
    initialDeposit = 0,
    minimumThreshold = 10000,
    targetReplenishmentAmount = 50000,
  } = input || {};

  if (!employerId) throw new Error('employerId is required');
  if (!accountNumber) throw new Error('accountNumber is required');

  const effectiveTenantId = tenantId || opts.tenantId || config.tenancy.defaultTenantId;
  const initBal = _round2(initialDeposit);
  const minThresh = _round2(minimumThreshold);
  const targetRep = _round2(targetReplenishmentAmount);
  const now = new Date().toISOString();

  const accountId = crypto.randomUUID();
  const accountRow = {
    id:                          accountId,
    tenant_id:                   effectiveTenantId,
    employer_id:                 employerId,
    account_number:              accountNumber,
    bank_name:                   bankName || null,
    escrow_balance:              initBal,
    minimum_threshold:           minThresh,
    target_replenishment_amount: targetRep,
    status:                      initBal < minThresh ? 'replenishment_needed' : 'active',
    created_at:                  now,
    updated_at:                  now,
  };

  const run = async (tx) => {
    await tx.insert('loss_fund_accounts', accountRow);

    if (initBal > 0) {
      const txRow = {
        id:                crypto.randomUUID(),
        tenant_id:         effectiveTenantId,
        account_id:        accountId,
        claim_id:          null,
        transaction_type:  'client_deposit',
        amount:            initBal,
        resulting_balance: initBal,
        reference:         'Initial opening escrow deposit',
        notes:             'Opening balance funded by staffing client',
        created_by:        _actor(opts.actor).id,
        created_at:        now,
      };
      await tx.insert('loss_fund_transactions', txRow);
    }

    await auditLedger.append({
      actor: _actor(opts.actor),
      action: 'loss_fund.account_created',
      entity: { type: 'employer', id: employerId },
      tenantId: effectiveTenantId,
      payload: { account_id: accountId, initial_deposit: initBal, minimum_threshold: minThresh },
    }, { tx });

    return accountRow;
  };

  return opts.tx
    ? run(opts.tx)
    : runInTransaction({ tenantId: effectiveTenantId, label: 'loss_fund.create_account' }, run);
}

async function getAccount(accountId) {
  const { data, error } = await supabase
    .from('loss_fund_accounts')
    .select('*')
    .eq('id', accountId)
    .single();

  if (error || !data) return null;
  return data;
}

async function getAccountByEmployer(employerId, { tenantId = null } = {}) {
  let query = supabase
    .from('loss_fund_accounts')
    .select('*')
    .eq('employer_id', employerId);
  if (tenantId) query = query.eq('tenant_id', tenantId);
  const { data, error } = await query.single();

  if (error || !data) return null;
  return data;
}

/**
 * Record a client deposit (replenishment) into the loss fund account.
 */
async function recordDeposit(accountId, amount, { reference, notes, actor } = {}, opts = {}) {
  const amt = _round2(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Deposit amount must be positive');

  const known = await getAccount(accountId);
  if (!known || (opts.tenantId && known.tenant_id !== opts.tenantId)) {
    throw new Error(`Loss fund account not found: ${accountId}`);
  }
  const effectiveTenantId = known.tenant_id || opts.tenantId || config.tenancy.defaultTenantId;
  const who = _actor(actor);

  const run = async (tx) => {
    const account = await _lockAccount(tx, accountId, effectiveTenantId);
    if (account.status === 'closed') throw new Error(`Loss fund account ${accountId} is closed`);
    const newBal = _round2(Number(account.escrow_balance) + amt);
    const newStatus = _statusAfter(account, newBal);
    const now = new Date().toISOString();

    await tx.update('loss_fund_accounts', {
      escrow_balance: newBal,
      status:         newStatus,
      updated_at:     now,
    }, { id: accountId });

    const txRow = {
      id:                crypto.randomUUID(),
      tenant_id:         effectiveTenantId,
      account_id:        accountId,
      transaction_type:  'client_deposit',
      amount:            amt,
      resulting_balance: newBal,
      reference:         reference || null,
      notes:             notes || null,
      created_by:        who.id,
      created_at:        now,
    };
    await tx.insert('loss_fund_transactions', txRow);

    await auditLedger.append({
      actor: who,
      action: 'loss_fund.deposit_recorded',
      entity: { type: 'employer', id: account.employer_id },
      tenantId: effectiveTenantId,
      payload: { account_id: accountId, amount_cents: toCents(amt), new_balance: newBal },
    }, { tx });

    return { account_id: accountId, new_balance: newBal, status: newStatus, deposit_id: txRow.id };
  };

  return opts.tx
    ? run(opts.tx)
    : runInTransaction({ tenantId: effectiveTenantId, actorId: who.id, label: 'loss_fund.record_deposit' }, run);
}

/**
 * Record a disbursement debit from the client loss fund account.
 */
async function recordDisbursementDebit(accountId, amount, { claimId, paymentTransactionId, reference, notes, actor } = {}, opts = {}) {
  const amt = _round2(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Debit amount must be positive');

  const known = await getAccount(accountId);
  if (!known || (opts.tenantId && known.tenant_id !== opts.tenantId)) {
    throw new Error(`Loss fund account not found: ${accountId}`);
  }
  const effectiveTenantId = known.tenant_id || opts.tenantId || config.tenancy.defaultTenantId;
  const who = _actor(actor);

  const run = async (tx) => {
    const account = await _lockAccount(tx, accountId, effectiveTenantId);
    if (account.status === 'frozen' || account.status === 'closed') {
      throw new Error(`Loss fund account ${accountId} is ${account.status}: no debits`);
    }
    const newBal = _round2(Number(account.escrow_balance) - amt);
    const newStatus = _statusAfter(account, newBal);
    const now = new Date().toISOString();

    await tx.update('loss_fund_accounts', {
      escrow_balance: newBal,
      status:         newStatus,
      updated_at:     now,
    }, { id: accountId });

    const txRow = {
      id:                     crypto.randomUUID(),
      tenant_id:              effectiveTenantId,
      account_id:             accountId,
      claim_id:               claimId || null,
      payment_transaction_id: paymentTransactionId || null,
      transaction_type:       'disbursement_debit',
      amount:                 -amt, // Negative for debit
      resulting_balance:      newBal,
      reference:              reference || null,
      notes:                  notes || null,
      created_by:             who.id,
      created_at:             now,
    };
    await tx.insert('loss_fund_transactions', txRow);

    await auditLedger.append({
      actor: who,
      action: 'loss_fund.debit_recorded',
      entity: { type: 'employer', id: account.employer_id },
      claimId: claimId || null,
      tenantId: effectiveTenantId,
      payload: { account_id: accountId, amount_cents: toCents(amt), new_balance: newBal,
                 payment_transaction_id: paymentTransactionId || null },
    }, { tx });

    if (newBal < Number(account.minimum_threshold)) {
      const replenishmentDue = _round2(Number(account.target_replenishment_amount) - newBal);
      logger.warn({
        msg: 'lossFundService: REPLENISHMENT_CALL_TRIGGERED',
        accountId,
        currentBal: newBal,
        minThresh: Number(account.minimum_threshold),
        replenishmentDue,
      });
    }

    return { account_id: accountId, new_balance: newBal, status: newStatus, debit_id: txRow.id };
  };

  return opts.tx
    ? run(opts.tx)
    : runInTransaction({ tenantId: effectiveTenantId, actorId: who.id, label: 'loss_fund.record_debit' }, run);
}

/**
 * Bank statement clearing reconciliation.
 * Takes a feed of cleared bank transactions (check numbers or trace IDs) and reconciles
 * them against issued payment transactions.
 */
async function reconcileClearedPayments(clearedFeed, { actor } = {}, opts = {}) {
  if (!Array.isArray(clearedFeed) || clearedFeed.length === 0) {
    return { matched_count: 0, cleared_total: 0, matched: [], unmatched: [] };
  }
  if (!opts.tenantId) throw new Error('reconcileClearedPayments requires the caller\'s tenant (opts.tenantId)');
  const who = _actor(actor);

  return runInTransaction({ tenantId: opts.tenantId, actorId: who.id, label: 'payments.reconcile_cleared' }, async (tx) => {
    const matched = [];
    const unmatched = [];
    let clearedTotal = 0;
    const now = new Date().toISOString();

    for (const item of clearedFeed) {
      const { checkNumber, amount, clearedDate } = item || {};
      if (!checkNumber) {
        unmatched.push({ ...item, reason: 'MISSING_CHECK_NUMBER' });
        continue;
      }

      // Only this tenant's issued payments; voided or already-cleared ones never match.
      const payments = await tx.select('payment_transactions', {
        tenant_id: opts.tenantId, check_number: String(checkNumber), status: { in: ['issued', 'approved'] },
      });
      const match = payments.find(p => Math.abs(Number(p.amount) - Number(amount)) < 0.01);
      if (!match) {
        unmatched.push({ ...item, reason: 'NO_MATCHING_ISSUED_PAYMENT' });
        continue;
      }

      const flipped = await tx.update('payment_transactions', {
        status:     'cleared',
        cleared_at: clearedDate || now,
        updated_at: now,
      }, { id: match.id, status: match.status });
      if (!flipped.length) {
        unmatched.push({ ...item, reason: 'PAYMENT_CHANGED_DURING_RECONCILIATION' });
        continue;
      }

      await auditLedger.append({
        actor: who,
        action: 'payment.cleared',
        entity: { type: 'payment', id: match.id },
        claimId: match.claim_id,
        tenantId: opts.tenantId,
        payload: { check_number: String(checkNumber), amount_cents: toCents(Number(match.amount)), cleared_at: clearedDate || now },
      }, { tx });

      matched.push({
        payment_id:   match.id,
        claim_id:     match.claim_id,
        check_number: checkNumber,
        amount:       Number(match.amount),
      });
      clearedTotal = _round2(clearedTotal + Number(match.amount));
    }

    logger.info({
      msg: 'lossFundService.reconcileClearedPayments: reconciliation complete',
      matchedCount: matched.length,
      unmatchedCount: unmatched.length,
      clearedTotal,
    });

    return {
      matched_count: matched.length,
      cleared_total: clearedTotal,
      matched,
      unmatched,
    };
  });
}

module.exports = {
  createAccount,
  getAccount,
  getAccountByEmployer,
  recordDeposit,
  recordDisbursementDebit,
  reconcileClearedPayments,
};
