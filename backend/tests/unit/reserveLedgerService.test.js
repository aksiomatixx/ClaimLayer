'use strict';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const reserveLedger = require('../../src/services/reserveLedgerService');
const { supabase } = require('../../src/services/supabase');

describe('reserveLedgerService (Phase 3)', () => {
  const claimId = 'claim-res-test-001';
  const tenantId = '00000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    // Reset table in mock
    const mock = require('../__mocks__/supabaseClient');
    if (mock._reset) mock._reset();
  });

  test('posts initial reserve transaction and computes balance', async () => {
    const tx = await reserveLedger.postTransaction({
      tenantId,
      claimId,
      category: 'medical',
      amountDelta: 15000,
      transactionType: 'initial_reserve',
      reason: 'Initial medical reserve',
      createdBy: 'adjuster@test.com',
    });

    expect(tx).toBeDefined();
    expect(tx.category).toBe('medical');
    expect(tx.amount_delta).toBe(15000);
    expect(tx.resulting_balance).toBe(15000);
    expect(tx.incurred_delta).toBe(15000);

    const balances = await reserveLedger.getBalances(claimId);
    expect(balances.categories.medical.outstanding).toBe(15000);
    expect(balances.categories.medical.paid_to_date).toBe(0);
    expect(balances.categories.medical.total_incurred).toBe(15000);
    expect(balances.totals.outstanding_reserves).toBe(15000);
    expect(balances.totals.total_incurred).toBe(15000);
  });

  test('posts upward revision and payment reduction with invariant incurred', async () => {
    // 1. Initial
    await reserveLedger.postTransaction({
      tenantId,
      claimId,
      category: 'indemnity',
      amountDelta: 10000,
      transactionType: 'initial_reserve',
      reason: 'Opening indemnity reserve',
    });

    // 2. Upward revision +$5,000
    await reserveLedger.postTransaction({
      tenantId,
      claimId,
      category: 'indemnity',
      amountDelta: 5000,
      transactionType: 'reserve_revision',
      reason: 'TD period extended',
    });

    // 3. Payment reduction -$3,000
    const payTx = await reserveLedger.postTransaction({
      tenantId,
      claimId,
      category: 'indemnity',
      amountDelta: -3000,
      transactionType: 'payment_reduction',
      reason: 'TD check issued',
    });

    expect(payTx.resulting_balance).toBe(12000);
    expect(payTx.incurred_delta).toBe(0); // Incurred unchanged by payment!

    const balances = await reserveLedger.getBalances(claimId);
    expect(balances.categories.indemnity.outstanding).toBe(12000);
    expect(balances.categories.indemnity.paid_to_date).toBe(3000);
    expect(balances.categories.indemnity.total_incurred).toBe(15000); // 12000 + 3000 = 15000
  });

  test('rejects reduction that would produce a negative reserve balance', async () => {
    await reserveLedger.postTransaction({
      tenantId,
      claimId,
      category: 'expense',
      amountDelta: 2000,
      transactionType: 'initial_reserve',
    });

    await expect(reserveLedger.postTransaction({
      tenantId,
      claimId,
      category: 'expense',
      amountDelta: -2500,
      transactionType: 'payment_reduction',
    })).rejects.toThrow(/RESERVE_BALANCE_NEGATIVE/);
  });
});
