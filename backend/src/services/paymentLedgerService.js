'use strict';

/**
 * paymentLedgerService.js — Phase 3 Authoritative Payment Ledger & Payee Vault.
 *
 * Implements financial controls for disbursement issuance:
 *   1. Payee Vault: Tokenized PII (Tax IDs / bank accounts) with unencrypted last-4.
 *   2. Automated Duplicate Detection: SHA-256 duplicate_hash over tenant:claim:payee:category:amount:period.
 *      Disallows duplicate disbursements within 90 days.
 *   3. Double-Entry Reserve Offset: Every payment issuance automatically reduces the
 *      corresponding reserve bucket via `reserveLedgerService.postTransaction` in the same atomic unit of work.
 *   4. Reversible Void Workflow: Voiding a payment automatically restores the reserve bucket.
 */

const crypto        = require('crypto');
const { supabase }  = require('./supabase');
const logger        = require('../logger');
const auditLedger   = require('./auditLedgerService');
const reserveLedger = require('./reserveLedgerService');
const { runInTransaction } = require('../db/unitOfWork');
const { toCents, fromCents } = require('../utils/money');
const config        = require('../config');

const PAYEE_TYPES = Object.freeze([
  'injured_worker',
  'medical_provider',
  'attorney',
  'vendor',
  'lien_claimant',
]);

const PAYMENT_CATEGORIES = Object.freeze(['indemnity', 'medical', 'expense']);

const PAYMENT_TYPES = Object.freeze([
  'td_temporary_disability',
  'pd_advance',
  'stip_award',
  'cnr_settlement',
  'medical_treatment',
  'legal_expense',
  'bill_review_fee',
]);

const PAYMENT_METHODS = Object.freeze(['check', 'ach', 'digital_card']);

const _round2 = (n) => Math.round(Number(n) * 100) / 100;

