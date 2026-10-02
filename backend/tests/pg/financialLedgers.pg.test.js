'use strict';

/**
 * The financial ledgers on real PostgreSQL: concurrent postings on one claim
 * serialize on the claim ledger lock, so a duplicate payment, a reserve
 * overdraw and a double void each resolve to exactly one winner; a recorded
 * PD advance payment links its own row and commits with its ledger entries
 * or not at all; benefit-service audit entries carry their claim.
 */

jest.mock('../../src/services/supabase', () => require('./pgSupabase'));
jest.mock('../../src/services/filehandler', () => ({
  setReserves: jest.fn().mockResolvedValue({ ok: true }),
  createClaim: jest.fn(), createDiary: jest.fn(), completeDiary: jest.fn(), addNote: jest.fn(),
  attachDocument: jest.fn(),
}));

const config        = require('../../src/config');
const claimService  = require('../../src/services/claimService');
const approvals     = require('../../src/services/approvalService');
const paymentLedger = require('../../src/services/paymentLedgerService');
const reserveLedger = require('../../src/services/reserveLedgerService');
const pdService     = require('../../src/services/pdService');
const { runInTransaction } = require('../../src/db/unitOfWork');
const { humanPrincipal } = require('../../src/policy/principal');
const { getPool, closePool } = require('../../src/db/pool');

const TENANT = '00000000-0000-0000-0000-000000000001';
const ADJ  = humanPrincipal({ email: 'adj@tpa.test', role: 'adjuster', mfa: true, tenantId: TENANT });
const SUP  = humanPrincipal({ email: 'sup@tpa.test', role: 'supervisor', mfa: true, tenantId: TENANT });
const SUP2 = humanPrincipal({ email: 'sup2@tpa.test', role: 'supervisor', mfa: true, tenantId: TENANT });
const WHY  = 'Verified against the PR-2 and the wage statement.';

const db = (sql, params) => getPool().query(sql, params).then(r => r.rows);
let n = 0;

async function seedClaim({ indemnity = 0 } = {}) {
  const id = `claim_fl_${process.pid}_${++n}`;
  const number = `FL-${process.pid % 100000}-${n}`;
  await db(`INSERT INTO claims (id, claim_number, status, date_of_injury, filehandler_id)
            VALUES ($1, $2, 'accepted', '2026-05-01', $3)`, [id, number, `fh_${id}`]);
  claimService._seedClaim({
    id, claimNumber: number, status: 'accepted', employerId: 'emp-1', dateOfInjury: '2026-05-01',
    filehandlerId: `fh_${id}`, tenantId: TENANT, employee: {}, events: [], diaries: [],
  });
  if (indemnity) {
    await reserveLedger.postTransaction({ tenantId: TENANT, claimId: id, category: 'indemnity', amountDelta: indemnity, transactionType: 'initial_reserve' });
  }
  return id;
}

const proposePayment = (claimId, amountCents, period = '2026-05-01') => approvals.propose({
  actionType: 'payment.issue', claimId, proposer: ADJ, rationale: 'TD owed for the period per PR-2.',
  payload: { amount_cents: amountCents, category: 'indemnity', payment_type: 'td_temporary_disability',
             period_start: period, period_end: period },
}).then(r => r.request);

const approve = (req, who) => approvals.decide(req.id, { decision: 'approve', decider: who, rationale: WHY })
  .then(r => r.request, e => ({ error: e }));

const balances = async (claimId) => (await reserveLedger.getBalances(claimId)).categories.indemnity;

beforeEach(() => { config.jobs.kick = false; });
afterAll(closePool);

