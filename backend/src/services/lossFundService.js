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
    if (tx) {
      await tx.insert('loss_fund_accounts', accountRow);
    } else {
      const { error } = await supabase.from('loss_fund_accounts').insert(accountRow);
      if (error) throw new Error(`createAccount failed: ${error.message}`);
    }

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
        created_by:        opts.actor?.id || 'admin',
        created_at:        now,
      };
      if (tx) {
        await tx.insert('loss_fund_transactions', txRow);
      } else {
        await supabase.from('loss_fund_transactions').insert(txRow);
      }
    }

    await auditLedger.append({
      actor: { type: 'human', id: opts.actor?.id || 'admin', role: 'admin' },
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

async function getAccountByEmployer(employerId) {
  const { data, error } = await supabase
    .from('loss_fund_accounts')
    .select('*')
    .eq('employer_id', employerId)
    .single();

  if (error || !data) return null;
  return data;
}

/**
 * Record a client deposit (replenishment) into the loss fund account.
 */
async function recordDeposit(accountId, amount, { reference, notes, actor } = {}, opts = {}) {
  const amt = _round2(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Deposit amount must be positive');

  const account = await getAccount(accountId);
  if (!account) throw new Error(`Loss fund account not found: ${accountId}`);

  const currentBal = Number(account.escrow_balance);
  const newBal = _round2(currentBal + amt);
  const minThresh = Number(account.minimum_threshold);
  const newStatus = newBal >= minThresh ? 'active' : 'replenishment_needed';
  const now = new Date().toISOString();
  const effectiveTenantId = account.tenant_id || opts.tenantId || config.tenancy.defaultTenantId;

  const run = async (tx) => {
    if (tx) {
      await tx.update('loss_fund_accounts', {
        escrow_balance: newBal,
        status:         newStatus,
        updated_at:     now,
      }, { id: accountId });
    } else {
      const { error } = await supabase
        .from('loss_fund_accounts')
        .update({ escrow_balance: newBal, status: newStatus, updated_at: now })
        .eq('id', accountId);
      if (error) throw new Error(`recordDeposit update failed: ${error.message}`);
    }

    const txRow = {
      id:                crypto.randomUUID(),
      tenant_id:         effectiveTenantId,
      account_id:        accountId,
      transaction_type:  'client_deposit',
      amount:            amt,
      resulting_balance: newBal,
      reference:         reference || null,
      notes:             notes || null,
      created_by:        actor?.id || 'admin',
      created_at:        now,
    };

    if (tx) {
      await tx.insert('loss_fund_transactions', txRow);
    } else {
      await supabase.from('loss_fund_transactions').insert(txRow);
    }

    await auditLedger.append({
      actor: { type: 'human', id: actor?.id || 'admin', role: 'admin' },
      action: 'loss_fund.deposit_recorded',
      entity: { type: 'employer', id: account.employer_id },
      tenantId: effectiveTenantId,
      payload: { account_id: accountId, amount_cents: toCents(amt), new_balance: newBal },
    }, { tx });

    return { account_id: accountId, new_balance: newBal, status: newStatus, deposit_id: txRow.id };
  };

  return opts.tx
    ? run(opts.tx)
    : runInTransaction({ tenantId: effectiveTenantId, label: 'loss_fund.record_deposit' }, run);
}

/**
 * Record a disbursement debit from the client loss fund account.
 */
async function recordDisbursementDebit(accountId, amount, { claimId, paymentTransactionId, reference, notes, actor } = {}, opts = {}) {
  const amt = _round2(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Debit amount must be positive');

  const account = await getAccount(accountId);
  if (!account) throw new Error(`Loss fund account not found: ${accountId}`);

  const currentBal = Number(account.escrow_balance);
  const newBal = _round2(currentBal - amt);
  const minThresh = Number(account.minimum_threshold);
  const newStatus = newBal < minThresh ? 'replenishment_needed' : account.status;
  const now = new Date().toISOString();
  const effectiveTenantId = account.tenant_id || opts.tenantId || config.tenancy.defaultTenantId;

  const run = async (tx) => {
    if (tx) {
      await tx.update('loss_fund_accounts', {
        escrow_balance: newBal,
        status:         newStatus,
        updated_at:     now,
      }, { id: accountId });
    } else {
      const { error } = await supabase
        .from('loss_fund_accounts')
        .update({ escrow_balance: newBal, status: newStatus, updated_at: now })
        .eq('id', accountId);
      if (error) throw new Error(`recordDebit update failed: ${error.message}`);
    }

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
      created_by:             actor?.id || 'system',
      created_at:             now,
    };

    if (tx) {
      await tx.insert('loss_fund_transactions', txRow);
    } else {
      await supabase.from('loss_fund_transactions').insert(txRow);
    }

    // Check if replenishment call is triggered
    if (newBal < minThresh) {
      const replenishmentDue = _round2(Number(account.target_replenishment_amount) - newBal);
      logger.warn({
        msg: 'lossFundService: REPLENISHMENT_CALL_TRIGGERED',
        accountId,
        currentBal: newBal,
        minThresh,
        replenishmentDue,
      });
    }

    return { account_id: accountId, new_balance: newBal, status: newStatus, debit_id: txRow.id };
  };

  return opts.tx
    ? run(opts.tx)
    : runInTransaction({ tenantId: effectiveTenantId, label: 'loss_fund.record_debit' }, run);
}

/**
 * Bank statement clearing reconciliation.
 * Takes a feed of cleared bank transactions (check numbers or trace IDs) and reconciles
 * them against issued payment transactions.
 */
async function reconcileClearedPayments(clearedFeed, { actor } = {}, opts = {}) {
  if (!Array.isArray(clearedFeed) || clearedFeed.length === 0) {
    return { matched_count: 0, cleared_total: 0, unmatched: [] };
  }

  const matched = [];
  const unmatched = [];
  let clearedTotal = 0;
  const now = new Date().toISOString();

  for (const item of clearedFeed) {
    const { checkNumber, amount, clearedDate } = item;
    if (!checkNumber) {
      unmatched.push({ ...item, reason: 'MISSING_CHECK_NUMBER' });
      continue;
    }

    // Find matching issued payment
    const { data: payments } = await supabase
      .from('payment_transactions')
      .select('*')
      .eq('check_number', checkNumber)
      .in('status', ['issued', 'approved']);

    const match = (payments || []).find(p => Math.abs(Number(p.amount) - Number(amount)) < 0.01);
    if (!match) {
      unmatched.push({ ...item, reason: 'NO_MATCHING_ISSUED_PAYMENT' });
      continue;
    }

    await supabase
      .from('payment_transactions')
      .update({
        status:     'cleared',
        cleared_at: clearedDate || now,
        updated_at: now,
      })
      .eq('id', match.id);

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
}

module.exports = {
  createAccount,
  getAccount,
  getAccountByEmployer,
  recordDeposit,
  recordDisbursementDebit,
  reconcileClearedPayments,
};
