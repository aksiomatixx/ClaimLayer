'use strict';

/**
 * Unit tests — PD advance cap (M14.5).
 *
 * Covers:
 *   initiatePDAdvances    — denominator selection + pre_qme notes
 *   recordPDAdvancePayment — cap enforcement, first_payment_at, completed
 *                             status transition, voided-payment SUM
 *   overrideAdvanceCap     — ai_decisions snapshot, cap bypass
 *   _resolveCapPolicy      — override / represented / unrepresented
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const pdService    = require('../../src/services/pdService');
const { supabase } = require('../../src/services/supabase');

async function seedClaim(overrides = {}) {
  const id = overrides.id || `claim_cap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from('claims').insert({
    id,
    status:  'pd_evaluation',
    aww:     750,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

async function seedPdEval(claimId, overrides = {}) {
  const id = `pdeval_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const row = {
    id,
    claim_id:             claimId,
    wpi:                  15,
    pd_percent:           24,
    pd_weeks:             72,
    pd_weekly_rate:       290,
    pd_total_value:       20_880,
    apportionment_percent: 0,
    adjusted_pd_percent:  24,
    adjusted_total_value: 20_880,
    calculated_at:        new Date().toISOString(),
    ...overrides,
  };
  await supabase.from('pd_evaluations').insert(row);
  return row;
}

async function seedAdvance(claimId, pdEvalId, overrides = {}) {
  const row = await pdService.initiatePDAdvances(claimId, pdEvalId, { tdEndDate: '2026-01-01' });
  if (Object.keys(overrides).length) {
    const { data: updated } = await supabase.from('pd_advances')
      .update(overrides).eq('id', row.id).select().single();
    return updated;
  }
  return row;
}

beforeEach(() => {
  supabase._resetStore();
});

// ═════════════════════════════════════════════════════════════════════════════
// initiatePDAdvances — denominator selection
// ═════════════════════════════════════════════════════════════════════════════
describe('initiatePDAdvances — denominator priority', () => {
  it('prefers adjusted_total_value over pd_total_value → pr_4 source by default', async () => {
    const claimId = await seedClaim();
    const pdEval  = await seedPdEval(claimId, {
      pd_total_value:       30_000,
      adjusted_total_value: 22_500, // 25% apportionment
    });
    const adv = await pdService.initiatePDAdvances(claimId, pdEval.id, { tdEndDate: '2026-01-01' });
    expect(parseFloat(adv.estimated_pd_denominator)).toBe(22_500);
    expect(adv.denominator_source).toBe('pr_4');
  });

  it('uses qme_rated when pdEval.evaluation_type === "qme"', async () => {
    const claimId = await seedClaim();
    const pdEval  = await seedPdEval(claimId, {
      adjusted_total_value: 18_000,
      evaluation_type:      'qme',
    });
    const adv = await pdService.initiatePDAdvances(claimId, pdEval.id, { tdEndDate: '2026-01-01' });
    expect(adv.denominator_source).toBe('qme_rated');
  });

  it('falls back to pd_total_value + pre_qme + notes when adjusted not populated', async () => {
    const claimId = await seedClaim();
    const pdEval  = await seedPdEval(claimId, {
      pd_total_value:       20_880,
      adjusted_total_value: null,
    });
    const adv = await pdService.initiatePDAdvances(claimId, pdEval.id, { tdEndDate: '2026-01-01' });
    expect(parseFloat(adv.estimated_pd_denominator)).toBe(20_880);
    expect(adv.denominator_source).toBe('pre_qme');
    expect(adv.notes).toContain('PRE_QME_DENOMINATOR');
  });

  it('throws PD_EVALUATION_REQUIRED_BEFORE_ADVANCE when both totals zero', async () => {
    const claimId = await seedClaim();
    const pdEval  = await seedPdEval(claimId, {
      pd_total_value:       0,
      adjusted_total_value: 0,
    });
    await expect(
      pdService.initiatePDAdvances(claimId, pdEval.id, { tdEndDate: '2026-01-01' }),
    ).rejects.toThrow('PD_EVALUATION_REQUIRED_BEFORE_ADVANCE');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// recordPDAdvancePayment — cap enforcement
// ═════════════════════════════════════════════════════════════════════════════
describe('recordPDAdvancePayment — cap enforcement', () => {
  it('succeeds within cap and writes a pd_advance_payments row', async () => {
    const claimId = await seedClaim();
    const pdEval  = await seedPdEval(claimId, { adjusted_total_value: 10_000 });
    const adv     = await seedAdvance(claimId, pdEval.id);

    await pdService.recordPDAdvancePayment(adv.id, {
      weekStartDate: '2026-01-01', weekEndDate: '2026-01-07',
      amountPaid:    290,
    });

    const { data: rows } = await supabase.from('pd_advance_payments').select('*').eq('pd_advance_id', adv.id);
    expect(rows).toHaveLength(1);
    expect(parseFloat(rows[0].amount_paid)).toBe(290);
  });

  it('unrepresented claim enforces 100% cap — overflow throws ADVANCE_CAP_EXCEEDED', async () => {
    const claimId = await seedClaim({ /* no attorney fields */ });
    const pdEval  = await seedPdEval(claimId, { adjusted_total_value: 1_000 });
    const adv     = await seedAdvance(claimId, pdEval.id);

    // $500 first payment — well under 100% × 1000 = 1000.
    await pdService.recordPDAdvancePayment(adv.id, {
      weekStartDate: '2026-01-01', weekEndDate: '2026-01-07',
      amountPaid:    500,
    });

    // $501 projected total $1001 → exceeds cap + 0.01.
    await expect(pdService.recordPDAdvancePayment(adv.id, {
      weekStartDate: '2026-01-08', weekEndDate: '2026-01-14',
      amountPaid:    501,
    })).rejects.toThrow('ADVANCE_CAP_EXCEEDED');
  });

  it('represented claim enforces 85% cap — overflow throws ADVANCE_CAP_EXCEEDED', async () => {
    const claimId = await seedClaim({ attorney_represented: true });
    const pdEval  = await seedPdEval(claimId, { adjusted_total_value: 1_000 });
    const adv     = await seedAdvance(claimId, pdEval.id);

    // $400 first payment — under 85% × 1000 = 850.
    await pdService.recordPDAdvancePayment(adv.id, {
      weekStartDate: '2026-01-01', weekEndDate: '2026-01-07',
      amountPaid:    400,
    });

    // $451 projected total $851 → exceeds cap + 0.01.
    await expect(pdService.recordPDAdvancePayment(adv.id, {
      weekStartDate: '2026-01-08', weekEndDate: '2026-01-14',
      amountPaid:    451,
    })).rejects.toThrow('ADVANCE_CAP_EXCEEDED');
  });

  it('cap_overridden=true bypasses enforcement at override_pct', async () => {
    const claimId = await seedClaim({ attorney_represented: true });
    const pdEval  = await seedPdEval(claimId, { adjusted_total_value: 1_000 });
    const adv     = await seedAdvance(claimId, pdEval.id);

    await pdService.overrideAdvanceCap(adv.id, {
      overridePct: 0.95, reason: 'Approved by supervisor', overrideBy: 'adj-sup-001',
    });

    // $900 now allowed (95% of 1000), even though represented default is 85%.
    await pdService.recordPDAdvancePayment(adv.id, {
      weekStartDate: '2026-01-01', weekEndDate: '2026-01-07',
      amountPaid:    900,
    });
    const { data: payments } = await supabase.from('pd_advance_payments').select('*').eq('pd_advance_id', adv.id);
    expect(payments).toHaveLength(1);
  });

  it('legacy row (NULL denominator) skips cap enforcement', async () => {
    const claimId = await seedClaim({ attorney_represented: true });
    await supabase.from('pd_advances').insert({
      id: 'legacy_adv', claim_id: claimId, pd_evaluation_id: null,
      td_end_date: '2026-01-01', advance_due_date: '2026-01-15',
      weekly_rate: 290, status: 'pending',
      estimated_pd_denominator: null, // legacy
      created_at: new Date().toISOString(),
    });

    // No cap — arbitrary large payment succeeds.
    await pdService.recordPDAdvancePayment('legacy_adv', {
      weekStartDate: '2026-01-01', weekEndDate: '2026-01-07',
      amountPaid:    99_999,
    });
    const { data: payments } = await supabase.from('pd_advance_payments').select('*').eq('pd_advance_id', 'legacy_adv');
    expect(payments).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// recordPDAdvancePayment — status transitions + SUM
// ═════════════════════════════════════════════════════════════════════════════
describe('recordPDAdvancePayment — transitions, SUM, voided', () => {
  it('sets first_payment_at on first paid row only', async () => {
    const claimId = await seedClaim();
    const pdEval  = await seedPdEval(claimId, { adjusted_total_value: 5_000 });
    const adv     = await seedAdvance(claimId, pdEval.id);

    await pdService.recordPDAdvancePayment(adv.id, {
      weekStartDate: '2026-01-01', weekEndDate: '2026-01-07', amountPaid: 290,
    });
    const { data: after1 } = await supabase.from('pd_advances').select('*').eq('id', adv.id).single();
    const firstTimestamp = after1.first_payment_at;
    expect(firstTimestamp).toBeTruthy();

    await pdService.recordPDAdvancePayment(adv.id, {
      weekStartDate: '2026-01-08', weekEndDate: '2026-01-14', amountPaid: 290,
    });
    const { data: after2 } = await supabase.from('pd_advances').select('*').eq('id', adv.id).single();
    expect(after2.first_payment_at).toBe(firstTimestamp);
  });

  it('sets pd_advances.status = completed when cap reached within $1', async () => {
    const claimId = await seedClaim(); // unrepresented → 100% cap
    const pdEval  = await seedPdEval(claimId, { adjusted_total_value: 500 });
    const adv     = await seedAdvance(claimId, pdEval.id);

    await pdService.recordPDAdvancePayment(adv.id, {
      weekStartDate: '2026-01-01', weekEndDate: '2026-01-07', amountPaid: 500,
    });
    const { data: after } = await supabase.from('pd_advances').select('*').eq('id', adv.id).single();
    expect(after.status).toBe('completed');
  });

  it('correctly SUMs across multiple paid payments', async () => {
    const claimId = await seedClaim();
    const pdEval  = await seedPdEval(claimId, { adjusted_total_value: 10_000 });
    const adv     = await seedAdvance(claimId, pdEval.id);

    await pdService.recordPDAdvancePayment(adv.id, {
      weekStartDate: '2026-01-01', weekEndDate: '2026-01-07', amountPaid: 290,
    });
    await pdService.recordPDAdvancePayment(adv.id, {
      weekStartDate: '2026-01-08', weekEndDate: '2026-01-14', amountPaid: 290,
    });
    await pdService.recordPDAdvancePayment(adv.id, {
      weekStartDate: '2026-01-15', weekEndDate: '2026-01-21', amountPaid: 290,
    });
    // Next one should be under the 10_000 cap too — within 870 + 290 = 1160.
    await pdService.recordPDAdvancePayment(adv.id, {
      weekStartDate: '2026-01-22', weekEndDate: '2026-01-28', amountPaid: 290,
    });

    const { data: rows } = await supabase.from('pd_advance_payments').select('*').eq('pd_advance_id', adv.id);
    expect(rows).toHaveLength(4);
  });

  it('voided payments are excluded from the cap SUM', async () => {
    const claimId = await seedClaim(); // unrepresented → 100% cap
    const pdEval  = await seedPdEval(claimId, { adjusted_total_value: 1_000 });
    const adv     = await seedAdvance(claimId, pdEval.id);

    // Seed a voided $900 payment directly.
    await supabase.from('pd_advance_payments').insert({
      pd_advance_id:   adv.id,
      claim_id:        claimId,
      week_start_date: '2025-12-25',
      week_end_date:   '2025-12-31',
      amount_paid:     900,
      status:          'voided',
      void_reason:     'Duplicate issued',
      created_at:      new Date().toISOString(),
    });

    // Should be able to pay the full $1000 because voided rows don't count.
    await pdService.recordPDAdvancePayment(adv.id, {
      weekStartDate: '2026-01-01', weekEndDate: '2026-01-07', amountPaid: 1_000,
    });
    const { data: rows } = await supabase.from('pd_advance_payments').select('*').eq('pd_advance_id', adv.id);
    expect(rows.length).toBe(2);
  });

  it('rejects non-positive amountPaid', async () => {
    const claimId = await seedClaim();
    const pdEval  = await seedPdEval(claimId);
    const adv     = await seedAdvance(claimId, pdEval.id);
    await expect(pdService.recordPDAdvancePayment(adv.id, {
      weekStartDate: '2026-01-01', weekEndDate: '2026-01-07', amountPaid: 0,
    })).rejects.toThrow('amountPaid');
  });

  it('rejects missing week dates', async () => {
    const claimId = await seedClaim();
    const pdEval  = await seedPdEval(claimId);
    const adv     = await seedAdvance(claimId, pdEval.id);
    await expect(pdService.recordPDAdvancePayment(adv.id, {
      weekStartDate: '2026-01-01', amountPaid: 290,
    })).rejects.toThrow('weekStartDate and weekEndDate');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// overrideAdvanceCap
// ═════════════════════════════════════════════════════════════════════════════
describe('overrideAdvanceCap', () => {
  it('writes cap_overridden, cap_override_pct, cap_override_by, cap_override_reason', async () => {
    const claimId = await seedClaim({ attorney_represented: true });
    const pdEval  = await seedPdEval(claimId);
    const adv     = await seedAdvance(claimId, pdEval.id);

    const updated = await pdService.overrideAdvanceCap(adv.id, {
      overridePct: 0.9, reason: 'Supervisor approved', overrideBy: 'adj-supervisor',
    });
    expect(updated.cap_overridden).toBe(true);
    expect(parseFloat(updated.cap_override_pct)).toBe(0.9);
    expect(updated.cap_override_by).toBe('adj-supervisor');
    expect(updated.cap_override_reason).toBe('Supervisor approved');
  });

  it('writes ai_decisions row with input_snapshot capturing prior values', async () => {
    const claimId = await seedClaim({ attorney_represented: true });
    const pdEval  = await seedPdEval(claimId);
    const adv     = await seedAdvance(claimId, pdEval.id);

    await pdService.overrideAdvanceCap(adv.id, {
      overridePct: 0.9, reason: 'r', overrideBy: 'u',
    });
    const { data: decisions } = await supabase.from('ai_decisions').select('*').eq('claim_id', claimId);
    const match = decisions.find(d => d.decision_type === 'pd_advance_cap_override');
    expect(match).toBeDefined();
    expect(match.review_action).toBe('approved');
    expect(match.input_snapshot).toBeDefined();
    expect(match.input_snapshot.pdAdvanceId).toBe(adv.id);
  });

  it('rejects an overridePct outside (0, 1]', async () => {
    const claimId = await seedClaim();
    const pdEval  = await seedPdEval(claimId);
    const adv     = await seedAdvance(claimId, pdEval.id);
    await expect(pdService.overrideAdvanceCap(adv.id, { overridePct: 1.5, reason: 'x' })).rejects.toThrow();
    await expect(pdService.overrideAdvanceCap(adv.id, { overridePct: 0,   reason: 'x' })).rejects.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// _resolveCapPolicy — unit
// ═════════════════════════════════════════════════════════════════════════════
describe('_resolveCapPolicy', () => {
  it('override wins over represented', () => {
    const policy = pdService._resolveCapPolicy(
      { attorney_represented: true },
      { cap_overridden: true, cap_override_pct: 0.92 },
    );
    expect(policy.source).toBe('override');
    expect(policy.pct).toBe(0.92);
  });

  it('represented → 0.85', () => {
    const policy = pdService._resolveCapPolicy({ attorney_represented: true }, null);
    expect(policy.source).toBe('represented');
    expect(policy.pct).toBe(0.85);
  });

  it('unrepresented → 1.00', () => {
    const policy = pdService._resolveCapPolicy({}, null);
    expect(policy.source).toBe('unrepresented');
    expect(policy.pct).toBe(1.0);
  });

  it('null claim → unrepresented (defensive)', () => {
    const policy = pdService._resolveCapPolicy(null, null);
    expect(policy.source).toBe('unrepresented');
  });
});
