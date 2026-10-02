'use strict';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const config        = require('../../src/config');
const paymentLedger = require('../../src/services/paymentLedgerService');
const reserveLedger = require('../../src/services/reserveLedgerService');
const { runInTransaction } = require('../../src/db/unitOfWork');
const { supabase }  = require('../../src/services/supabase');

const tenantId = '00000000-0000-0000-0000-000000000001';
const APPROVER = Object.freeze({ type: 'human', id: 'sup@test.com', role: 'supervisor', tenantId });
let seq = 0;

// Issue as the approval executor does: inside the unit, as the approver,
// referencing the approved request.
const issue = (input, opts = {}) => runInTransaction({ tenantId }, (tx) =>
  paymentLedger.issuePayment({ tenantId, actionRequestId: `ar_${++seq}`, ...input }, { tx, actor: APPROVER, ...opts }));

describe('paymentLedgerService (Phase 3)', () => {
  let claimId;

  beforeEach(() => {
    supabase._resetStore();
    claimId = `claim-pay-test-${++seq}`;
  });

  test('creates payee and masks tax ID and bank account last 4', async () => {
    const payee = await paymentLedger.createPayee({
      tenantId,
      payeeType: 'injured_worker',
      name: 'Maria Hernandez',
      taxId: '123-45-6789',
      paymentMethod: 'check',
      bankAccountNumber: '9876543210',
      addressLine1: '123 Main St',
      city: 'Los Angeles',
      state: 'CA',
      zipCode: '90010',
    });

    expect(payee.name).toBe('Maria Hernandez');
    expect(payee.tax_id_last4).toBe('6789');
    expect(payee.bank_account_last4).toBe('3210');
    expect(payee.tax_id_encrypted).not.toContain('123-45-6789');
  });

  test('production refuses to store a tax id without a dedicated vault key (never the JWT secret)', async () => {
    const env = config.nodeEnv;
    const key = config.vault.payeeKey;
    config.nodeEnv = 'production';
    config.vault.payeeKey = undefined;
    try {
      await expect(paymentLedger.createPayee({ tenantId, payeeType: 'vendor', name: 'X', taxId: '12-3456789' }))
        .rejects.toThrow(/PAYEE_VAULT_KEY/);
    } finally {
      config.nodeEnv = env;
      config.vault.payeeKey = key;
    }
  });

  test('a payment is recorded only inside its authorizing unit, and must name its authorization', async () => {
    const input = { tenantId, claimId, category: 'indemnity', paymentType: 'td_temporary_disability', amount: 10, actionRequestId: 'ar_x' };
    await expect(paymentLedger.issuePayment(input)).rejects.toThrow(/authorizing unit of work/);
    await expect(runInTransaction({ tenantId }, (tx) =>
      paymentLedger.issuePayment({ ...input, actionRequestId: null }, { tx, actor: APPROVER })))
      .rejects.toThrow(/must reference its authorization/);
  });

  test('issues payment, offsets reserves, attributes it to the approver, and detects duplicates', async () => {
    await reserveLedger.postTransaction({ tenantId, claimId, category: 'indemnity', amountDelta: 5000, transactionType: 'initial_reserve' });
    const payee = await paymentLedger.createPayee({ tenantId, payeeType: 'injured_worker', name: 'Carlos Ruiz' });

    const payment = await issue({
      claimId, payeeId: payee.id, category: 'indemnity', paymentType: 'td_temporary_disability',
      amount: 1000, periodStart: '2026-03-01', periodEnd: '2026-03-14', createdBy: APPROVER.id,
    });
    expect(payment).toMatchObject({ status: 'issued', amount: 1000, reserve_deficiency: 0 });

    const balances = await reserveLedger.getBalances(claimId);
    expect(balances.categories.indemnity).toEqual({ outstanding: 4000, paid_to_date: 1000, total_incurred: 5000 });

    const { data: ledger } = await supabase.from('audit_ledger').select('*').eq('action', 'payment.issued');
    expect(ledger.find(e => e.claim_id === claimId)).toMatchObject({ actor_id: APPROVER.id, actor_type: 'human' });

    await expect(issue({
      claimId, payeeId: payee.id, category: 'indemnity', paymentType: 'td_temporary_disability',
      amount: 1000, periodStart: '2026-03-01', periodEnd: '2026-03-14',
    })).rejects.toThrow(/DUPLICATE_PAYMENT_DETECTED/);
  });

  test('a NEW payment larger than the outstanding reserve is refused', async () => {
    await reserveLedger.postTransaction({ tenantId, claimId, category: 'medical', amountDelta: 100, transactionType: 'initial_reserve' });
    await expect(issue({ claimId, category: 'medical', paymentType: 'medical_treatment', amount: 250 }))
      .rejects.toThrow(/RESERVE_BALANCE_NEGATIVE/);
    expect((await reserveLedger.getBalances(claimId)).categories.medical.paid_to_date).toBe(0);
  });

  test('a RECORDED payment beyond the reserve raises it explicitly and opens a review diary', async () => {
    await reserveLedger.postTransaction({ tenantId, claimId, category: 'indemnity', amountDelta: 100, transactionType: 'initial_reserve' });
    const row = await issue({ claimId, category: 'indemnity', paymentType: 'stip_award', amount: 250, actionRequestId: null, disbursementId: 'disb_1' },
      { recorded: true });
    expect(row.reserve_deficiency).toBe(150);
    expect((await reserveLedger.getBalances(claimId)).categories.indemnity)
      .toEqual({ outstanding: 0, paid_to_date: 250, total_incurred: 250 });
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claimId);
    expect(diaries.map(d => d.diary_type)).toEqual(['RESERVE_ADEQUACY_REVIEW']);
  });

  test('voiding reverses the payment: paid-to-date down, reserve back, incurred unchanged; a second void is refused', async () => {
    await reserveLedger.postTransaction({ tenantId, claimId, category: 'medical', amountDelta: 3000, transactionType: 'initial_reserve' });
    const payment = await issue({ claimId, category: 'medical', paymentType: 'medical_treatment', amount: 500 });
    expect((await reserveLedger.getBalances(claimId)).categories.medical.outstanding).toBe(2500);

    const voided = await paymentLedger.voidPayment(payment.id, { reason: 'Incorrect billing code submitted', actor: APPROVER });
    expect(voided.status).toBe('voided');
    expect((await reserveLedger.getBalances(claimId)).categories.medical)
      .toEqual({ outstanding: 3000, paid_to_date: 0, total_incurred: 3000 });

    await expect(paymentLedger.voidPayment(payment.id, { reason: 'again', actor: APPROVER }))
      .rejects.toThrow(/already voided/);
    expect((await reserveLedger.getBalances(claimId)).categories.medical.outstanding).toBe(3000);
  });
});
