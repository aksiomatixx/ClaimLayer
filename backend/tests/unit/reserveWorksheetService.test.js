'use strict';

/**
 * Itemized Reserve Worksheets (CL-RSV1).
 *
 * Line-item math (qty × unit, weeks × rate with the td_rate
 * derivation, flat), category rollups, validation, and the control
 * boundary: a worksheet change can only PROPOSE — it never mutates
 * approved reserves and never touches FileHandler; applying the rollup
 * goes through the same M3 approveReserves gate it always has.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const mockSetReserves = jest.fn().mockResolvedValue({ status: 'ok' });
jest.mock('../../src/services/filehandler', () => ({
  setReserves: (...a) => mockSetReserves(...a),
  addNote: jest.fn().mockResolvedValue({}),
  completeDiary: jest.fn().mockResolvedValue({}),
}));

const { supabase } = require('../../src/services/supabase');
const svc = require('../../src/services/reserveWorksheetService');

const CLAIM = 'claim_worksheet';

beforeEach(async () => {
  supabase._resetStore();
  mockSetReserves.mockClear();
  await supabase.from('claims').insert({
    id: CLAIM, claim_number: 'HHW-WS-1', status: 'under_investigation',
    date_of_injury: '2026-05-01', employer_id: 'emp-1',
    td_rate: 414, aww: 621, filehandler_id: 'FH-WS',
    employee: { firstName: 'Work', lastName: 'Sheet' },
  });
});

describe('line-item math', () => {
  it('quantity shape: qty × unit', async () => {
    const item = await svc.addLineItem(CLAIM, {
      category: 'medical', label: 'PTP visits', shape: 'quantity',
      quantity: 5, unit_amount: 250, basis_note: 'per PR-1 plan',
    }, 'adj@test');
    expect(item.total).toBe(1250);
  });

  it('weeks_rate shape: weeks × weekly rate', async () => {
    const item = await svc.addLineItem(CLAIM, {
      category: 'indemnity', label: 'TD', shape: 'weeks_rate',
      quantity: 6, unit_amount: 414,
    }, 'adj@test');
    expect(item.total).toBe(2484);
  });

  it('weeks_rate without a rate derives it from the claim td_rate — never synthesized', async () => {
    const item = await svc.addLineItem(CLAIM, {
      category: 'indemnity', label: 'TD', shape: 'weeks_rate', quantity: 4,
    }, 'adj@test');
    expect(item.unit_amount).toBe(414); // claims.td_rate
    expect(item.total).toBe(1656);
  });

  it('weeks_rate derivation fails loudly when the claim has no td_rate', async () => {
    await supabase.from('claims').update({ td_rate: null }).eq('id', CLAIM);
    await expect(svc.addLineItem(CLAIM, {
      category: 'indemnity', label: 'TD', shape: 'weeks_rate', quantity: 4,
    }, 'a')).rejects.toThrow('no td_rate');
  });

  it('flat shape: the flat amount is the total', async () => {
    const item = await svc.addLineItem(CLAIM, {
      category: 'indemnity', label: 'Estimated PD', shape: 'flat',
      flat_amount: 7500, basis_note: 'synthetic demo estimate',
    }, 'adj@test');
    expect(item.total).toBe(7500);
  });

  it('totals are computed server-side: a client-sent total is ignored', async () => {
    const item = await svc.addLineItem(CLAIM, {
      category: 'medical', label: 'MRI', shape: 'quantity',
      quantity: 1, unit_amount: 1400, total: 9,
    }, 'adj@test');
    expect(item.total).toBe(1400);
  });

  it('operands quantize to cents BEFORE multiplying — formula and total always agree', async () => {
    // Codex sweep B6: Postgres stores NUMERIC(…,2) operands, so the
    // arithmetic must run on the quantized values. 33.335 → 33.34, and
    // the stored total is exactly what the stored formula computes.
    const item = await svc.addLineItem(CLAIM, {
      category: 'medical', label: 'PT', shape: 'quantity',
      quantity: 3, unit_amount: 33.335,
    }, 'a');
    expect(item.unit_amount).toBe(33.34);
    expect(item.total).toBe(100.02);
    expect(item.total).toBe(Math.round(item.quantity * item.unit_amount * 100) / 100);
  });
});

describe('validation', () => {
  it('rejects unknown categories and shapes', async () => {
    await expect(svc.addLineItem(CLAIM, { category: 'legal_fees', label: 'x', quantity: 1, unit_amount: 1 }, 'a'))
      .rejects.toThrow('category must be one of');
    await expect(svc.addLineItem(CLAIM, { category: 'medical', label: 'x', shape: 'percentage', quantity: 1, unit_amount: 1 }, 'a'))
      .rejects.toThrow('shape must be one of');
  });

  it('rejects missing label, non-positive quantity, negative amounts, flat without amount', async () => {
    await expect(svc.addLineItem(CLAIM, { category: 'medical', label: '  ', quantity: 1, unit_amount: 1 }, 'a'))
      .rejects.toThrow('label is required');
    await expect(svc.addLineItem(CLAIM, { category: 'medical', label: 'x', quantity: 0, unit_amount: 1 }, 'a'))
      .rejects.toThrow('quantity must be a positive number');
    await expect(svc.addLineItem(CLAIM, { category: 'medical', label: 'x', quantity: 1, unit_amount: -5 }, 'a'))
      .rejects.toThrow('unit_amount must be a non-negative number');
    await expect(svc.addLineItem(CLAIM, { category: 'medical', label: 'x', shape: 'flat' }, 'a'))
      .rejects.toThrow('flat_amount must be a non-negative number');
  });

  it('rejects an unknown claim', async () => {
    await expect(svc.addLineItem('claim_nope', { category: 'medical', label: 'x', quantity: 1, unit_amount: 1 }, 'a'))
      .rejects.toThrow('Claim not found');
  });
});

describe('rollups', () => {
  async function seedWorksheet() {
    await svc.addLineItem(CLAIM, { category: 'medical', label: 'PTP visits', quantity: 5, unit_amount: 250 }, 'a');
    await svc.addLineItem(CLAIM, { category: 'medical', label: 'MRI', quantity: 1, unit_amount: 1400 }, 'a');
    await svc.addLineItem(CLAIM, { category: 'indemnity', label: 'TD', shape: 'weeks_rate', quantity: 6, unit_amount: 414 }, 'a');
    await svc.addLineItem(CLAIM, { category: 'indemnity', label: 'Est. PD', shape: 'flat', flat_amount: 7500 }, 'a');
    await svc.addLineItem(CLAIM, { category: 'expense', label: 'Copy service', quantity: 2, unit_amount: 85 }, 'a');
  }

  it('category subtotals and grand total', async () => {
    await seedWorksheet();
    const ws = await svc.getWorksheet(CLAIM);
    expect(ws.subtotals).toEqual({ medical: 2650, indemnity: 9984, expense: 170 });
    expect(ws.grand_total).toBe(12804);
    expect(ws.items.medical).toHaveLength(2);
    expect(ws.items.indemnity).toHaveLength(2);
    expect(ws.items.expense).toHaveLength(1);
  });

  it('update and remove recompute the rollup', async () => {
    await seedWorksheet();
    const ws1 = await svc.getWorksheet(CLAIM);
    const mri = ws1.items.medical.find(i => i.label === 'MRI');
    await svc.updateLineItem(mri.id, { quantity: 2 }, 'a');
    const copy = ws1.items.expense[0];
    await svc.removeLineItem(copy.id, 'a');

    const ws2 = await svc.getWorksheet(CLAIM);
    expect(ws2.subtotals.medical).toBe(4050); // 1250 + 2×1400
    expect(ws2.subtotals.expense).toBe(0);
    expect(ws2.grand_total).toBe(14034);
  });

  it('an empty worksheet reports no_worksheet', async () => {
    const ws = await svc.getWorksheet(CLAIM);
    expect(ws.proposal.status).toBe('no_worksheet');
    expect(ws.grand_total).toBe(0);
  });
});

describe('the M3 approval workflow stays the control point', () => {
  it('worksheet changes NEVER mutate approved reserves or touch FileHandler', async () => {
    await svc.addLineItem(CLAIM, { category: 'medical', label: 'PTP visits', quantity: 5, unit_amount: 250 }, 'a');
    const ws = await svc.getWorksheet(CLAIM);

    expect(ws.proposal.status).toBe('pending_approval');
    expect(mockSetReserves).not.toHaveBeenCalled();
    const { data: reserves } = await supabase.from('reserves').select('*').eq('claim_id', CLAIM);
    expect(reserves).toHaveLength(0); // nothing approved by the worksheet itself
  });

  it('applying the rollup through approveReserves flips the proposal to approved', async () => {
    const claimService = require('../../src/services/claimService');
    await svc.addLineItem(CLAIM, { category: 'medical', label: 'PTP visits', quantity: 5, unit_amount: 250 }, 'a');
    await svc.addLineItem(CLAIM, { category: 'indemnity', label: 'TD', shape: 'weeks_rate', quantity: 6 }, 'a');
    const before = await svc.getWorksheet(CLAIM);
    expect(before.proposal.status).toBe('pending_approval');

    await claimService.approveReserves(CLAIM, {
      medical: before.proposal.medical,
      indemnity: before.proposal.indemnity,
      expense: before.proposal.expense,
      reason: before.proposal.reason,
    }, 'adjuster@test');
    expect(mockSetReserves).toHaveBeenCalledTimes(1); // THE control point fired

    const after = await svc.getWorksheet(CLAIM);
    expect(after.proposal.status).toBe('approved');
    expect(after.approved_reserves.medical).toBe(1250);
    expect(after.approved_reserves.indemnity).toBe(2484);
  });

  it('a later worksheet change re-opens the proposal', async () => {
    const claimService = require('../../src/services/claimService');
    await svc.addLineItem(CLAIM, { category: 'expense', label: 'Copy service', quantity: 2, unit_amount: 85 }, 'a');
    const ws = await svc.getWorksheet(CLAIM);
    await claimService.approveReserves(CLAIM, {
      medical: 0, indemnity: 0, expense: ws.proposal.expense, reason: 'rollup',
    }, 'adjuster@test');
    expect((await svc.getWorksheet(CLAIM)).proposal.status).toBe('approved');

    await svc.addLineItem(CLAIM, { category: 'expense', label: 'Interpreter', quantity: 1, unit_amount: 120 }, 'a');
    expect((await svc.getWorksheet(CLAIM)).proposal.status).toBe('pending_approval');
  });

  it('every worksheet change is documented as a claim event', async () => {
    const item = await svc.addLineItem(CLAIM, { category: 'medical', label: 'PT', quantity: 12, unit_amount: 125 }, 'adj@test');
    await svc.updateLineItem(item.id, { quantity: 10 }, 'adj@test');
    await svc.removeLineItem(item.id, 'adj@test');

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    const ops = events.filter(e => e.type === 'reserve_worksheet_updated').map(e => e.data.op);
    expect(ops.sort()).toEqual(['add', 'remove', 'update']);
  });
});
