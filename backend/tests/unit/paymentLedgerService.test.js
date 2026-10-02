'use strict';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const paymentLedger = require('../../src/services/paymentLedgerService');
const reserveLedger = require('../../src/services/reserveLedgerService');

describe('paymentLedgerService (Phase 3)', () => {
  const claimId = 'claim-pay-test-001';
  const tenantId = '00000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    const mock = require('../__mocks__/supabaseClient');
    if (mock._reset) mock._reset();
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

    expect(payee).toBeDefined();
    expect(payee.name).toBe('Maria Hernandez');
    expect(payee.tax_id_last4).toBe('6789');
    expect(payee.bank_account_last4).toBe('3210');
    expect(payee.tax_id_encrypted).not.toBe('123-45-6789'); // Encrypted
  });

  test('issues payment, offsets reserves, and detects duplicates', async () => {
    // 1. Establish initial reserve
    await reserveLedger.postTransaction({
      tenantId,
      claimId,
      category: 'indemnity',
      amountDelta: 5000,
      transactionType: 'initial_reserve',
    });

    // 2. Create payee
    const payee = await paymentLedger.createPayee({
      tenantId,
      payeeType: 'injured_worker',
      name: 'Carlos Ruiz',
    });

    // 3. Issue payment
    const payment = await paymentLedger.issuePayment({
      tenantId,
      claimId,
      payeeId: payee.id,
      category: 'indemnity',
      paymentType: 'td_temporary_disability',
      amount: 1000,
      periodStart: '2026-03-01',
      periodEnd: '2026-03-14',
      createdBy: 'adjuster@test.com',
    });

    expect(payment.status).toBe('issued');
    expect(payment.amount).toBe(1000);

    // Reserve should be reduced from $5,000 to $4,000
    const balances = await reserveLedger.getBalances(claimId);
    expect(balances.categories.indemnity.outstanding).toBe(4000);
    expect(balances.categories.indemnity.paid_to_date).toBe(1000);
    expect(balances.totals.total_incurred).toBe(5000);

    // 4. Attempting duplicate payment must fail
    await expect(paymentLedger.issuePayment({
      tenantId,
      claimId,
      payeeId: payee.id,
      category: 'indemnity',
      paymentType: 'td_temporary_disability',
      amount: 1000,
      periodStart: '2026-03-01',
      periodEnd: '2026-03-14',
    })).rejects.toThrow(/DUPLICATE_PAYMENT_DETECTED/);
  });

  test('voids payment and restores reserve balance', async () => {
    await reserveLedger.postTransaction({
      tenantId,
      claimId,
      category: 'medical',
      amountDelta: 3000,
      transactionType: 'initial_reserve',
    });

    const payment = await paymentLedger.issuePayment({
      tenantId,
      claimId,
      category: 'medical',
      paymentType: 'medical_treatment',
      amount: 500,
      createdBy: 'adjuster@test.com',
    });

    let balances = await reserveLedger.getBalances(claimId);
    expect(balances.categories.medical.outstanding).toBe(2500);

    // Void the payment
    const voided = await paymentLedger.voidPayment(payment.id, {
      reason: 'Incorrect billing code submitted',
      actor: { id: 'adjuster@test.com', role: 'adjuster' },
    });

    expect(voided.status).toBe('voided');

    // Reserve should be restored back to $3,000
    balances = await reserveLedger.getBalances(claimId);
    expect(balances.categories.medical.outstanding).toBe(3000);
  });
});
