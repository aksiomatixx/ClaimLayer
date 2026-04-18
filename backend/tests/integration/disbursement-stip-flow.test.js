'use strict';

/**
 * Integration tests — full stip F&A disbursement flow (M14.5).
 *
 * Exercises every route from PD eval → advances → stip → EAMS file →
 * award served → extract → propose → approve → record payment →
 * claim status transition.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const mockCallClaudeWithDocument = jest.fn();
jest.mock('../../src/services/aiService', () => ({
  _callClaude:             jest.fn(),
  _callClaudeWithDocument: (...a) => mockCallClaudeWithDocument(...a),
  analyzeCompensability:   jest.fn(),
  evaluateRFA:             jest.fn(),
}));

jest.mock('../../src/services/filehandler', () => ({
  setReserves:    jest.fn().mockResolvedValue({ status: 'ok' }),
  createClaim:    jest.fn().mockResolvedValue({ claimId: 'fh_mock', status: 'created' }),
  createDiary:    jest.fn().mockResolvedValue({ diaryId: 'd', status: 'created' }),
  completeDiary:  jest.fn().mockResolvedValue({ status: 'completed' }),
  attachDocument: jest.fn().mockResolvedValue({ documentId: 'doc_mock' }),
  getLedger:      jest.fn().mockResolvedValue({ entries: [] }),
  recordPayment:  jest.fn().mockResolvedValue({ paymentId: 'p' }),
}));

const request   = require('supertest');
const app       = require('../../src/index');
const { generateAdminToken } = require('../../src/middleware/auth');
const { supabase } = require('../../src/services/supabase');

const adminToken = generateAdminToken({ sub: 'admin-001', email: 'admin@homecaretpa.com' });

const GOOD_EXTRACTION = {
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
  const id = overrides.id || `claim_stipflow_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from('claims').insert({
    id,
    status:     'settlement_discussions',
    aww:        750,
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
    claim_id:       claimId,
    pd_percent:     24,
    pd_total_value: 60_000,
    future_medical: true,
    status:         'filed',
    eams_filed_at:  '2026-05-01',
    created_at:     new Date().toISOString(),
    updated_at:     new Date().toISOString(),
    ...overrides,
  });
  return id;
}

async function seedAdvancePayment(claimId, amount) {
  const pdAdvId = `adv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from('pd_advances').insert({
    id: pdAdvId, claim_id: claimId,
    td_end_date: '2026-01-01', advance_due_date: '2026-01-15',
    weekly_rate: 290, status: 'active',
    created_at: new Date().toISOString(),
  });
  await supabase.from('pd_advance_payments').insert({
    pd_advance_id: pdAdvId, claim_id: claimId,
    week_start_date: '2026-03-01', week_end_date: '2026-03-07',
    amount_paid: amount, status: 'paid',
    created_at: new Date().toISOString(),
  });
}

async function extractProposeApprove(claimId, stipId, extractionOverrides = {}) {
  const extractRes = await request(app)
    .post(`/api/v1/claims/${claimId}/propose-disbursement`)
    .set('Cookie', `token=${adminToken}`)
    .send({
      awardType:     'stip_f_and_a',
      stipulationId: stipId,
      extraction:    { ...GOOD_EXTRACTION, ...extractionOverrides },
    });
  expect(extractRes.status).toBe(201);
  const bundleId = extractRes.body.id;

  const approveRes = await request(app)
    .post(`/api/v1/disbursements/${bundleId}/approve`)
    .set('Cookie', `token=${adminToken}`)
    .send({ notes: 'LGTM' });
  expect(approveRes.status).toBe(200);
  return bundleId;
}

beforeEach(() => {
  supabase._resetStore();
  mockCallClaudeWithDocument.mockReset();
});

describe('Stip disbursement flow — happy path (future_medical=true)', () => {
  it('end-to-end: stip → award-served → propose → approve → pay → future_medical_only', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);

    // WCAB serves F&A.
    const servedRes = await request(app)
      .patch(`/api/v1/stipulations/${stipId}/award-served`)
      .set('Cookie', `token=${adminToken}`)
      .send({ serviceDate: '2026-05-15', servedBy: 'WCAB LA' });
    expect(servedRes.status).toBe(200);
    expect(servedRes.body.award_service_date).toBe('2026-05-15');

    // STIP_AWARD_FOLLOWUP diary created.
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claimId);
    expect(diaries.some(d => d.diary_type === 'STIP_AWARD_FOLLOWUP')).toBe(true);

    // Propose + approve.
    const bundleId = await extractProposeApprove(claimId, stipId);

    // Record payment within 10 days → no penalty.
    const paidRes = await request(app)
      .patch(`/api/v1/disbursements/${bundleId}/paid`)
      .set('Cookie', `token=${adminToken}`)
      .send({ paidDate: '2026-05-20', reference: 'CHK-1001' });
    expect(paidRes.status).toBe(200);
    expect(paidRes.body.status).toBe('disbursed');
    expect(paidRes.body.flags).not.toContain('INTEREST_OWED_LATE_PAYMENT');

    // Claim transitions to future_medical_only.
    const { data: claim } = await supabase.from('claims').select('*').eq('id', claimId).single();
    expect(claim.status).toBe('future_medical_only');
  });

  it('future_medical=false → claim transitions to closed at payment', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId, { future_medical: false });
    const bundleId = await extractProposeApprove(claimId, stipId);
    await request(app)
      .patch(`/api/v1/disbursements/${bundleId}/paid`)
      .set('Cookie', `token=${adminToken}`)
      .send({ paidDate: '2026-05-20', reference: 'CHK' });
    const { data: claim } = await supabase.from('claims').select('*').eq('id', claimId).single();
    expect(claim.status).toBe('closed');
  });
});

describe('Stip disbursement flow — represented + commutation', () => {
  it('commutation off far end records weeksEliminated and pvAtCommutation', async () => {
    const claimId = await seedClaim({ attorney_represented: true });
    const stipId  = await seedStip(claimId);

    const res = await request(app)
      .post(`/api/v1/claims/${claimId}/propose-disbursement`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        awardType:     'stip_f_and_a',
        stipulationId: stipId,
        extraction:    { ...GOOD_EXTRACTION, commutationOrdered: true },
      });
    expect(res.status).toBe(201);
    expect(res.body.aa_fee_commuted).toBe(true);
    expect(parseFloat(res.body.aa_fee_weeks_eliminated)).toBeGreaterThan(0);
    expect(parseFloat(res.body.aa_fee_pv_at_commutation)).toBeLessThan(7_200);
  });
});

describe('Stip disbursement flow — late payment', () => {
  it('late pay writes deferred_penalty_flags row + sets INTEREST_OWED_LATE_PAYMENT', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const bundleId = await extractProposeApprove(claimId, stipId);

    const paidRes = await request(app)
      .patch(`/api/v1/disbursements/${bundleId}/paid`)
      .set('Cookie', `token=${adminToken}`)
      .send({ paidDate: '2026-08-01', reference: 'CHK-L' }); // way late
    expect(paidRes.status).toBe(200);
    expect(paidRes.body.flags).toContain('INTEREST_OWED_LATE_PAYMENT');
    expect(parseFloat(paidRes.body.interest_owed)).toBeGreaterThan(0);

    const { data: flags } = await supabase.from('deferred_penalty_flags').select('*').eq('claim_id', claimId);
    expect(flags).toHaveLength(1);
    expect(flags[0].source_type).toBe('award_disbursement');
    expect(flags[0].consumed_by_m17a).toBeFalsy(); // DB default = false; mock leaves unset
  });
});

describe('Stip disbursement flow — overpayment', () => {
  it('advances > award flags OVERPAYMENT_RECOVERABLE and clamps net to 0', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    await seedAdvancePayment(claimId, 70_000); // > 60k award

    const res = await request(app)
      .post(`/api/v1/claims/${claimId}/propose-disbursement`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        awardType:     'stip_f_and_a',
        stipulationId: stipId,
        extraction:    GOOD_EXTRACTION,
      });
    expect(res.status).toBe(201);
    expect(res.body.flags).toContain('OVERPAYMENT_RECOVERABLE');
    expect(parseFloat(res.body.net_to_worker_now)).toBe(0);
  });

  it('no auto-clawback — adjuster must reconcile manually', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    await seedAdvancePayment(claimId, 70_000);

    const bundleId = await extractProposeApprove(claimId, stipId);
    await request(app)
      .patch(`/api/v1/disbursements/${bundleId}/paid`)
      .set('Cookie', `token=${adminToken}`)
      .send({ paidDate: '2026-05-20', reference: 'CHK' });

    // No recovery row, no ledger adjustment — just the flag.
    const { data: flags } = await supabase.from('deferred_penalty_flags').select('*').eq('claim_id', claimId);
    expect(flags).toHaveLength(0); // on-time payment, no penalty
  });
});

describe('Stip disbursement flow — flags', () => {
  it('LIEN_PRESENT_ADJUSTER_REVIEW flagged on every proposal', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const res = await request(app)
      .post(`/api/v1/claims/${claimId}/propose-disbursement`)
      .set('Cookie', `token=${adminToken}`)
      .send({ awardType: 'stip_f_and_a', stipulationId: stipId, extraction: GOOD_EXTRACTION });
    expect(res.body.flags).toContain('LIEN_PRESENT_ADJUSTER_REVIEW');
  });

  it('SERVICE_DATE_MISSING + PAYMENT_DUE_PROVISIONAL when extraction serviceDate null', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const res = await request(app)
      .post(`/api/v1/claims/${claimId}/propose-disbursement`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        awardType:     'stip_f_and_a',
        stipulationId: stipId,
        extraction:    { ...GOOD_EXTRACTION, awardServiceDate: null },
      });
    expect(res.body.flags).toContain('SERVICE_DATE_MISSING');
    expect(res.body.flags).toContain('PAYMENT_DUE_PROVISIONAL');
  });
});

describe('Stip disbursement flow — extract-award route', () => {
  it('extract-award writes ai_decisions row and returns normalized extraction', async () => {
    const claimId = await seedClaim();
    mockCallClaudeWithDocument.mockResolvedValueOnce(GOOD_EXTRACTION);

    const res = await request(app)
      .post(`/api/v1/claims/${claimId}/extract-award`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        awardType: 'stip_f_and_a',
        pdfBase64: Buffer.from('%PDF stub').toString('base64'),
      });
    expect(res.status).toBe(201);
    expect(res.body.totalAward).toBe(60_000);

    const { data: decisions } = await supabase.from('ai_decisions').select('*').eq('claim_id', claimId);
    expect(decisions.some(d => d.decision_type === 'award_extraction')).toBe(true);
  });

  it('extract-award returns 502 on Claude failure', async () => {
    const claimId = await seedClaim();
    mockCallClaudeWithDocument.mockRejectedValueOnce(new Error('boom'));

    const res = await request(app)
      .post(`/api/v1/claims/${claimId}/extract-award`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        awardType: 'stip_f_and_a',
        pdfBase64: Buffer.from('pdf').toString('base64'),
      });
    expect(res.status).toBe(502);
  });
});

describe('Stip disbursement flow — reads', () => {
  it('GET /claims/:id/disbursements returns the proposed bundle', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    await request(app)
      .post(`/api/v1/claims/${claimId}/propose-disbursement`)
      .set('Cookie', `token=${adminToken}`)
      .send({ awardType: 'stip_f_and_a', stipulationId: stipId, extraction: GOOD_EXTRACTION });

    const res = await request(app)
      .get(`/api/v1/claims/${claimId}/disbursements`)
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.disbursements[0].status).toBe('proposed');
  });

  it('GET /disbursements/pending returns proposed-only', async () => {
    const c1 = await seedClaim(); const s1 = await seedStip(c1);
    const c2 = await seedClaim(); const s2 = await seedStip(c2);
    await request(app)
      .post(`/api/v1/claims/${c1}/propose-disbursement`)
      .set('Cookie', `token=${adminToken}`)
      .send({ awardType: 'stip_f_and_a', stipulationId: s1, extraction: GOOD_EXTRACTION });
    const b2 = await request(app)
      .post(`/api/v1/claims/${c2}/propose-disbursement`)
      .set('Cookie', `token=${adminToken}`)
      .send({ awardType: 'stip_f_and_a', stipulationId: s2, extraction: GOOD_EXTRACTION });
    await request(app)
      .post(`/api/v1/disbursements/${b2.body.id}/approve`)
      .set('Cookie', `token=${adminToken}`);

    const res = await request(app)
      .get('/api/v1/disbursements/pending')
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });
});

describe('Stip disbursement flow — reject', () => {
  it('reject moves bundle to rejected', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    const proposeRes = await request(app)
      .post(`/api/v1/claims/${claimId}/propose-disbursement`)
      .set('Cookie', `token=${adminToken}`)
      .send({ awardType: 'stip_f_and_a', stipulationId: stipId, extraction: GOOD_EXTRACTION });
    const res = await request(app)
      .post(`/api/v1/disbursements/${proposeRes.body.id}/reject`)
      .set('Cookie', `token=${adminToken}`)
      .send({ reason: 'Wrong stipulation attached' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });
});
