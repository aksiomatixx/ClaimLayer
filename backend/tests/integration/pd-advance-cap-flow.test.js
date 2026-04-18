'use strict';

/**
 * Integration tests — PD advance cap end-to-end (M14.5).
 *
 * Exercises /api/v1/pd-advances/:id/record-payment and override-cap through
 * the Express app with mocked Supabase + external services.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));
jest.mock('../../src/services/aiService');
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

async function seedClaim(overrides = {}) {
  const id = overrides.id || `claim_capflow_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
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

async function seedPdEvalAndAdvance(claimId, evalOverrides = {}) {
  const pdEvalId = `pe_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from('pd_evaluations').insert({
    id: pdEvalId, claim_id: claimId, wpi: 15, pd_percent: 24,
    pd_weeks: 72, pd_weekly_rate: 290,
    pd_total_value: 20_880,
    apportionment_percent: 0,
    adjusted_pd_percent: 24,
    adjusted_total_value: 20_880,
    calculated_at: new Date().toISOString(),
    ...evalOverrides,
  });
  const initRes = await request(app)
    .post(`/api/v1/pd/advances/${claimId}`)
    .set('Cookie', `token=${adminToken}`)
    .send({ pdEvaluationId: pdEvalId, tdEndDate: '2026-01-01' });
  return { pdEvalId, advanceId: initRes.body.id };
}

beforeEach(() => {
  supabase._resetStore();
});

describe('Cap flow via routes — unrepresented (100%)', () => {
  it('multi-week payments within cap succeed', async () => {
    const claimId = await seedClaim();
    const { advanceId } = await seedPdEvalAndAdvance(claimId, { adjusted_total_value: 1_160 });

    for (let i = 0; i < 4; i++) {
      const res = await request(app)
        .post(`/api/v1/pd-advances/${advanceId}/record-payment`)
        .set('Cookie', `token=${adminToken}`)
        .send({
          weekStartDate: `2026-01-${(1 + i * 7).toString().padStart(2, '0')}`,
          weekEndDate:   `2026-01-${(7 + i * 7).toString().padStart(2, '0')}`,
          amountPaid:    290,
        });
      expect(res.status).toBe(200);
    }
    const { data: payments } = await supabase.from('pd_advance_payments').select('*').eq('pd_advance_id', advanceId);
    expect(payments).toHaveLength(4);
  });

  it('payment at exactly cap transitions advance to completed', async () => {
    const claimId = await seedClaim();
    const { advanceId } = await seedPdEvalAndAdvance(claimId, { adjusted_total_value: 1_000 });

    await request(app)
      .post(`/api/v1/pd-advances/${advanceId}/record-payment`)
      .set('Cookie', `token=${adminToken}`)
      .send({ weekStartDate: '2026-01-01', weekEndDate: '2026-01-07', amountPaid: 1_000 });

    const { data: adv } = await supabase.from('pd_advances').select('*').eq('id', advanceId).single();
    expect(adv.status).toBe('completed');
  });

  it('payment overflowing cap returns 409 ADVANCE_CAP_EXCEEDED', async () => {
    const claimId = await seedClaim();
    const { advanceId } = await seedPdEvalAndAdvance(claimId, { adjusted_total_value: 1_000 });

    await request(app)
      .post(`/api/v1/pd-advances/${advanceId}/record-payment`)
      .set('Cookie', `token=${adminToken}`)
      .send({ weekStartDate: '2026-01-01', weekEndDate: '2026-01-07', amountPaid: 600 });

    const overRes = await request(app)
      .post(`/api/v1/pd-advances/${advanceId}/record-payment`)
      .set('Cookie', `token=${adminToken}`)
      .send({ weekStartDate: '2026-01-08', weekEndDate: '2026-01-14', amountPaid: 500 });
    expect(overRes.status).toBe(409);
    expect(overRes.body.error).toBe('ADVANCE_CAP_EXCEEDED');
  });
});

describe('Cap flow via routes — represented (85%)', () => {
  it('cap is tighter than unrepresented for the same denominator', async () => {
    const claimId = await seedClaim({ attorney_represented: true });
    const { advanceId } = await seedPdEvalAndAdvance(claimId, { adjusted_total_value: 1_000 });

    // $851 overflows (851 > 85% × 1000 + 0.01)
    await request(app)
      .post(`/api/v1/pd-advances/${advanceId}/record-payment`)
      .set('Cookie', `token=${adminToken}`)
      .send({ weekStartDate: '2026-01-01', weekEndDate: '2026-01-07', amountPaid: 400 });

    const overRes = await request(app)
      .post(`/api/v1/pd-advances/${advanceId}/record-payment`)
      .set('Cookie', `token=${adminToken}`)
      .send({ weekStartDate: '2026-01-08', weekEndDate: '2026-01-14', amountPaid: 451 });
    expect(overRes.status).toBe(409);
  });

  it('cap tightens mid-stream when attorney is added after first payment', async () => {
    const claimId = await seedClaim();
    const { advanceId } = await seedPdEvalAndAdvance(claimId, { adjusted_total_value: 1_000 });

    // First payment at unrepresented (100% cap) — $900 OK.
    const first = await request(app)
      .post(`/api/v1/pd-advances/${advanceId}/record-payment`)
      .set('Cookie', `token=${adminToken}`)
      .send({ weekStartDate: '2026-01-01', weekEndDate: '2026-01-07', amountPaid: 900 });
    expect(first.status).toBe(200);

    // Worker retains attorney now.
    await supabase.from('claims').update({ attorney_represented: true }).eq('id', claimId);

    // Second payment should now violate 85% cap (900 + any > 850.01).
    const second = await request(app)
      .post(`/api/v1/pd-advances/${advanceId}/record-payment`)
      .set('Cookie', `token=${adminToken}`)
      .send({ weekStartDate: '2026-01-08', weekEndDate: '2026-01-14', amountPaid: 50 });
    expect(second.status).toBe(409);
  });
});

describe('Cap flow via routes — override', () => {
  it('override approves → subsequent payment beyond default cap succeeds', async () => {
    const claimId = await seedClaim({ attorney_represented: true });
    const { advanceId } = await seedPdEvalAndAdvance(claimId, { adjusted_total_value: 1_000 });

    // Baseline payment.
    await request(app)
      .post(`/api/v1/pd-advances/${advanceId}/record-payment`)
      .set('Cookie', `token=${adminToken}`)
      .send({ weekStartDate: '2026-01-01', weekEndDate: '2026-01-07', amountPaid: 800 });

    // Override to 0.95 → now $950 allowed total.
    const ovRes = await request(app)
      .post(`/api/v1/pd-advances/${advanceId}/override-cap`)
      .set('Cookie', `token=${adminToken}`)
      .send({ overridePct: 0.95, reason: 'Supervisor approved' });
    expect(ovRes.status).toBe(200);

    const payRes = await request(app)
      .post(`/api/v1/pd-advances/${advanceId}/record-payment`)
      .set('Cookie', `token=${adminToken}`)
      .send({ weekStartDate: '2026-01-08', weekEndDate: '2026-01-14', amountPaid: 150 });
    expect(payRes.status).toBe(200);
  });

  it('override requires a reason — 400', async () => {
    const claimId = await seedClaim();
    const { advanceId } = await seedPdEvalAndAdvance(claimId);
    const res = await request(app)
      .post(`/api/v1/pd-advances/${advanceId}/override-cap`)
      .set('Cookie', `token=${adminToken}`)
      .send({ overridePct: 0.95 });
    expect(res.status).toBe(400);
  });

  it('override rejects overridePct > 1 — 400', async () => {
    const claimId = await seedClaim();
    const { advanceId } = await seedPdEvalAndAdvance(claimId);
    const res = await request(app)
      .post(`/api/v1/pd-advances/${advanceId}/override-cap`)
      .set('Cookie', `token=${adminToken}`)
      .send({ overridePct: 1.5, reason: 'bogus' });
    expect(res.status).toBe(400);
  });
});

describe('Cap flow via routes — denominator source', () => {
  it('adjusted_total_value is the denominator (apportionment-baked)', async () => {
    const claimId = await seedClaim();
    // 25% apportionment: adjusted < pd_total
    const { advanceId } = await seedPdEvalAndAdvance(claimId, {
      pd_total_value:       20_000,
      apportionment_percent: 25,
      adjusted_total_value: 15_000,
    });
    const { data: adv } = await supabase.from('pd_advances').select('*').eq('id', advanceId).single();
    expect(parseFloat(adv.estimated_pd_denominator)).toBe(15_000);
    expect(adv.denominator_source).toBe('pr_4');
  });

  it('pre-QME fallback when adjusted_total_value missing', async () => {
    const claimId = await seedClaim();
    const { advanceId } = await seedPdEvalAndAdvance(claimId, {
      pd_total_value:       20_000,
      adjusted_total_value: null,
    });
    const { data: adv } = await supabase.from('pd_advances').select('*').eq('id', advanceId).single();
    expect(parseFloat(adv.estimated_pd_denominator)).toBe(20_000);
    expect(adv.denominator_source).toBe('pre_qme');
    expect(adv.notes).toContain('PRE_QME_DENOMINATOR');
  });
});

describe('Cap flow via routes — auth', () => {
  it('rejects unauthenticated record-payment', async () => {
    const res = await request(app)
      .post('/api/v1/pd-advances/any/record-payment')
      .send({ weekStartDate: '2026-01-01', weekEndDate: '2026-01-07', amountPaid: 100 });
    expect(res.status).toBe(401);
  });
});
