'use strict';

/**
 * Integration tests — M14 C&R end-to-end flow.
 *
 *   MSA screen (not required) → price C&R → compare-offers → offer (attorney)
 *   → worker-accept → adjuster-sign → EAMS-filed → OACR-received → paid
 *   → claim status = 'closed'.
 *
 * Also covers MSA-required block, represented-worker block,
 * DONT_OFFER_CNR block, and withdraw-from-offered staying in
 * settlement_discussions.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const request      = require('supertest');
const app          = require('../../src/index');
const { generateAdminToken } = require('../../src/middleware/auth');
const { supabase } = require('../../src/services/supabase');

const mockCallClaude = jest.fn();
jest.mock('../../src/services/aiService', () => ({
  analyzeCompensability: jest.fn(),
  evaluateRFA: jest.fn(),
  _callClaude: (...args) => mockCallClaude(...args),
}));

jest.mock('../../src/services/filehandler', () => ({
  setReserves:    jest.fn().mockResolvedValue({ status: 'ok' }),
  createClaim:    jest.fn().mockResolvedValue({ claimId: 'fh_mock', status: 'created' }),
  createDiary:    jest.fn().mockResolvedValue({ diaryId: 'diy_mock' }),
  completeDiary:  jest.fn().mockResolvedValue({ status: 'completed' }),
  attachDocument: jest.fn().mockResolvedValue({ documentId: 'doc_mock' }),
  getLedger:      jest.fn().mockResolvedValue({ entries: [] }),
  recordPayment:  jest.fn().mockResolvedValue({ paymentId: 'pay_mock' }),
}));

jest.mock('../../src/services/adp', () => ({
  getEmployeeWithFinancials: jest.fn().mockResolvedValue({
    associateOID: 'BC-001', firstName: 'Maria', lastName: 'Santos',
    dob: '1985-03-12', address: { line1: '1234 Main St', state: 'CA', zip: '90001' },
    jobTitle: 'Home Health Aide II', hireDate: '2019-06-01',
    aww: 750.75, tdRate: 500.50, weeksCalculated: 52,
  }),
}));

jest.mock('../../src/services/lobService', () => ({
  sendLetter: jest.fn().mockResolvedValue({ letterId: 'ltr_mock', status: 'queued' }),
}));

const adminToken = generateAdminToken({ sub: 'admin-001', email: 'admin@homecaretpa.com' });

async function seed({ represented = false, dob = '1985-03-12' } = {}) {
  const claimId = `claim_cnr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from('claims').insert({
    id: claimId,
    claim_number: 'HHW-2026-CNR',
    employer_id: 'employer-brightcare-001',
    employer_name: 'BrightCare Home Health',
    status: 'pd_evaluation',
    employee: { firstName: 'Maria', lastName: 'Santos', dob, adpEmployeeId: 'BC-001', jobTitle: 'HHA' },
    attorney_represented: represented,
    aww: 750.75, td_rate: 500.50,
    date_of_injury: '2025-06-15',
    body_part: 'Lumbar Spine',
    injury_type: 'Lifting Injury',
    filed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  await supabase.from('pd_evaluations').insert({
    id: `pdeval_${Date.now()}`,
    claim_id: claimId,
    wpi: 10, pd_percent: 16, pd_weeks: 48, pd_weekly_rate: 290,
    pd_total_value: 13920,
    apportionment_percent: 0,
    adjusted_pd_percent: 16, adjusted_total_value: 13920,
    calculated_at: new Date().toISOString(),
  });

  await supabase.from('employees').insert({
    adp_employee_id: 'BC-001',
    first_name: 'Maria', last_name: 'Santos',
    ssdi_receiving: false,
    created_at: new Date().toISOString(),
  });

  return { claimId };
}

beforeEach(() => {
  supabase._resetStore();
  mockCallClaude.mockReset();
});

// ═════════════════════════════════════════════════════════════════════════════
// Happy path
// ═════════════════════════════════════════════════════════════════════════════
describe('C&R happy path end-to-end (attorney)', () => {
  it('MSA → price → compare → offer → accept → sign → file → OACR → paid → claim closed', async () => {
    const { claimId } = await seed({ represented: true });
    const auth = { Cookie: `token=${adminToken}` };

    // 1) MSA screen (not required — worker 41, settlement 22k)
    const msaRes = await request(app)
      .post(`/api/v1/claims/${claimId}/msa-screen`).set(auth)
      .send({ projectedSettlementValue: 22000 });
    expect(msaRes.status).toBe(201);
    expect(msaRes.body.required).toBe(false);

    // 2) Price C&R (MSA gate now passes)
    mockCallClaude.mockResolvedValue({
      cnrValueLow: 18000, cnrValueMid: 22000, cnrValueHigh: 28000,
      recommendation: 'adjuster_review',
    });
    const priceRes = await request(app)
      .post(`/api/v1/claims/${claimId}/cnr-price`).set(auth);
    expect(priceRes.status).toBe(201);
    expect(priceRes.body.cnrValue).toBe(22000);
    const offerId = priceRes.body.offerId;

    // 3) compare-offers
    const cmpRes = await request(app)
      .get(`/api/v1/claims/${claimId}/compare-offers`).set(auth);
    expect(cmpRes.status).toBe(200);
    expect(cmpRes.body.flag).toBe('CNR_VIABLE');

    // 4) offer (attorney — represented worker)
    const offerRes = await request(app)
      .post(`/api/v1/offers/${offerId}/offer`).set(auth)
      .send({ offeredTo: 'attorney' });
    expect(offerRes.status).toBe(200);
    expect(offerRes.body.status).toBe('offered');

    // Claim status should now be settlement_discussions
    const { data: c1 } = await supabase.from('claims').select('*').eq('id', claimId).single();
    expect(c1.status).toBe('settlement_discussions');

    // 5) worker-accept
    const acceptRes = await request(app)
      .post(`/api/v1/offers/${offerId}/worker-accept`).set(auth);
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.status).toBe('accepted');

    // 6) adjuster-sign (single-step → eams_ready)
    const signRes = await request(app)
      .post(`/api/v1/offers/${offerId}/adjuster-sign`).set(auth);
    expect(signRes.status).toBe(200);
    expect(signRes.body.status).toBe('eams_ready');
    expect(signRes.body.eams_package_ready).toBe(true);

    // 7) EAMS filed
    const filedRes = await request(app)
      .patch(`/api/v1/offers/${offerId}/eams-filed`).set(auth)
      .send({ filedDate: '2026-05-01' });
    expect(filedRes.status).toBe(200);
    expect(filedRes.body.status).toBe('filed');

    // 8) OACR received → payment_due_date = oacr + 30 cal days
    const oacrRes = await request(app)
      .patch(`/api/v1/offers/${offerId}/oacr-received`).set(auth)
      .send({ oacrDate: '2026-06-01' });
    expect(oacrRes.status).toBe(200);
    expect(oacrRes.body.status).toBe('oacr_received');
    expect(oacrRes.body.payment_due_date).toBe('2026-07-01');

    // 9) paid → claim closed
    const paidRes = await request(app)
      .patch(`/api/v1/offers/${offerId}/paid`).set(auth)
      .send({ paidDate: '2026-06-20' });
    expect(paidRes.status).toBe(200);
    expect(paidRes.body.status).toBe('paid');

    const { data: c2 } = await supabase.from('claims').select('*').eq('id', claimId).single();
    expect(c2.status).toBe('closed');
    expect(c2.status).not.toBe('future_medical_only');

    // Timeline covers every C&R state change
    const tlRes = await request(app)
      .get(`/api/v1/offers/${offerId}/timeline`).set(auth);
    expect(tlRes.status).toBe(200);
    const types = tlRes.body.timeline.map(e => e.type);
    expect(types).toEqual(expect.arrayContaining([
      'cnr_offered', 'cnr_worker_accepted', 'cnr_adjuster_signed',
      'cnr_eams_filed', 'cnr_oacr_received', 'cnr_paid',
    ]));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// MSA-required block
// ═════════════════════════════════════════════════════════════════════════════
describe('MSA-required path blocks C&R', () => {
  it('priceCnr returns 409 when MSA required; stip-only path remains available', async () => {
    const { claimId } = await seed();
    const auth = { Cookie: `token=${adminToken}` };

    // Seed an MSA-required screening directly (simulates a 65+ worker)
    await supabase.from('msa_screenings').insert({
      claim_id: claimId, screened_at: new Date().toISOString(),
      medicare_eligible: true, age_at_screening: 68,
      ssdi_receiving: false, projected_settlement_value: 30000,
      msa_required: true,
      msa_required_reason: 'Medicare eligible (age 68) over $25k threshold',
    });

    const priceRes = await request(app)
      .post(`/api/v1/claims/${claimId}/cnr-price`).set(auth);
    expect(priceRes.status).toBe(409);
    expect(priceRes.body.error).toBe('CNR_BLOCKED_MSA_REQUIRED');

    // Stip-value route still works
    const stipRes = await request(app)
      .post(`/api/v1/claims/${claimId}/stip-value`).set(auth);
    expect(stipRes.status).toBe(200);
    expect(stipRes.body.stipValue).toBe(13920);
  });

  it('priceCnr returns 409 when no MSA screening exists', async () => {
    const { claimId } = await seed();
    const auth = { Cookie: `token=${adminToken}` };

    const priceRes = await request(app)
      .post(`/api/v1/claims/${claimId}/cnr-price`).set(auth);
    expect(priceRes.status).toBe(409);
    expect(priceRes.body.error).toBe('MSA_SCREENING_REQUIRED_BEFORE_CNR_PRICING');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Represented worker / guardrail / withdraw edge cases
// ═════════════════════════════════════════════════════════════════════════════
describe('C&R edge cases', () => {
  async function seededDraftOffer({ represented = false, cnrValue = 22000, stipValue = 13920 } = {}) {
    const { claimId } = await seed({ represented });
    await supabase.from('msa_screenings').insert({
      claim_id: claimId, screened_at: new Date().toISOString(),
      medicare_eligible: false, age_at_screening: 41,
      ssdi_receiving: false, projected_settlement_value: 22000,
      msa_required: false,
    });
    const offerId = `so_${Date.now()}`;
    await supabase.from('settlement_offers').insert({
      id: offerId, claim_id: claimId, offer_type: 'cnr',
      stip_value: stipValue, cnr_value: cnrValue,
      cnr_premium_pct: Math.round((cnrValue / stipValue - 1) * 10000) / 100,
      pricing_method: 'claude_ai', status: 'draft',
      created_at: new Date().toISOString(),
    });
    return { claimId, offerId };
  }

  it('represented + offeredTo=worker returns 409', async () => {
    const { offerId } = await seededDraftOffer({ represented: true });
    const auth = { Cookie: `token=${adminToken}` };
    const res = await request(app)
      .post(`/api/v1/offers/${offerId}/offer`).set(auth)
      .send({ offeredTo: 'worker' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CNR_BLOCKED_REPRESENTED_WORKER_MUST_USE_ATTORNEY');
  });

  it('DONT_OFFER_CNR returns 409 at offer time', async () => {
    // cnr 11k vs stip 10k = 10% premium → DONT_OFFER_CNR
    const { offerId } = await seededDraftOffer({ stipValue: 10000, cnrValue: 11000 });
    const auth = { Cookie: `token=${adminToken}` };
    const res = await request(app)
      .post(`/api/v1/offers/${offerId}/offer`).set(auth)
      .send({ offeredTo: 'worker' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/CNR_BLOCKED_GUARDRAIL_DONT_OFFER_CNR/);
  });

  it('withdraw from offered keeps claim in settlement_discussions', async () => {
    const { claimId, offerId } = await seededDraftOffer();
    const auth = { Cookie: `token=${adminToken}` };

    await request(app)
      .post(`/api/v1/offers/${offerId}/offer`).set(auth)
      .send({ offeredTo: 'worker' }).expect(200);

    const withdrawRes = await request(app)
      .post(`/api/v1/offers/${offerId}/withdraw`).set(auth)
      .send({ reason: 'Adjuster decision' });
    expect(withdrawRes.status).toBe(200);
    expect(withdrawRes.body.status).toBe('withdrawn');

    const { data: claim } = await supabase.from('claims').select('*').eq('id', claimId).single();
    expect(claim.status).toBe('settlement_discussions');
  });

  it('document route returns 409 until DWC-CA 10214(c) is provided', async () => {
    const { offerId } = await seededDraftOffer();
    const auth = { Cookie: `token=${adminToken}` };
    const res = await request(app)
      .get(`/api/v1/offers/${offerId}/document`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('C&R_FORM_TEMPLATE_NOT_PROVIDED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Auth
// ═════════════════════════════════════════════════════════════════════════════
describe('C&R auth', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/v1/offers/any/offer').send({ offeredTo: 'worker' });
    expect(res.status).toBe(401);
  });
});