// Simple deterministic vault encryption/masking for local environments
function _encryptSecret(plainText) {
  if (!plainText) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    crypto.createHash('sha256').update(config.jwtSecret || 'claimlayer-secret-key-32-bytes!').digest(),
    iv
  );
  let encrypted = cipher.update(String(plainText), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Compute the SHA-256 duplicate detection hash.
 */
function computeDuplicateHash({ tenantId, claimId, payeeId, category, amount, periodStart, periodEnd }) {
  const normAmount = Number(amount).toFixed(2);
  const raw = [
    tenantId || '',
    claimId || '',
    payeeId || '',
    category || '',
    normAmount,
    periodStart || '',
    periodEnd || '',
  ].join(':');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ── Payee Vault Operations ───────────────────────────────────────────────────

async function createPayee(input, opts = {}) {
  const {
    tenantId,
    payeeType,
    name,
    taxId,
    paymentMethod = 'check',
    bankRoutingNumber,
    bankAccountNumber,
    addressLine1,
    addressLine2,
    city,
    state,
    zipCode,
  } = input || {};

  if (!name || !String(name).trim()) throw new Error('Payee name is required');
  if (!PAYEE_TYPES.includes(payeeType)) {
    throw new Error(`payeeType must be one of: ${PAYEE_TYPES.join(', ')}`);
  }
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    throw new Error(`paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }

  const effectiveTenantId = tenantId || opts.tenantId || config.tenancy.defaultTenantId;
  const now = new Date().toISOString();

  const row = {
    id:                            crypto.randomUUID(),
    tenant_id:                     effectiveTenantId,
    payee_type:                    payeeType,
    name:                          String(name).trim(),
    tax_id_encrypted:              _encryptSecret(taxId),
    tax_id_last4:                  taxId ? String(taxId).replace(/\D/g, '').slice(-4) : null,
    payment_method:                paymentMethod,
    bank_routing_number_encrypted: _encryptSecret(bankRoutingNumber),
    bank_account_number_encrypted: _encryptSecret(bankAccountNumber),
    bank_account_last4:            bankAccountNumber ? String(bankAccountNumber).replace(/\D/g, '').slice(-4) : null,
    address_line1:                 addressLine1 || null,
    address_line2:                 addressLine2 || null,
    city:                          city || null,
    state:                         state || null,
    zip_code:                      zipCode || null,
    status:                        'active',
    created_at:                    now,
    updated_at:                    now,
  };

  if (opts.tx) {
    await opts.tx.insert('payees', row);
  } else {
    const { error } = await supabase.from('payees').insert(row);
    if (error) throw new Error(`createPayee failed: ${error.message}`);
  }

  return row;
}

async function getPayee(payeeId) {
  const { data, error } = await supabase
    .from('payees')
    .select('id, tenant_id, payee_type, name, tax_id_last4, payment_method, bank_account_last4, address_line1, address_line2, city, state, zip_code, status, created_at, updated_at')
    .eq('id', payeeId)
    .single();

  if (error || !data) return null;
  return data;
}

async function listPayees(filters = {}) {
  let query = supabase
    .from('payees')
    .select('id, tenant_id, payee_type, name, tax_id_last4, payment_method, bank_account_last4, city, state, zip_code, status, created_at');

  if (filters.tenantId) query = query.eq('tenant_id', filters.tenantId);
  if (filters.payeeType) query = query.eq('payee_type', filters.payeeType);
  if (filters.status) query = query.eq('status', filters.status);

  const { data, error } = await query.order('name', { ascending: true });
  if (error) throw new Error(`listPayees failed: ${error.message}`);
  return data || [];
}

// ── Payment Issuance & Duplicate Detection ───────────────────────────────────

/**
 * Check for duplicate payment within the 90-day window.
 */
async function _checkDuplicate(tenantId, duplicateHash, tx = null) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  if (tx && tx.mode === 'pg') {
    const rows = await tx.query(
      `SELECT id, claim_id, amount, status, created_at
         FROM payment_transactions
        WHERE tenant_id = $1
          AND duplicate_hash = $2
          AND status NOT IN ('voided', 'rejected')
          AND created_at >= $3
        LIMIT 1`,
      [tenantId, duplicateHash, ninetyDaysAgo]
    );
    return rows && rows.length ? rows[0] : null;
  }

  const { data, error } = await supabase
    .from('payment_transactions')
    .select('id, claim_id, amount, status, created_at')
    .eq('tenant_id', tenantId)
    .eq('duplicate_hash', duplicateHash)
    .gte('created_at', ninetyDaysAgo);

  if (error) {
    logger.warn({ msg: '_checkDuplicate: query warning', err: error.message });
    return null;
  }

  const match = (data || []).find(r => r.status !== 'voided' && r.status !== 'rejected');
  return match || null;
}

/**
 * Issue a payment against a claim and its reserve ledger.
 */
async function issuePayment(input, opts = {}) {
  const {
    tenantId,
    claimId,
    payeeId,
    category,
    paymentType,
    amount,
    method = 'check',
    checkNumber = null,
    memo = null,
    periodStart = null,
    periodEnd = null,
    actionRequestId = null,
    disbursementId = null,
    pdAdvancePaymentId = null,
    createdBy = null,
  } = input || {};

  if (!claimId) throw new Error('claimId is required');
  if (!PAYMENT_CATEGORIES.includes(category)) {
    throw new Error(`category must be one of: ${PAYMENT_CATEGORIES.join(', ')}`);
  }
  if (!PAYMENT_TYPES.includes(paymentType)) {
    throw new Error(`paymentType must be one of: ${PAYMENT_TYPES.join(', ')}`);
  }
  const amt = _round2(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error('amount must be a positive number');
  }

  const effectiveTenantId = tenantId || opts.tenantId || config.tenancy.defaultTenantId;
  const duplicateHash = computeDuplicateHash({
    tenantId: effectiveTenantId,
    claimId,
    payeeId,
    category,
    amount: amt,
    periodStart,
    periodEnd,
  });

  const run = async (tx) => {
    // 1. Guard against duplicate payment
    const duplicate = await _checkDuplicate(effectiveTenantId, duplicateHash, tx);
    if (duplicate) {
      throw new Error(
        `DUPLICATE_PAYMENT_DETECTED: A payment of $${amt} with matching payee, category, ` +
        `and period was already issued on ${duplicate.created_at} (ID: ${duplicate.id}).`
      );
    }

    const now = new Date().toISOString();
    const paymentId = crypto.randomUUID();

    const row = {
      id:                    paymentId,
      tenant_id:             effectiveTenantId,
      claim_id:              claimId,
      payee_id:              payeeId || null,
      category,
      payment_type:          paymentType,
      amount:                amt,
      status:                'issued',
      method,
      check_number:          checkNumber || null,
      memo:                  memo || null,
      period_start:          periodStart || null,
      period_end:            periodEnd || null,
      action_request_id:     actionRequestId || null,
      disbursement_id:       disbursementId || null,
      pd_advance_payment_id: pdAdvancePaymentId || null,
      duplicate_hash:        duplicateHash,
      created_by:            createdBy || null,
      created_at:            now,
      updated_at:            now,
    };

    if (tx) {
      await tx.insert('payment_transactions', row);
    } else {
      const { error } = await supabase.from('payment_transactions').insert(row);
      if (error) throw new Error(`paymentLedger: insert failed — ${error.message}`);
    }

    // 2. Double-entry reserve offset: Reduce the reserve bucket in the same transaction
    await reserveLedger.postTransaction({
      tenantId: effectiveTenantId,
      claimId,
      category,
      amountDelta: -amt, // Negative delta reduces outstanding reserve
      transactionType: 'payment_reduction',
      reason: `Payment issued (${paymentType}, ID: ${paymentId})`,
      source: 'ADJUSTER',
      createdBy,
      actionRequestId,
    }, { tx });

    // 3. Cryptographic audit ledger
    await auditLedger.append({
      actor: { type: 'human', id: createdBy || 'adjuster', role: 'adjuster' },
      action: 'payment.issued',
      entity: { type: 'claim', id: claimId },
      claimId,
      tenantId: effectiveTenantId,
      payload: {
        payment_id: paymentId,
        payee_id: payeeId,
        category,
        payment_type: paymentType,
        amount_cents: toCents(amt),
        method,
        check_number: checkNumber,
        period_start: periodStart,
        period_end: periodEnd,
      },
      evidence: [
        ...(actionRequestId ? [{ type: 'action_request', id: actionRequestId }] : []),
        ...(disbursementId ? [{ type: 'disbursement', id: disbursementId }] : []),
      ],
    }, { tx });

    // 4. Claim event
    const eventRow = {
      claim_id:  claimId,
      type:      'payment_issued',
      timestamp: now,
      data: {
        paymentId,
        payeeId,
        category,
        paymentType,
        amount: amt,
        method,
        checkNumber,
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
    : runInTransaction({ tenantId: effectiveTenantId, label: 'payment.issue' }, run);
}

// ── Payment Voiding & Reserve Restoration ─────────────────────────────────────

async function voidPayment(paymentId, { reason, actor = null } = {}, opts = {}) {
  if (!reason || !String(reason).trim()) throw new Error('Void reason is required');

  const { data: payment, error } = await supabase
    .from('payment_transactions')
    .select('*')
    .eq('id', paymentId)
    .single();

  if (error || !payment) throw new Error(`Payment not found: ${paymentId}`);
  if (payment.status === 'voided') throw new Error(`Payment ${paymentId} is already voided`);

  const now = new Date().toISOString();
  const effectiveTenantId = payment.tenant_id || opts.tenantId || config.tenancy.defaultTenantId;
  const actorId = actor?.id || 'adjuster';

  const run = async (tx) => {
    // 1. Update payment status to voided
    if (tx) {
      await tx.update('payment_transactions', {
        status:      'voided',
        void_reason: reason,
        voided_at:   now,
        updated_at:  now,
      }, { id: paymentId });
    } else {
      const { error: updErr } = await supabase
        .from('payment_transactions')
        .update({
          status:      'voided',
          void_reason: reason,
          voided_at:   now,
          updated_at:  now,
        })
        .eq('id', paymentId);
      if (updErr) throw new Error(`voidPayment update failed: ${updErr.message}`);
    }

    // 2. Restore reserve bucket (reverse the negative delta)
    await reserveLedger.postTransaction({
      tenantId: effectiveTenantId,
      claimId: payment.claim_id,
      category: payment.category,
      amountDelta: Number(payment.amount), // Positive delta restores reserve
      transactionType: 'reserve_revision',
      reason: `Reserve restored after voiding payment ${paymentId}: ${reason}`,
      source: 'ADJUSTER',
      createdBy: actorId,
    }, { tx });

    // 3. Audit ledger entry
    await auditLedger.append({
      actor: { type: 'human', id: actorId, role: actor?.role || 'adjuster' },
      action: 'payment.voided',
      entity: { type: 'claim', id: payment.claim_id },
      claimId: payment.claim_id,
      tenantId: effectiveTenantId,
      payload: {
        payment_id: paymentId,
        amount_cents: toCents(Number(payment.amount)),
        category: payment.category,
        void_reason: reason,
      },
    }, { tx });

    // 4. Claim event
    const eventRow = {
      claim_id:  payment.claim_id,
      type:      'payment_voided',
      timestamp: now,
      data:      { paymentId, amount: Number(payment.amount), reason, voidedBy: actorId },
    };
    if (tx) {
      await tx.insert('claim_events', eventRow);
    } else {
      await supabase.from('claim_events').insert(eventRow);
    }

    return { ...payment, status: 'voided', void_reason: reason, voided_at: now };
  };

  return opts.tx
    ? run(opts.tx)
    : runInTransaction({ tenantId: effectiveTenantId, label: 'payment.void' }, run);
}

// ── Read Operations ───────────────────────────────────────────────────────────

async function getPayment(paymentId) {
  const { data, error } = await supabase
    .from('payment_transactions')
    .select('*, payees(name, payee_type, payment_method)')
    .eq('id', paymentId)
    .single();

  if (error || !data) return null;
  return data;
}

async function getPayments(claimId, filters = {}) {
  let query = supabase
    .from('payment_transactions')
    .select('*, payees(name, payee_type, payment_method)')
    .eq('claim_id', claimId)
    .order('created_at', { ascending: false });

  if (filters.category) query = query.eq('category', filters.category);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.paymentType) query = query.eq('payment_type', filters.paymentType);

  const { data, error } = await query;
  if (error) {
    logger.error({ msg: 'paymentLedgerService.getPayments failed', err: error.message, claimId });
    throw new Error(`Failed to load payment transactions: ${error.message}`);
  }
  return data || [];
}

module.exports = {
  PAYEE_TYPES,
  PAYMENT_CATEGORIES,
  PAYMENT_TYPES,
  PAYMENT_METHODS,
  computeDuplicateHash,
  createPayee,
  getPayee,
  listPayees,
  issuePayment,
  voidPayment,
  getPayment,
  getPayments,
};
