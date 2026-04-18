'use strict';

/**
 * Integration tests — C&R OACR disbursement flow (M14.5).
 *
 * Exercises the cnrService + disbursementService handoff:
 *   cnrService.recordPayment  → transitions claim → closed
 *   disbursementService pay   → finalizes bundle, does NOT re-transition
 *
 * Ordering matters: disbursement payment must follow cnrService.recordPayment
 * within CNR_PAYMENT_ORDER_WINDOW_MINUTES.
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
  createDiary:    jest.fn().mockResolvedValue({ diaryId: 'd' }),
  completeDiary:  jest.fn().mockResolvedValue({ status: 'completed' }),
  attachDocument: jest.fn().mockResolvedValue({ documentId: 'doc' }),
  getLedger:      jest.fn().mockResolvedValue({ entries: [] }),
  recordPayment:  jest.fn().mockResolvedValue({ paymentId: 'p' }),
}));

const request   = require('supertest');
const app       = require('../../src/index');
const { generateAdminToken } = require('../../src/middleware/auth');
const { supabase } = require('../../src/services/supabase');
const cnrService   = require('../../src/services/cnrService');

const adminToken = generateAdminToken({ sub: 'admin-001', email: 'admin@homecaretpa.com' });

const CNR_EXTRACTION = {
  awardDate:               '2026-06-10',
  awardServiceDate:        '2026-06-15',
  accruedStartDate:        '2026-06-15', // C&R is lump sum — accrued = full award
  totalAward:              75_000,
  apportionmentPct:        0,
  weeklyRate:              290,           // nominal for math
  aaFeePct:                15,
  aaFeeAmount:             11_250,
  commutationOrdered:      false,
  bodyPartsAwarded:        ['Lumbar Spine'],
  futureMedical:           false,
  rawExtractionConfidence: 90,
  notes:                   '',
};

async function seedClaim(overrides = {}) {
  const id = overrides.id || `claim_cnrflow_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
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

async function seedOfferOACR(claimId, overrides = {}) {
  const id = `offer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from('settlement_offers').insert({
    id,
    claim_id:              claimId,
    offer_type:            'cnr',
    cnr_value:             75_000,
    status:                'oacr_received',
    wcab_oacr_received_at: '2026-06-15',
    payment_due_date:      '2026-07-15',
    eams_filed_at:         '2026-05-15',
    created_at:            new Date().toISOString(),
    updated_at:            new Date().toISOString(),
    ...overrides,
  });
  return id;
}

beforeEach(() => {
  supabase._resetStore();
  mockCallClaudeWithDocument.mockReset();
});

// ═════════════════════════════════════════════════════════════════════════════
// Happy path — cnrService first, then disbursement
// ═════════════════════════════════════════════════════════════════════════════
describe('CNR disbursement — happy path', () => {
  it('cnrService.recordPayment → propose → approve → recordDisbursementPayment; claim stays closed without re-transition', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOfferOACR(claimId);

    // cnrService transitions claim → closed and sets offer.paid_at.
    await cnrService.recordPayment(offerId, { paidDate: '2026-06-20' });

    let { data: claimAfterCnr } = await supabase.from('claims').select('*').eq('id', claimId).single();
    expect(claimAfterCnr.status).toBe('closed');

    // Propose + approve.
    const proposeRes = await request(app)
      .post(`/api/v1/claims/${claimId}/propose-disbursement`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        awardType:         'cnr_oacr',
        settlementOfferId: offerId,
        extraction:        CNR_EXTRACTION,
      });
    expect(proposeRes.status).toBe(201);
    const bundleId = proposeRes.body.id;

    await request(app)
      .post(`/api/v1/disbursements/${bundleId}/approve`)
      .set('Cookie', `token=${adminToken}`)
      .send({ notes: 'LGTM' });

    // Record disbursement payment — this just finalizes the bundle.
    const payRes = await request(app)
      .patch(`/api/v1/disbursements/${bundleId}/paid`)
      .set('Cookie', `token=${adminToken}`)
      .send({ paidDate: '2026-06-20', reference: 'CHK-CNR' });
    expect(payRes.status).toBe(200);
    expect(payRes.body.status).toBe('disbursed');

    // Claim is still closed — no re-transition event.
    const { data: claimAfter } = await supabase.from('claims').select('*').eq('id', claimId).single();
    expect(claimAfter.status).toBe('closed');
  });

  it('disbursement bundle links to settlement_offer_id (not stipulation_id)', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOfferOACR(claimId);
    await cnrService.recordPayment(offerId, { paidDate: '2026-06-20' });

    const res = await request(app)
      .post(`/api/v1/claims/${claimId}/propose-disbursement`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        awardType:         'cnr_oacr',
        settlementOfferId: offerId,
        extraction:        CNR_EXTRACTION,
      });
    expect(res.body.settlement_offer_id).toBe(offerId);
    expect(res.body.stipulation_id).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Ordering violation
// ═════════════════════════════════════════════════════════════════════════════
describe('CNR disbursement — ordering enforcement', () => {
  it('throws CNR_PAYMENT_ORDER_VIOLATION when offer not yet paid', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOfferOACR(claimId, { status: 'oacr_received' }); // NOT paid

    const proposeRes = await request(app)
      .post(`/api/v1/claims/${claimId}/propose-disbursement`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        awardType:         'cnr_oacr',
        settlementOfferId: offerId,
        extraction:        CNR_EXTRACTION,
      });
    expect(proposeRes.status).toBe(201);
    const bundleId = proposeRes.body.id;
    await request(app)
      .post(`/api/v1/disbursements/${bundleId}/approve`)
      .set('Cookie', `token=${adminToken}`);

    const res = await request(app)
      .patch(`/api/v1/disbursements/${bundleId}/paid`)
      .set('Cookie', `token=${adminToken}`)
      .send({ paidDate: '2026-06-20' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CNR_PAYMENT_ORDER_VIOLATION');
  });

  it('throws CNR_PAYMENT_ORDER_VIOLATION when offer.updated_at is stale (>5 min)', async () => {
    const claimId = await seedClaim();
    // Simulate an old paid-but-stale offer by seeding an updated_at > 5 min ago.
    const staleTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const offerId = await seedOfferOACR(claimId, {
      status:     'paid',
      paid_at:    '2026-05-01',
      updated_at: staleTs,
    });

    const proposeRes = await request(app)
      .post(`/api/v1/claims/${claimId}/propose-disbursement`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        awardType:         'cnr_oacr',
        settlementOfferId: offerId,
        extraction:        CNR_EXTRACTION,
      });
    const bundleId = proposeRes.body.id;
    await request(app)
      .post(`/api/v1/disbursements/${bundleId}/approve`)
      .set('Cookie', `token=${adminToken}`);

    const res = await request(app)
      .patch(`/api/v1/disbursements/${bundleId}/paid`)
      .set('Cookie', `token=${adminToken}`)
      .send({ paidDate: '2026-05-01' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CNR_PAYMENT_ORDER_VIOLATION');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// XOR link + validation
// ═════════════════════════════════════════════════════════════════════════════
describe('CNR disbursement — XOR validation', () => {
  it('rejects when both stipulationId and settlementOfferId provided', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOfferOACR(claimId);
    // Seed a stub stip row to populate stipulation_id.
    await supabase.from('stipulations').insert({
      id: 'stip_x', claim_id: claimId, pd_percent: 24, pd_total_value: 60000,
      status: 'filed', created_at: new Date().toISOString(),
    });

    const res = await request(app)
      .post(`/api/v1/claims/${claimId}/propose-disbursement`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        awardType:         'cnr_oacr',
        stipulationId:     'stip_x',
        settlementOfferId: offerId,
        extraction:        CNR_EXTRACTION,
      });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('XOR');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Flags on C&R
// ═════════════════════════════════════════════════════════════════════════════
describe('CNR disbursement — flags', () => {
  it('LIEN_PRESENT_ADJUSTER_REVIEW flagged on every C&R proposal', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOfferOACR(claimId);
    const res = await request(app)
      .post(`/api/v1/claims/${claimId}/propose-disbursement`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        awardType:         'cnr_oacr',
        settlementOfferId: offerId,
        extraction:        CNR_EXTRACTION,
      });
    expect(res.body.flags).toContain('LIEN_PRESENT_ADJUSTER_REVIEW');
  });

  it('AA_FEE_UNUSUAL flagged at 20%', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOfferOACR(claimId);
    const res = await request(app)
      .post(`/api/v1/claims/${claimId}/propose-disbursement`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        awardType:         'cnr_oacr',
        settlementOfferId: offerId,
        extraction:        { ...CNR_EXTRACTION, aaFeePct: 20, aaFeeAmount: null },
      });
    expect(res.body.flags).toContain('AA_FEE_UNUSUAL');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Late payment on C&R
// ═════════════════════════════════════════════════════════════════════════════
describe('CNR disbursement — late payment interest', () => {
  it('late C&R disbursement also writes deferred_penalty_flags', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOfferOACR(claimId);
    await cnrService.recordPayment(offerId, { paidDate: '2026-07-20' });
    // cnrService.recordPayment just set updated_at to now, so the 5-min window
    // is satisfied for the immediately-following disbursement recordPayment.

    const proposeRes = await request(app)
      .post(`/api/v1/claims/${claimId}/propose-disbursement`)
      .set('Cookie', `token=${adminToken}`)
      .send({
        awardType:         'cnr_oacr',
        settlementOfferId: offerId,
        extraction:        CNR_EXTRACTION,
      });
    const bundleId = proposeRes.body.id;
    await request(app)
      .post(`/api/v1/disbursements/${bundleId}/approve`)
      .set('Cookie', `token=${adminToken}`);

    const payRes = await request(app)
      .patch(`/api/v1/disbursements/${bundleId}/paid`)
      .set('Cookie', `token=${adminToken}`)
      .send({ paidDate: '2026-09-01', reference: 'LATE' });
    // pay-by = 2026-06-15 + 30 days = 2026-07-15; 2026-09-01 is past.
    expect(payRes.body.flags).toContain('INTEREST_OWED_LATE_PAYMENT');

    const { data: flags } = await supabase.from('deferred_penalty_flags').select('*').eq('claim_id', claimId);
    expect(flags).toHaveLength(1);
  });
});
