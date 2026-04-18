'use strict';

/**
 * Integration tests — M13 Stipulation + PD Closure + PD Advances.
 *
 * Run:
 *   npm test -- tests/integration/pd.test.js
 */

// ── Mock Supabase (must be first) ────────────────────────────────────────────
jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const request      = require('supertest');
const app          = require('../../src/index');
const { generateAdminToken } = require('../../src/middleware/auth');
const { supabase } = require('../../src/services/supabase');

// ── Mock external services ────────────────────────────────────────────────────
jest.mock('../../src/services/aiService');
jest.mock('../../src/services/filehandler', () => ({
  setReserves:    jest.fn().mockResolvedValue({ status: 'ok' }),
  createClaim:    jest.fn().mockResolvedValue({ claimId: 'fh_mock', status: 'created' }),
  createDiary:    jest.fn().mockResolvedValue({ diaryId: 'diy_mock', status: 'created' }),
  completeDiary:  jest.fn().mockResolvedValue({ status: 'completed' }),
  attachDocument: jest.fn().mockResolvedValue({ documentId: 'doc_mock' }),
  getLedger:      jest.fn().mockResolvedValue({ entries: [] }),
  recordPayment:  jest.fn().mockResolvedValue({ paymentId: 'pay_mock' }),
}));

jest.mock('../../src/services/adp', () => ({
  getEmployeeWithFinancials: jest.fn().mockResolvedValue({
    associateOID: 'BC-001', firstName: 'Maria', lastName: 'Santos',
    dob: '1985-03-12', phone: '(213) 555-1001',
    address: { line1: '1234 Main St', state: 'CA', zip: '90001' },
    jobTitle: 'Home Health Aide II', hireDate: '2019-06-01',
    aww: 750.75, tdRate: 500.50, weeksCalculated: 52,
  }),
}));

const mockSendLetter = jest.fn().mockResolvedValue({ letterId: 'ltr_mock', status: 'queued', estimatedDelivery: '2026-06-01' });
jest.mock('../../src/services/lobService', () => ({
  sendLetter:      (...args) => mockSendLetter(...args),
  getLetterStatus: jest.fn().mockResolvedValue({ letterId: 'ltr_mock', status: 'in_transit' }),
}));

// ── Token ─────────────────────────────────────────────────────────────────────
const adminToken = generateAdminToken({ sub: 'admin-001', email: 'admin@homecaretpa.com' });

// ── Helpers ───────────────────────────────────────────────────────────────────
async function seedClaim(overrides = {}) {
  const id = overrides.id || `claim_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const claim = {
    id,
    claim_number:  'HHW-2026-PD',
    employer_id:   'employer-brightcare-001',
    employer_name: 'BrightCare Home Health',
    status:        'p_and_s',
    employee:      { firstName: 'Maria', lastName: 'Santos', dob: '1985-03-12' },
    aww:           750.75,
    td_rate:       500.50,
    date_of_injury: '2025-06-15',
    body_part:     'Lumbar Spine',
    injury_type:   'Lifting Injury',
    filed_at:      new Date().toISOString(),
    created_at:    new Date().toISOString(),
    updated_at:    new Date().toISOString(),
    ...overrides,
  };
  await supabase.from('claims').insert(claim);
  return claim;
}

async function seedPR4(claimId, overrides = {}) {
  const pr4 = {
    id: overrides.id || `pr4_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    claim_id: claimId,
    solicitation_date: '2026-03-01',
    response_due_date: '2026-03-31',
    physician_name: 'Dr. Smith',
    response_received_at: new Date().toISOString(),
    wpi: overrides.wpi ?? 10,
    work_restrictions: 'Light duty',
    future_medical: 'PT 2x/wk',
    apportionment_noted: overrides.apportionment_noted ?? false,
    status: 'received',
    created_at: new Date().toISOString(),
    ...overrides,
  };
  await supabase.from('pr4_solicitations').insert(pr4);
  return pr4;
}