describe('the claim ledger lock', () => {
  test('two identical payments approved at the same moment: exactly one is issued', async () => {
    const claimId = await seedClaim({ indemnity: 5000 });
    const [a, b] = [await proposePayment(claimId, 120000), await proposePayment(claimId, 120000)];
    await Promise.all([approve(a, SUP), approve(b, SUP2)]);

    expect(await db(`SELECT amount::float FROM payment_transactions WHERE claim_id = $1`, [claimId])).toEqual([{ amount: 1200 }]);
    expect(await balances(claimId)).toEqual({ outstanding: 3800, paid_to_date: 1200, total_incurred: 5000 });
    const statuses = (await db(`SELECT status FROM action_requests WHERE id = ANY($1)`, [[a.id, b.id]])).map(r => r.status).sort();
    expect(statuses).toEqual(['executed', 'execution_failed']);
  });

  test('two payments that together overdraw the reserve: one is issued, the reserve never goes negative', async () => {
    const claimId = await seedClaim({ indemnity: 1000 });
    const [a, b] = [await proposePayment(claimId, 70000, '2026-05-01'), await proposePayment(claimId, 70000, '2026-05-15')];
    await Promise.all([approve(a, SUP), approve(b, SUP2)]);

    expect((await db(`SELECT count(*)::int AS n FROM payment_transactions WHERE claim_id = $1`, [claimId]))[0].n).toBe(1);
    expect(await balances(claimId)).toEqual({ outstanding: 300, paid_to_date: 700, total_incurred: 1000 });
    expect(await db(`SELECT min(resulting_balance)::float AS low FROM reserve_transactions WHERE claim_id = $1`, [claimId]))
      .toEqual([{ low: 300 }]);
  });

  test('two concurrent voids of one payment: one reversal, paid-to-date back to zero, incurred unchanged', async () => {
    const claimId = await seedClaim({ indemnity: 2000 });
    const req = await approve(await proposePayment(claimId, 50000), SUP);
    expect(req.status).toBe('executed');
    const [{ id: paymentId }] = await db(`SELECT id FROM payment_transactions WHERE claim_id = $1`, [claimId]);

    const results = await Promise.allSettled([
      paymentLedger.voidPayment(paymentId, { reason: 'Wrong period', actor: SUP }),
      paymentLedger.voidPayment(paymentId, { reason: 'Wrong period', actor: SUP2 }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balances(claimId)).toEqual({ outstanding: 2000, paid_to_date: 0, total_incurred: 2000 });
    expect((await db(`SELECT count(*)::int AS n FROM reserve_transactions WHERE claim_id = $1 AND transaction_type = 'payment_void'`, [claimId]))[0].n).toBe(1);
  });
});

describe('recorded payments (PD advance)', () => {
  async function seedAdvance(claimId) {
    const [{ id }] = await db(
      `INSERT INTO pd_advances (claim_id, td_end_date, advance_due_date, weekly_rate, status)
       VALUES ($1, '2026-06-01', '2026-06-15', 290, 'pending') RETURNING id`, [claimId]);
    return id;
  }

  test('the ledger payment links THIS week\'s payment row, and a shortfall is covered explicitly', async () => {
    const claimId = await seedClaim({ indemnity: 100 });
    const advId = await seedAdvance(claimId);
    await pdService.recordPDAdvancePayment(advId, {
      weekStartDate: '2026-06-15', weekEndDate: '2026-06-21', amountPaid: 290,
      paidBy: '00000000-0000-0000-0000-0000000000a1', actor: ADJ,   // paid_by is the staff user's id (UUID)
    });

    const [week] = await db(`SELECT id FROM pd_advance_payments WHERE pd_advance_id = $1`, [advId]);
    expect(await db(`SELECT pd_advance_payment_id, payment_type, amount::float FROM payment_transactions WHERE claim_id = $1`, [claimId]))
      .toEqual([{ pd_advance_payment_id: week.id, payment_type: 'pd_advance', amount: 290 }]);
    expect(await balances(claimId)).toEqual({ outstanding: 0, paid_to_date: 290, total_incurred: 290 });
    expect((await db(`SELECT diary_type FROM diaries WHERE claim_id = $1`, [claimId])).map(r => r.diary_type))
      .toContain('RESERVE_ADEQUACY_REVIEW');
    // The audit entries carry the claim (resolved from the advance).
    expect((await db(`SELECT count(*)::int AS n FROM audit_ledger WHERE claim_id = $1 AND action = 'pd.advance_payment'`, [claimId]))[0].n).toBe(1);
  });

  test('if the payment ledger cannot record it, the week is not recorded either', async () => {
    const claimId = await seedClaim({ indemnity: 1000 });
    const advId = await seedAdvance(claimId);
    await db(`ALTER TABLE audit_ledger ADD CONSTRAINT test_block_payment_issued CHECK (action <> 'payment.issued') NOT VALID`);
    try {
      await expect(pdService.recordPDAdvancePayment(advId, {
        weekStartDate: '2026-06-15', weekEndDate: '2026-06-21', amountPaid: 290, actor: ADJ,
      })).rejects.toThrow(/payment.issued/);
    } finally {
      await db(`ALTER TABLE audit_ledger DROP CONSTRAINT test_block_payment_issued`);
    }
    expect(await db(`SELECT * FROM pd_advance_payments WHERE pd_advance_id = $1`, [advId])).toEqual([]);
    expect(await db(`SELECT * FROM payment_transactions WHERE claim_id = $1`, [claimId])).toEqual([]);
    expect(await balances(claimId)).toEqual({ outstanding: 1000, paid_to_date: 0, total_incurred: 1000 });
  });
});

describe('reserve approval', () => {
  test('moves the reserve ledger to the approved figures in the same unit', async () => {
    const claimId = await seedClaim({ indemnity: 500 });
    await runInTransaction({ tenantId: TENANT }, (tx) => claimService.approveReserves(claimId,
      { medical: 1000, indemnity: 2500, expense: 0, reason: 'Initial evaluation' }, 'sup@tpa.test', { tx, actor: SUP }));
    const rows = await db(`SELECT category, transaction_type, amount_delta::float AS d FROM reserve_transactions
                            WHERE claim_id = $1 ORDER BY category, created_at`, [claimId]);
    expect(rows).toEqual([
      { category: 'indemnity', transaction_type: 'initial_reserve', d: 500 },
      { category: 'indemnity', transaction_type: 'reserve_revision', d: 2000 },
      { category: 'medical', transaction_type: 'initial_reserve', d: 1000 },
    ]);
  });
});
