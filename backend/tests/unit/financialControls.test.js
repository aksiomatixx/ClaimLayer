'use strict';

/**
 * Financial and claim-state controls added when the direct-to-main ledger
 * work was reviewed: loss-fund escrow movements, the derived multi-axis claim
 * state, the LC §5402 QA clock, and the file-integrity response.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase }   = require('../../src/services/supabase');
const lossFund       = require('../../src/services/lossFundService');
const claimService   = require('../../src/services/claimService');
const fileQa         = require('../../src/services/fileQaSupervisor');

const TENANT = '00000000-0000-0000-0000-000000000001';
const OTHER  = '00000000-0000-0000-0000-0000000000b2';
const STAFF  = Object.freeze({ type: 'human', id: 'sup@tpa.test', role: 'supervisor', tenantId: TENANT });

beforeEach(() => supabase._resetStore());

describe('loss-fund escrow', () => {
  const open = (overrides = {}) => lossFund.createAccount({
    tenantId: TENANT, employerId: 'e0000000-0000-0000-0000-000000000001', accountNumber: 'ESC-1',
    initialDeposit: 20000, minimumThreshold: 10000, ...overrides,
  }, { actor: STAFF });

  test('a deposit or debit never reactivates a frozen account, and a frozen account takes no debits', async () => {
    const acct = await open();
    await supabase.from('loss_fund_accounts').update({ status: 'frozen' }).eq('id', acct.id);

    const dep = await lossFund.recordDeposit(acct.id, 500, { actor: STAFF }, { tenantId: TENANT });
    expect(dep).toMatchObject({ new_balance: 20500, status: 'frozen' });
    await expect(lossFund.recordDisbursementDebit(acct.id, 100, { actor: STAFF }, { tenantId: TENANT }))
      .rejects.toThrow(/frozen: no debits/);
  });

  test('balances come from the account as it is when the movement runs (no stale read)', async () => {
    const acct = await open();
    await lossFund.recordDisbursementDebit(acct.id, 15000, { actor: STAFF });
    const second = await lossFund.recordDisbursementDebit(acct.id, 1000, { actor: STAFF });
    expect(second).toMatchObject({ new_balance: 4000, status: 'replenishment_needed' });
    const { data: ledger } = await supabase.from('loss_fund_transactions').select('*').eq('account_id', acct.id);
    expect(ledger.map(t => Number(t.resulting_balance)).sort((a, b) => b - a)).toEqual([20000, 5000, 4000]);
  });

  test('another tenant\'s account is "not found"; the ledger names the human actor', async () => {
    const acct = await open();
    await expect(lossFund.recordDeposit(acct.id, 10, { actor: STAFF }, { tenantId: OTHER })).rejects.toThrow(/not found/);
    expect(await lossFund.getAccountByEmployer('e0000000-0000-0000-0000-000000000001', { tenantId: OTHER })).toBeNull();
    const { data } = await supabase.from('audit_ledger').select('*').eq('action', 'loss_fund.account_created');
    expect(data[0]).toMatchObject({ actor_id: 'sup@tpa.test', actor_role: 'supervisor' });
  });

  test('reconciliation clears only the caller tenant\'s issued payments', async () => {
    await supabase.from('payment_transactions').insert([
      { id: 'p1', tenant_id: TENANT, claim_id: 'c1', category: 'indemnity', payment_type: 'td_temporary_disability', amount: 100, status: 'issued', check_number: '5001' },
      { id: 'p2', tenant_id: OTHER,  claim_id: 'c2', category: 'indemnity', payment_type: 'td_temporary_disability', amount: 100, status: 'issued', check_number: '5002' },
    ]);
    const out = await lossFund.reconcileClearedPayments(
      [{ checkNumber: '5001', amount: 100 }, { checkNumber: '5002', amount: 100 }], { actor: STAFF }, { tenantId: TENANT });
    expect(out.matched.map(m => m.payment_id)).toEqual(['p1']);
    expect(out.unmatched.map(u => u.checkNumber)).toEqual(['5002']);
    const { data } = await supabase.from('payment_transactions').select('id, status').eq('id', 'p2').single();
    expect(data.status).toBe('issued');
    await expect(lossFund.reconcileClearedPayments([{ checkNumber: '1', amount: 1 }], { actor: STAFF }))
      .rejects.toThrow(/requires the caller's tenant/);
  });
});

describe('multi-axis claim state is derived in one place', () => {
  const { statusAxesPatch } = claimService;

  test('transitions set admin/compensability/litigation consistently', () => {
    expect(statusAxesPatch('denied')).toEqual({ status: 'denied', admin_status: 'open', compensability_status: 'denied' });
    expect(statusAxesPatch('litigated')).toMatchObject({ admin_status: 'open', litigation_status: 'application_filed' });
    expect(statusAxesPatch('intake_complete')).toMatchObject({ admin_status: 'intake' });
  });

  test('closing (incl. a C&R of a denied claim) leaves compensability as it was', () => {
    expect(statusAxesPatch('closed')).toEqual({ status: 'closed', admin_status: 'closed' });
    expect(statusAxesPatch('future_medical_only')).toEqual({ status: 'future_medical_only', admin_status: 'closed' });
  });

  test('a reopened claim is "reopened" and stays so through later transitions until it closes', () => {
    expect(statusAxesPatch('active_medical', { admin_status: 'closed' }, { reopened: true })).toMatchObject({ admin_status: 'reopened' });
    expect(statusAxesPatch('p_and_s', { admin_status: 'reopened' })).toMatchObject({ admin_status: 'reopened' });
    expect(statusAxesPatch('closed', { admin_status: 'reopened' })).toMatchObject({ admin_status: 'closed' });
  });

  test('reopen and representation write the axes', async () => {
    await supabase.from('claims').insert({
      id: 'c_axes', claim_number: 'AX-1', status: 'closed', admin_status: 'closed',
      compensability_status: 'accepted', litigation_status: 'unrepresented', date_of_injury: '2026-01-05',
    });
    const actor = { type: 'human', id: 'adj@tpa.test', role: 'adjuster', tenantId: TENANT, mfa: true };
    await claimService.reopenClaim('c_axes', 'new treatment', 'adj@tpa.test', { actor });
    await claimService.setAttorneyRepresentation('c_axes', { represented: true, attorney: { name: 'L. Counsel' } }, 'adj@tpa.test', { actor });
    const { data } = await supabase.from('claims').select('*').eq('id', 'c_axes').single();
    expect(data).toMatchObject({ status: 'active_medical', admin_status: 'reopened', litigation_status: 'represented' });
  });
});

describe('LC §5402 QA clock runs from claim form receipt', () => {
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString();

  test('a late-reported claim is measured from receipt, not from the injury date', async () => {
    await supabase.from('claims').insert([
      // Injured 200 days ago, form received 80 days ago → 10 days to the presumption date.
      { id: 'q1', claim_number: 'Q-1', status: 'under_investigation', compensability_status: 'pending_investigation',
        date_of_injury: day(-200).slice(0, 10), filed_at: day(-80), created_at: day(-80), tenant_id: TENANT },
      // Injured 80 days ago but received yesterday → nowhere near the date.
      { id: 'q2', claim_number: 'Q-2', status: 'under_investigation', compensability_status: 'pending_investigation',
        date_of_injury: day(-80).slice(0, 10), filed_at: day(-1), created_at: day(-1), tenant_id: TENANT },
      { id: 'q3', claim_number: 'Q-3', status: 'under_investigation', compensability_status: 'delayed',
        date_of_injury: day(-120).slice(0, 10), filed_at: day(-95), created_at: day(-95), tenant_id: TENANT },
    ]);
    const report = await fileQa.runFileQASweep({ tenantId: TENANT });
    const by = Object.fromEntries(report.findings.filter(f => f.exceptionType.startsWith('LC_5402'))
      .map(f => [f.claimId, f.exceptionType]));
    expect(by).toEqual({ q1: 'LC_5402_APPROACHING_DEADLINE', q3: 'LC_5402_PRESUMPTION_DATE_PASSED' });
  });

  test('no receipt date → reported as missing, never computed from something else', () => {
    expect(fileQa._presumptionDate(null)).toBeNull();
    expect(fileQa._presumptionDate('2026-01-01T12:00:00Z')).toBe('2026-04-01');
  });
});