async function seedPDRS() {
  const rows = [
    { wpi_percent: 5, age_factor: 1.0, occupation_group: 1, pd_percent: 8, weekly_pd_weeks: 24 },
    { wpi_percent: 10, age_factor: 1.0, occupation_group: 1, pd_percent: 16, weekly_pd_weeks: 48 },
    { wpi_percent: 15, age_factor: 1.0, occupation_group: 1, pd_percent: 24, weekly_pd_weeks: 72.75 },
    { wpi_percent: 25, age_factor: 1.0, occupation_group: 1, pd_percent: 40, weekly_pd_weeks: 137.5 },
    { wpi_percent: 50, age_factor: 1.0, occupation_group: 1, pd_percent: 70, weekly_pd_weeks: 344.75 },
  ];
  for (const r of rows) await supabase.from('pdrs_lookup').insert(r);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
beforeEach(async () => {
  supabase._resetStore();
  mockSendLetter.mockClear();
  await seedPDRS();
});

// ═════════════════════════════════════════════════════════════════════════════
// calculatePD
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/pd/calculate/:claimId — calculatePD', () => {
  it('writes pd_evaluations row and creates diary', async () => {
    const claim = await seedClaim();
    const pr4   = await seedPR4(claim.id, { wpi: 10 });

    const res = await request(app)
      .post(`/api/v1/pd/calculate/${claim.id}`)
      .set('Cookie', `token=${adminToken}`)
      .send({ pr4Id: pr4.id, apportionmentPercent: 0 });

    expect(res.status).toBe(201);
    expect(parseFloat(res.body.wpi)).toBe(10);
    expect(parseFloat(res.body.pd_percent)).toBe(16);
    expect(parseFloat(res.body.pd_weeks)).toBe(48);
    expect(res.body.pd_weekly_rate).toBeDefined();
    expect(res.body.pd_total_value).toBeDefined();

    // Diary created
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claim.id);
    const pdDiary = diaries.find(d => d.diary_type === 'PD_CALCULATED');
    expect(pdDiary).toBeDefined();
    expect(pdDiary.notes).toContain('16%');
  });

  it('correctly applies apportionment (25% on 16% PD → 12% adjusted)', async () => {
    const claim = await seedClaim();
    const pr4   = await seedPR4(claim.id, { wpi: 10 });

    const res = await request(app)
      .post(`/api/v1/pd/calculate/${claim.id}`)
      .set('Cookie', `token=${adminToken}`)
      .send({ pr4Id: pr4.id, apportionmentPercent: 25 });

    expect(res.status).toBe(201);
    expect(parseFloat(res.body.apportionment_percent)).toBe(25);
    expect(parseFloat(res.body.adjusted_pd_percent)).toBe(12); // 16 * 0.75 = 12
    expect(parseFloat(res.body.adjusted_total_value)).toBeLessThan(parseFloat(res.body.pd_total_value));
  });

  it('updates claim status to pd_evaluation', async () => {
    const claim = await seedClaim();
    const pr4   = await seedPR4(claim.id, { wpi: 10 });

    await request(app)
      .post(`/api/v1/pd/calculate/${claim.id}`)
      .set('Cookie', `token=${adminToken}`)
      .send({ pr4Id: pr4.id, apportionmentPercent: 0 });

    const { data: updated } = await supabase.from('claims').select('*').eq('id', claim.id).single();
    expect(updated.status).toBe('pd_evaluation');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// initiatePDAdvances
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/pd/advances/:claimId — initiatePDAdvances', () => {
  let claim, pdEvalId;

  beforeEach(async () => {
    claim = await seedClaim();
    const pr4 = await seedPR4(claim.id, { wpi: 10 });
    const calcRes = await request(app)
      .post(`/api/v1/pd/calculate/${claim.id}`)
      .set('Cookie', `token=${adminToken}`)
      .send({ pr4Id: pr4.id, apportionmentPercent: 0 });
    pdEvalId = calcRes.body.id;
  });

  it('sets advance_due_date = tdEndDate + 14 calendar days', async () => {
    const res = await request(app)
      .post(`/api/v1/pd/advances/${claim.id}`)
      .set('Cookie', `token=${adminToken}`)
      .send({ pdEvaluationId: pdEvalId, tdEndDate: '2026-05-01' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    // May 1 + 14 = May 15
    expect(res.body.advance_due_date).toBe('2026-05-15');
  });

  it('creates CRITICAL no-snooze diary', async () => {
    await request(app)
      .post(`/api/v1/pd/advances/${claim.id}`)
      .set('Cookie', `token=${adminToken}`)
      .send({ pdEvaluationId: pdEvalId, tdEndDate: '2026-05-01' });

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claim.id);
    const advDiary = diaries.find(d => d.diary_type === 'PD_ADVANCE_DUE');
    expect(advDiary).toBeDefined();
    expect(advDiary.priority).toBe('CRITICAL');
    expect(advDiary.no_snooze).toBe(true);
    expect(advDiary.notes).toContain('10% penalty');
    expect(advDiary.notes).toContain('LC §4650(b)');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// waivePDAdvance
// ═════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/v1/pd/advances/:id/waive — waivePDAdvance', () => {
  it('sets status = waived and writes audit log', async () => {
    const claim = await seedClaim();
    const pr4 = await seedPR4(claim.id, { wpi: 10 });
    const calcRes = await request(app)
      .post(`/api/v1/pd/calculate/${claim.id}`)
      .set('Cookie', `token=${adminToken}`)
      .send({ pr4Id: pr4.id, apportionmentPercent: 0 });

    const advRes = await request(app)
      .post(`/api/v1/pd/advances/${claim.id}`)
      .set('Cookie', `token=${adminToken}`)
      .send({ pdEvaluationId: calcRes.body.id, tdEndDate: '2026-05-01' });

    const res = await request(app)
      .patch(`/api/v1/pd/advances/${advRes.body.id}/waive`)
      .set('Cookie', `token=${adminToken}`)
      .send({ reason: 'No PD anticipated — denied claim' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('waived');

    // Audit log written
    const { data: logs } = await supabase.from('audit_log').select('*');
    const waiveLog = (logs || []).find(l => l.action === 'pd_advance_waived');
    expect(waiveLog).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// recordEAMSFiled
// ═════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/v1/pd/stip/:stipId/eams-filed — recordEAMSFiled', () => {
  async function setupStipToEamsReady(claimOverrides = {}, stipOpts = {}) {
    const claim = await seedClaim(claimOverrides);
    const pr4 = await seedPR4(claim.id, { wpi: 10 });
    const calcRes = await request(app)
      .post(`/api/v1/pd/calculate/${claim.id}`)
      .set('Cookie', `token=${adminToken}`)
      .send({ pr4Id: pr4.id, apportionmentPercent: 0 });

    const stipRes = await request(app)
      .post(`/api/v1/pd/stip/${claim.id}`)
      .set('Cookie', `token=${adminToken}`)
      .send({ pdEvaluationId: calcRes.body.id, futureMedical: stipOpts.futureMedical || false });

    // Advance through stip lifecycle: send → worker sign → adjuster sign
    await request(app)
      .patch(`/api/v1/pd/stip/${stipRes.body.id}/send`)
      .set('Cookie', `token=${adminToken}`);
    await request(app)
      .patch(`/api/v1/pd/stip/${stipRes.body.id}/worker-signature`)
      .set('Cookie', `token=${adminToken}`);
    await request(app)
      .patch(`/api/v1/pd/stip/${stipRes.body.id}/adjuster-signature`)
      .set('Cookie', `token=${adminToken}`);

    return { claim, stipId: stipRes.body.id };
  }

  // M14.5: recordEAMSFiled NO LONGER transitions claim status. The
  // transition happens at disbursementService.recordDisbursementPayment
  // after the WCAB serves the award and the disbursement bundle is paid.
  it('with future_medical = false → claim status UNCHANGED (M14.5)', async () => {
    const { claim, stipId } = await setupStipToEamsReady({}, { futureMedical: false });
    const { data: preClaim } = await supabase.from('claims').select('*').eq('id', claim.id).single();
    const priorStatus = preClaim.status;

    const res = await request(app)
      .patch(`/api/v1/pd/stip/${stipId}/eams-filed`)
      .set('Cookie', `token=${adminToken}`)
      .send({ filedDate: '2026-06-15' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('filed');
    expect(res.body.eams_filed_at).toBe('2026-06-15');

    const { data: updated } = await supabase.from('claims').select('*').eq('id', claim.id).single();
    expect(updated.status).toBe(priorStatus);
  });

  it('with future_medical = true → claim status UNCHANGED (M14.5)', async () => {
    const { claim, stipId } = await setupStipToEamsReady({}, { futureMedical: true });
    const { data: preClaim } = await supabase.from('claims').select('*').eq('id', claim.id).single();
    const priorStatus = preClaim.status;

    const res = await request(app)
      .patch(`/api/v1/pd/stip/${stipId}/eams-filed`)
      .set('Cookie', `token=${adminToken}`)
      .send({ filedDate: '2026-06-15' });

    expect(res.status).toBe(200);

    const { data: updated } = await supabase.from('claims').select('*').eq('id', claim.id).single();
    expect(updated.status).toBe(priorStatus);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Represented worker stip
// ═════════════════════════════════════════════════════════════════════════════
describe('Represented worker stip', () => {
  it('sends to attorney action item, not directly to worker', async () => {
    const claim = await seedClaim({ attorneyName: 'Jane Doe, Esq.' });
    const pr4 = await seedPR4(claim.id, { wpi: 10 });
    const calcRes = await request(app)
      .post(`/api/v1/pd/calculate/${claim.id}`)
      .set('Cookie', `token=${adminToken}`)
      .send({ pr4Id: pr4.id, apportionmentPercent: 0 });

    const stipRes = await request(app)
      .post(`/api/v1/pd/stip/${claim.id}`)
      .set('Cookie', `token=${adminToken}`)
      .send({ pdEvaluationId: calcRes.body.id });

    await request(app)
      .patch(`/api/v1/pd/stip/${stipRes.body.id}/send`)
      .set('Cookie', `token=${adminToken}`);

    // lobService should NOT have been called for represented worker
    const stipCalls = mockSendLetter.mock.calls.filter(c => c[0] === 'stipulation');
    expect(stipCalls.length).toBe(0);

    // Attorney action diary created instead
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claim.id);
    const attDiary = diaries.find(d => d.diary_type === 'STIP_ATTORNEY_TRANSMIT');
    expect(attDiary).toBeDefined();
    expect(attDiary.notes).toContain('do NOT contact worker directly');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LC §5405 in stip document
// ═════════════════════════════════════════════════════════════════════════════
describe('Stip document compliance', () => {
  it('LC §5405 deadline appears in notices table row', async () => {
    const claim = await seedClaim({ date_of_injury: '2025-06-15' });
    const pr4 = await seedPR4(claim.id, { wpi: 10 });
    const calcRes = await request(app)
      .post(`/api/v1/pd/calculate/${claim.id}`)
      .set('Cookie', `token=${adminToken}`)
      .send({ pr4Id: pr4.id, apportionmentPercent: 0 });

    await request(app)
      .post(`/api/v1/pd/stip/${claim.id}`)
      .set('Cookie', `token=${adminToken}`)
      .send({ pdEvaluationId: calcRes.body.id });

    // DOI 2025-06-15 + 5 years = 2030-06-15
    const { data: notices } = await supabase.from('notices').select('*').eq('claim_id', claim.id);
    const stipNotice = notices.find(n => n.notice_type === 'stipulation');
    expect(stipNotice).toBeDefined();
    expect(stipNotice.statutory_deadline).toContain('2030');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Auth
// ═════════════════════════════════════════════════════════════════════════════
describe('Authentication', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/v1/pd/calculate/some-claim');
    expect(res.status).toBe(401);
  });

  it('returns 403 for employer role', async () => {
    const { generateEmployerToken } = require('../../src/middleware/auth');
    const empToken = generateEmployerToken({ sub: 'e1', employerId: 'emp1', employerName: 'Test' });
    const res = await request(app)
      .post('/api/v1/pd/calculate/some-claim')
      .set('Cookie', `token=${empToken}`)
      .send({ pr4Id: 'x' });
    expect(res.status).toBe(403);
  });
});
