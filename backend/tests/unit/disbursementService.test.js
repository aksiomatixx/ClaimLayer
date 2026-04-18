'use strict';

/**
 * Unit tests — disbursementService (M14.5).
 *
 * Supabase is the in-memory mock. No AI calls in this file.
 * Flag assertions use toContain so co-occurring flags don't fail.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const disbursementService = require('../../src/services/disbursementService');
const pdService           = require('../../src/services/pdService');
const cnrService          = require('../../src/services/cnrService');
const { supabase }        = require('../../src/services/supabase');

const BASE_EXTRACTION = {
  awardDate:               '2026-05-10',
  awardServiceDate:        '2026-05-15',
  accruedStartDate:        '2026-02-01',
  totalAward:              60_000,
  apportionmentPct:        0,
  weeklyRate:              290,
  aaFeePct:                12,
  aaFeeAmount:             7_200,
  commutationOrdered:      false,
  bodyPartsAwarded:        ['Lumbar Spine'],
  futureMedical:           true,
  rawExtractionConfidence: 90,
  notes:                   '',
};

async function seedClaim(overrides = {}) {
  const id = overrides.id || `claim_db_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from('claims').insert({
    id,
    status:     'settlement_discussions',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

async function seedStip(claimId, overrides = {}) {
  const id = `stip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from('stipulations').insert({
    id,
    claim_id:        claimId,
    pd_percent:      24,
    pd_total_value:  60_000,
    future_medical:  true,
    status:          'filed',
    created_at:      new Date().toISOString(),
    updated_at:      new Date().toISOString(),
    ...overrides,
  });
  return id;
}

async function seedOffer(claimId, overrides = {}) {
  const id = `offer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from('settlement_offers').insert({
    id,
    claim_id:   claimId,
    offer_type: 'cnr',
    cnr_value:  75_000,
    status:     'filed',
    created_at: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

async function seedAdvancePayment(claimId, advanceId, amount) {
  const pdAdvId = advanceId || `adv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  if (!advanceId) {
    await supabase.from('pd_advances').insert({
      id: pdAdvId, claim_id: claimId, pd_evaluation_id: null,
      td_end_date: '2026-01-01', advance_due_date: '2026-01-15',
      weekly_rate: 290, status: 'active',
      created_at: new Date().toISOString(),
    });
  }
  await supabase.from('pd_advance_payments').insert({
    pd_advance_id:   pdAdvId,
    claim_id:        claimId,
    week_start_date: '2026-03-01',
    week_end_date:   '2026-03-07',
    amount_paid:     amount,
    status:          'paid',
    created_at:      new Date().toISOString(),
  });
  return pdAdvId;
}

beforeEach(() => {
  supabase._resetStore();
});

// ═════════════════════════════════════════════════════════════════════════════
// proposeDisbursement — happy paths
// ═════════════════════════════════════════════════════════════════════════════
describe('proposeDisbursement — happy paths', () => {
  it('stip F&A with zero advances: accrued + scheduled populated, net = accrued - fee', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: BASE_EXTRACTION,
    });
    expect(bundle.status).toBe('proposed');
    expect(parseFloat(bundle.accrued_amount)).toBeGreaterThan(0);
    expect(parseFloat(bundle.scheduled_amount)).toBeGreaterThan(0);
    expect(parseFloat(bundle.total_award)).toBe(60_000);
  });

  it('C&R OACR: advances = 80% of award, net_now reflects offset', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOffer(claimId);
    await seedAdvancePayment(claimId, null, 48_000); // 80% of 60000

    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'cnr_oacr', settlementOfferId: offerId,
      extraction: BASE_EXTRACTION,
    });
    expect(parseFloat(bundle.advances_paid_to_date)).toBe(48_000);
    expect(parseFloat(bundle.advances_offset_applied)).toBe(48_000);
  });

  it('unrepresented + no AA fee: no AA_FEE_UNUSUAL, zero fee amount', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: { ...BASE_EXTRACTION, aaFeePct: null, aaFeeAmount: null },
    });
    expect(bundle.flags).not.toContain('AA_FEE_UNUSUAL');
    expect(parseFloat(bundle.aa_fee_amount)).toBe(0);
  });

  it('represented + commutation ordered + AA fee > 0: commutes off far end', async () => {
    const claimId = await seedClaim({ attorney_represented: true });
    const stipId  = await seedStip(claimId);
    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: { ...BASE_EXTRACTION, commutationOrdered: true },
    });
    expect(bundle.aa_fee_commuted).toBe(true);
    expect(parseFloat(bundle.aa_fee_weeks_eliminated)).toBeGreaterThan(0);
    expect(parseFloat(bundle.aa_fee_pv_at_commutation)).toBeLessThan(7_200); // PV discount visible
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// proposeDisbursement — flags
// ═════════════════════════════════════════════════════════════════════════════
describe('proposeDisbursement — flag scenarios', () => {
  it('LIEN_PRESENT_ADJUSTER_REVIEW is always flagged (M20 stub)', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: BASE_EXTRACTION,
    });
    expect(bundle.flags).toContain('LIEN_PRESENT_ADJUSTER_REVIEW');
  });

  it('OVERPAYMENT_RECOVERABLE when advances > total award', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    await seedAdvancePayment(claimId, null, 70_000); // > 60k award

    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: BASE_EXTRACTION,
    });
    expect(bundle.flags).toContain('OVERPAYMENT_RECOVERABLE');
    expect(parseFloat(bundle.net_to_worker_now)).toBe(0); // clamped
  });

  it('ADVANCE_CAP_RETROACTIVELY_EXCEEDED when represented paid > 85% × totalAward', async () => {
    const claimId = await seedClaim({ attorney_represented: true });
    const stipId  = await seedStip(claimId);
    await seedAdvancePayment(claimId, null, 54_000); // 90% of 60k

    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: BASE_EXTRACTION,
    });
    expect(bundle.flags).toContain('ADVANCE_CAP_RETROACTIVELY_EXCEEDED');
  });

  it('APPORTIONMENT_MISMATCH when extraction vs pd_evaluations > 5 pct', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    // Seed pd_evaluations with 10% apportionment.
    await supabase.from('pd_evaluations').insert({
      id: 'pe1', claim_id: claimId, wpi: 20, pd_percent: 30,
      pd_weeks: 100, pd_weekly_rate: 290, pd_total_value: 29_000,
      apportionment_percent: 10,
      adjusted_pd_percent: 27, adjusted_total_value: 26_100,
      calculated_at: new Date().toISOString(),
    });

    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: { ...BASE_EXTRACTION, apportionmentPct: 25 }, // 15-pt diff
    });
    expect(bundle.flags).toContain('APPORTIONMENT_MISMATCH');
  });

  it('AA_FEE_UNUSUAL at 8%', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: { ...BASE_EXTRACTION, aaFeePct: 8, aaFeeAmount: null },
    });
    expect(bundle.flags).toContain('AA_FEE_UNUSUAL');
  });

  it('AA_FEE_UNUSUAL at 18%', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: { ...BASE_EXTRACTION, aaFeePct: 18, aaFeeAmount: null },
    });
    expect(bundle.flags).toContain('AA_FEE_UNUSUAL');
  });

  it('DEU_RANGE_EXCEEDED when scheduled_weeks > 950 (commutation skipped)', async () => {
    const claimId = await seedClaim({ attorney_represented: true });
    const stipId  = await seedStip(claimId);
    // Inflate totalAward so scheduled weeks exceed 950.
    const extraction = {
      ...BASE_EXTRACTION,
      totalAward:         290_000, // 1000 weeks at $290
      accruedStartDate:   '2026-05-14', // 1-day accrual → 999 scheduled
      commutationOrdered: true,
    };
    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction,
    });
    expect(bundle.flags).toContain('DEU_RANGE_EXCEEDED');
    expect(bundle.aa_fee_commuted).toBe(false); // commutation skipped
  });

  it('SERVICE_DATE_MISSING + PAYMENT_DUE_PROVISIONAL when awardServiceDate null', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: { ...BASE_EXTRACTION, awardServiceDate: null },
    });
    expect(bundle.flags).toContain('SERVICE_DATE_MISSING');
    expect(bundle.flags).toContain('PAYMENT_DUE_PROVISIONAL');
  });

  it('P_AND_S_DISCREPANCY propagates from extraction.warnings', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: { ...BASE_EXTRACTION, warnings: ['P_AND_S_DISCREPANCY'] },
    });
    expect(bundle.flags).toContain('P_AND_S_DISCREPANCY');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// proposeDisbursement — errors
// ═════════════════════════════════════════════════════════════════════════════
describe('proposeDisbursement — errors', () => {
  it('WEEKLY_RATE_REQUIRED thrown when weeklyRate null', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    await expect(disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: { ...BASE_EXTRACTION, weeklyRate: null },
    })).rejects.toThrow('WEEKLY_RATE_REQUIRED');
  });

  it('throws when both stipulationId and settlementOfferId provided', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const offerId = await seedOffer(claimId);
    await expect(disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a',
      stipulationId: stipId, settlementOfferId: offerId,
      extraction: BASE_EXTRACTION,
    })).rejects.toThrow('XOR');
  });

  it('throws when neither stipulationId nor settlementOfferId provided', async () => {
    const claimId = await seedClaim();
    await expect(disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a',
      extraction: BASE_EXTRACTION,
    })).rejects.toThrow('XOR');
  });

  it('throws when claim not found', async () => {
    await expect(disbursementService.proposeDisbursement({
      claimId:       'claim_missing',
      awardType:     'stip_f_and_a',
      stipulationId: 'any_stip',
      extraction:    BASE_EXTRACTION,
    })).rejects.toThrow('not found');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// approveDisbursement / rejectDisbursement
// ═════════════════════════════════════════════════════════════════════════════
describe('approveDisbursement', () => {
  it('proposed → approved and writes ai_decisions row', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: BASE_EXTRACTION,
    });

    const approved = await disbursementService.approveDisbursement(bundle.id, {
      adjusterId: 'adj-001', notes: 'Looks correct',
    });
    expect(approved.status).toBe('approved');
    expect(approved.approved_by).toBe('adj-001');

    const { data: decisions } = await supabase.from('ai_decisions').select('*').eq('claim_id', claimId);
    const match = decisions.find(d => d.decision_type === 'disbursement_approval');
    expect(match).toBeDefined();
    expect(match.review_action).toBe('approved');
  });

  it('refuses to approve a non-proposed bundle', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: BASE_EXTRACTION,
    });
    await disbursementService.approveDisbursement(bundle.id, { adjusterId: 'adj' });
    await expect(disbursementService.approveDisbursement(bundle.id, { adjusterId: 'adj' })).rejects.toThrow(/Cannot approve/);
  });
});

describe('rejectDisbursement', () => {
  it('proposed → rejected with reason', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: BASE_EXTRACTION,
    });
    const rejected = await disbursementService.rejectDisbursement(bundle.id, {
      adjusterId: 'adj-001', reason: 'Wrong claim attached',
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejected_reason).toBe('Wrong claim attached');
  });

  it('requires a reason', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: BASE_EXTRACTION,
    });
    await expect(disbursementService.rejectDisbursement(bundle.id, { adjusterId: 'a' })).rejects.toThrow('reason');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// recordDisbursementPayment — timely / late / claim transitions
// ═════════════════════════════════════════════════════════════════════════════
describe('recordDisbursementPayment', () => {
  async function proposedApprovedStip(claimId, stipOverrides = {}) {
    const stipId = await seedStip(claimId, stipOverrides);
    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: BASE_EXTRACTION,
    });
    await disbursementService.approveDisbursement(bundle.id, { adjusterId: 'adj-001' });
    return bundle;
  }

  it('timely payment → no INTEREST_OWED_LATE_PAYMENT flag', async () => {
    const claimId = await seedClaim();
    const bundle  = await proposedApprovedStip(claimId);

    const paid = await disbursementService.recordDisbursementPayment(bundle.id, {
      paidDate:  '2026-05-20', // within 10 days of 2026-05-15 service
      reference: 'CHK-001',
    });
    expect(paid.status).toBe('disbursed');
    expect(paid.flags).not.toContain('INTEREST_OWED_LATE_PAYMENT');
    expect(parseFloat(paid.interest_owed)).toBe(0);
  });

  it('late payment → INTEREST_OWED_LATE_PAYMENT flag + deferred_penalty_flags row', async () => {
    const claimId = await seedClaim();
    const bundle  = await proposedApprovedStip(claimId);

    const paid = await disbursementService.recordDisbursementPayment(bundle.id, {
      paidDate:  '2026-07-20', // way past 2026-05-25 deadline
      reference: 'CHK-002',
    });
    expect(paid.flags).toContain('INTEREST_OWED_LATE_PAYMENT');
    expect(parseFloat(paid.interest_owed)).toBeGreaterThan(0);

    const { data: flags } = await supabase.from('deferred_penalty_flags').select('*').eq('claim_id', claimId);
    expect(flags).toHaveLength(1);
    expect(flags[0].statute).toBe('LC_5814');
    expect(parseFloat(flags[0].penalty_estimate)).toBeLessThanOrEqual(10_000);
  });

  it('penalty_estimate capped at $10,000 even for large awards', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const bundle  = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: { ...BASE_EXTRACTION, totalAward: 500_000 }, // 10% = 50k, should clamp
    });
    await disbursementService.approveDisbursement(bundle.id, { adjusterId: 'adj' });

    await disbursementService.recordDisbursementPayment(bundle.id, {
      paidDate: '2026-09-01', reference: 'CHK',
    });
    const { data: flags } = await supabase.from('deferred_penalty_flags').select('*').eq('claim_id', claimId);
    expect(parseFloat(flags[0].penalty_estimate)).toBe(10_000);
  });

  it('stip with future_medical=true → claim transitions to future_medical_only (common case)', async () => {
    const claimId = await seedClaim({ status: 'settlement_discussions' });
    const bundle  = await proposedApprovedStip(claimId, { future_medical: true });

    await disbursementService.recordDisbursementPayment(bundle.id, {
      paidDate: '2026-05-20', reference: 'CHK',
    });
    const { data: claim } = await supabase.from('claims').select('*').eq('id', claimId).single();
    expect(claim.status).toBe('future_medical_only');
  });

  it('stip with future_medical=false → claim transitions to closed', async () => {
    const claimId = await seedClaim({ status: 'settlement_discussions' });
    const bundle  = await proposedApprovedStip(claimId, { future_medical: false });

    await disbursementService.recordDisbursementPayment(bundle.id, {
      paidDate: '2026-05-20', reference: 'CHK',
    });
    const { data: claim } = await supabase.from('claims').select('*').eq('id', claimId).single();
    expect(claim.status).toBe('closed');
  });

  it('refuses to pay a non-approved bundle', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const bundle = await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId,
      extraction: BASE_EXTRACTION,
    });
    await expect(disbursementService.recordDisbursementPayment(bundle.id, {
      paidDate: '2026-05-20',
    })).rejects.toThrow(/Cannot record payment/);
  });

  // C&R ordering
  it('C&R: throws CNR_PAYMENT_ORDER_VIOLATION when settlement_offer not paid', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOffer(claimId, { status: 'oacr_received' }); // NOT paid yet
    const bundle  = await disbursementService.proposeDisbursement({
      claimId, awardType: 'cnr_oacr', settlementOfferId: offerId,
      extraction: BASE_EXTRACTION,
    });
    await disbursementService.approveDisbursement(bundle.id, { adjusterId: 'adj' });

    await expect(disbursementService.recordDisbursementPayment(bundle.id, {
      paidDate: '2026-06-01',
    })).rejects.toThrow('CNR_PAYMENT_ORDER_VIOLATION');
  });

  it('C&R: succeeds when settlement_offers.paid_at is set and updated_at is fresh', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOffer(claimId, {
      status:     'paid',
      paid_at:    '2026-06-01',
      updated_at: new Date().toISOString(), // fresh
    });
    const bundle  = await disbursementService.proposeDisbursement({
      claimId, awardType: 'cnr_oacr', settlementOfferId: offerId,
      extraction: BASE_EXTRACTION,
    });
    await disbursementService.approveDisbursement(bundle.id, { adjusterId: 'adj' });

    const paid = await disbursementService.recordDisbursementPayment(bundle.id, {
      paidDate: '2026-06-01',
    });
    expect(paid.status).toBe('disbursed');
  });

  it('C&R: does NOT re-transition claim (cnrService owns the close)', async () => {
    const claimId = await seedClaim({ status: 'closed' }); // cnrService already moved it
    const offerId = await seedOffer(claimId, {
      status:     'paid',
      paid_at:    '2026-06-01',
      updated_at: new Date().toISOString(),
    });
    const bundle  = await disbursementService.proposeDisbursement({
      claimId, awardType: 'cnr_oacr', settlementOfferId: offerId,
      extraction: BASE_EXTRACTION,
    });
    await disbursementService.approveDisbursement(bundle.id, { adjusterId: 'adj' });
    await disbursementService.recordDisbursementPayment(bundle.id, {
      paidDate: '2026-06-01',
    });
    const { data: claim } = await supabase.from('claims').select('*').eq('id', claimId).single();
    expect(claim.status).toBe('closed'); // still closed, no re-transition event
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// getPendingDisbursements / getDisbursementsForClaim
// ═════════════════════════════════════════════════════════════════════════════
describe('getPendingDisbursements / getDisbursementsForClaim', () => {
  it('getPendingDisbursements returns only status=proposed', async () => {
    const c1 = await seedClaim();
    const c2 = await seedClaim();
    const s1 = await seedStip(c1); const s2 = await seedStip(c2);
    const b1 = await disbursementService.proposeDisbursement({
      claimId: c1, awardType: 'stip_f_and_a', stipulationId: s1, extraction: BASE_EXTRACTION,
    });
    await disbursementService.proposeDisbursement({
      claimId: c2, awardType: 'stip_f_and_a', stipulationId: s2, extraction: BASE_EXTRACTION,
    });
    // Approve one so it leaves the pending list.
    await disbursementService.approveDisbursement(b1.id, { adjusterId: 'adj' });

    const pending = await disbursementService.getPendingDisbursements();
    expect(pending).toHaveLength(1);
    expect(pending[0].claim_id).toBe(c2);
  });

  it('getDisbursementsForClaim returns claim rows newest-first', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    await disbursementService.proposeDisbursement({
      claimId, awardType: 'stip_f_and_a', stipulationId: stipId, extraction: BASE_EXTRACTION,
    });
    const rows = await disbursementService.getDisbursementsForClaim(claimId);
    expect(rows).toHaveLength(1);
  });
});
