'use strict';

/**
 * Integration tests — M12 MMI Management + PR-4 Solicitation.
 *
 * Covers:
 *   - evaluateMMISignals writes mmi_evaluations row
 *   - recommendation = solicit_pr4 creates diary
 *   - recommendation = monitor creates diary
 *   - recommendation = no_action creates no diary
 *   - solicitPR4 sets response_due_date = solicitation + 30 calendar days
 *   - solicitPR4 calls lobService.sendLetter
 *   - recordPR4Response with apportionment_noted=true creates two diaries
 *   - recordPR4Response with apportionment_noted=false creates one diary
 *   - dismissMMIEvaluation sets adjuster_action = dismissed
 *
 * Run:
 *   npm test -- tests/integration/mmi.test.js
 */

// ── Mock Supabase (must be first) ────────────────────────────────────────────
jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const request      = require('supertest');
const app          = require('../../src/index');
const { generateAdminToken } = require('../../src/middleware/auth');
const { supabase } = require('../../src/services/supabase');

// ── Mock external services ────────────────────────────────────────────────────
const mockCallClaude = jest.fn();
jest.mock('../../src/services/aiService', () => ({
  analyzeCompensability: jest.fn(),
  evaluateRFA:           jest.fn(),
  _callClaude:           (...args) => mockCallClaude(...args),
}));

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

const mockSendLetter = jest.fn().mockResolvedValue({ letterId: 'ltr_mock', status: 'queued', estimatedDelivery: '2026-05-20' });
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
    claim_number:  'HHW-2026-MMI',
    employer_id:   'employer-brightcare-001',
    employer_name: 'BrightCare Home Health',
    status:        'active_medical',
    employee:      { firstName: 'Maria', lastName: 'Santos' },
    date_of_injury: '2025-08-15',
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

// ── Cleanup ──────────────────────────────────────────────────────────────────
beforeEach(() => {
  supabase._resetStore();
  mockCallClaude.mockReset();
  mockSendLetter.mockClear();
});

// ═════════════════════════════════════════════════════════════════════════════
// evaluateMMISignals
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/mmi/evaluate/:claimId — evaluateMMISignals', () => {
  it('writes mmi_evaluations row with signals', async () => {
    const claim = await seedClaim();
    mockCallClaude.mockResolvedValue({
      signals: [
        { type: 'td_over_90_days_soft_tissue', description: 'TD > 90 days on soft tissue', weight: 2 },
        { type: 'no_active_treatment', description: 'No RFAs in 60 days', weight: 2 },
      ],
      recommendation: 'solicit_pr4',
      rationale: 'Strong indicators of P&S approach.',
    });

    const res = await request(app)
      .post(`/api/v1/mmi/evaluate/${claim.id}`)
      .set('Cookie', `token=${adminToken}`);

    expect(res.status).toBe(201);
    expect(res.body.signal_count).toBe(2);
    expect(res.body.recommendation).toBe('solicit_pr4');
    expect(res.body.signals).toHaveLength(2);
  });

  it('recommendation = solicit_pr4 creates diary', async () => {
    const claim = await seedClaim();
    mockCallClaude.mockResolvedValue({
      signals: [{ type: 'td_104_week_approaching', description: 'Near 104 wk cap', weight: 2 }],
      recommendation: 'solicit_pr4',
      rationale: 'Near statutory cap.',
    });

    await request(app)
      .post(`/api/v1/mmi/evaluate/${claim.id}`)
      .set('Cookie', `token=${adminToken}`);

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claim.id);
    const mmiDiary = diaries.find(d => d.diary_type === 'MMI_PR4_REVIEW');
    expect(mmiDiary).toBeDefined();
    expect(mmiDiary.priority).toBe('HIGH');
    expect(mmiDiary.notes).toContain('consider PR-4 solicitation');
  });

  it('recommendation = monitor creates diary', async () => {
    const claim = await seedClaim();
    mockCallClaude.mockResolvedValue({
      signals: [{ type: 'claim_age_exceeds_typical', description: 'Claim age above average', weight: 1 }],
      recommendation: 'monitor',
      rationale: 'Mild signal, continue monitoring.',
    });

    await request(app)
      .post(`/api/v1/mmi/evaluate/${claim.id}`)
      .set('Cookie', `token=${adminToken}`);

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claim.id);
    const monitorDiary = diaries.find(d => d.diary_type === 'MMI_MONITOR');
    expect(monitorDiary).toBeDefined();
    expect(monitorDiary.priority).toBe('MEDIUM');
    expect(monitorDiary.notes).toContain('Re-evaluate in 30 days');
  });

  it('recommendation = no_action creates no diary', async () => {
    const claim = await seedClaim();
    mockCallClaude.mockResolvedValue({
      signals: [],
      recommendation: 'no_action',
      rationale: 'No MMI signals detected.',
    });

    await request(app)
      .post(`/api/v1/mmi/evaluate/${claim.id}`)
      .set('Cookie', `token=${adminToken}`);

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claim.id);
    const mmiDiaries = diaries.filter(d => d.diary_type.startsWith('MMI_'));
    expect(mmiDiaries.length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// solicitPR4
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/mmi/:evalId/solicit-pr4 — solicitPR4', () => {
  let claim, evalId;

  beforeEach(async () => {
    claim = await seedClaim();
    mockCallClaude.mockResolvedValue({
      signals: [{ type: 'no_active_treatment', description: 'No RFAs', weight: 2 }],
      recommendation: 'solicit_pr4',
      rationale: 'Should solicit PR-4.',
    });

    const evalRes = await request(app)
      .post(`/api/v1/mmi/evaluate/${claim.id}`)
      .set('Cookie', `token=${adminToken}`);
    evalId = evalRes.body.id;
  });

  it('sets response_due_date = solicitation + 30 calendar days', async () => {
    const res = await request(app)
      .post(`/api/v1/mmi/${evalId}/solicit-pr4`)
      .set('Cookie', `token=${adminToken}`)
      .send({ claimId: claim.id, physicianName: 'Dr. Smith', physicianFax: '555-0100' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('sent');
    expect(res.body.physician_name).toBe('Dr. Smith');

    // Verify 30 calendar days
    const sent = new Date(res.body.solicitation_date + 'T00:00:00');
    const due  = new Date(res.body.response_due_date + 'T00:00:00');
    const diffDays = Math.round((due - sent) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(30);
  });

  it('calls lobService.sendLetter', async () => {
    await request(app)
      .post(`/api/v1/mmi/${evalId}/solicit-pr4`)
      .set('Cookie', `token=${adminToken}`)
      .send({ claimId: claim.id, physicianName: 'Dr. Jones' });

    expect(mockSendLetter).toHaveBeenCalledWith(
      'pr4_solicitation',
      claim.id,
      'provider',
      expect.objectContaining({ recipientName: 'Dr. Jones' }),
    );
  });

  it('creates PR4_RESPONSE_DUE diary', async () => {
    await request(app)
      .post(`/api/v1/mmi/${evalId}/solicit-pr4`)
      .set('Cookie', `token=${adminToken}`)
      .send({ claimId: claim.id, physicianName: 'Dr. Lee' });

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claim.id);
    const pr4Diary = diaries.find(d => d.diary_type === 'PR4_RESPONSE_DUE');
    expect(pr4Diary).toBeDefined();
    expect(pr4Diary.notes).toContain('Dr. Lee');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// recordPR4Response
// ═════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/v1/mmi/pr4/:pr4Id/response — recordPR4Response', () => {
  let pr4Id, claimId;

  beforeEach(async () => {
    const claim = await seedClaim();
    claimId = claim.id;
    mockCallClaude.mockResolvedValue({
      signals: [{ type: 'no_active_treatment', description: 'Test', weight: 2 }],
      recommendation: 'solicit_pr4',
      rationale: 'Test.',
    });

    const evalRes = await request(app)
      .post(`/api/v1/mmi/evaluate/${claim.id}`)
      .set('Cookie', `token=${adminToken}`);

    const pr4Res = await request(app)
      .post(`/api/v1/mmi/${evalRes.body.id}/solicit-pr4`)
      .set('Cookie', `token=${adminToken}`)
      .send({ claimId: claim.id, physicianName: 'Dr. Test' });

    pr4Id = pr4Res.body.id;
  });

  it('with apportionment_noted=true creates two diaries (review + apportionment)', async () => {
    // Clear existing diaries to count only new ones
    const { data: before } = await supabase.from('diaries').select('*').eq('claim_id', claimId);
    const beforeCount = before.length;

    const res = await request(app)
      .patch(`/api/v1/mmi/pr4/${pr4Id}/response`)
      .set('Cookie', `token=${adminToken}`)
      .send({ wpi: 12, workRestrictions: 'Light duty', futureMedical: 'PT 2x/wk', apportionmentNoted: true });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('received');

    const { data: after } = await supabase.from('diaries').select('*').eq('claim_id', claimId);
    const newDiaries = after.slice(beforeCount);

    const reviewDiary = newDiaries.find(d => d.diary_type === 'PR4_REVIEW');
    const apportDiary = newDiaries.find(d => d.diary_type === 'PR4_APPORTIONMENT');
    expect(reviewDiary).toBeDefined();
    expect(reviewDiary.notes).toContain('WPI: 12%');
    expect(apportDiary).toBeDefined();
    expect(apportDiary.notes).toContain('QME/AME may be needed');
  });

  it('with apportionment_noted=false creates one diary (review only)', async () => {
    const { data: before } = await supabase.from('diaries').select('*').eq('claim_id', claimId);
    const beforeCount = before.length;

    await request(app)
      .patch(`/api/v1/mmi/pr4/${pr4Id}/response`)
      .set('Cookie', `token=${adminToken}`)
      .send({ wpi: 8, workRestrictions: 'None', apportionmentNoted: false });

    const { data: after } = await supabase.from('diaries').select('*').eq('claim_id', claimId);
    const newDiaries = after.slice(beforeCount);

    const reviewDiary = newDiaries.find(d => d.diary_type === 'PR4_REVIEW');
    const apportDiary = newDiaries.find(d => d.diary_type === 'PR4_APPORTIONMENT');
    expect(reviewDiary).toBeDefined();
    expect(apportDiary).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// dismissMMIEvaluation
// ═════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/v1/mmi/:evalId/dismiss — dismissMMIEvaluation', () => {
  it('sets adjuster_action = dismissed', async () => {
    const claim = await seedClaim();
    mockCallClaude.mockResolvedValue({
      signals: [{ type: 'claim_age_exceeds_typical', description: 'Old claim', weight: 1 }],
      recommendation: 'monitor',
      rationale: 'Mild.',
    });

    const evalRes = await request(app)
      .post(`/api/v1/mmi/evaluate/${claim.id}`)
      .set('Cookie', `token=${adminToken}`);

    const res = await request(app)
      .patch(`/api/v1/mmi/${evalRes.body.id}/dismiss`)
      .set('Cookie', `token=${adminToken}`)
      .send({ note: 'Not ready for P&S yet' });

    expect(res.status).toBe(200);
    expect(res.body.adjuster_action).toBe('dismissed');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Auth
// ═════════════════════════════════════════════════════════════════════════════
describe('Authentication', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/v1/mmi/evaluate/some-claim');
    expect(res.status).toBe(401);
  });

  it('returns 403 for employer role', async () => {
    const { generateEmployerToken } = require('../../src/middleware/auth');
    const empToken = generateEmployerToken({ sub: 'e1', employerId: 'emp1', employerName: 'Test' });
    const res = await request(app)
      .post('/api/v1/mmi/evaluate/some-claim')
      .set('Cookie', `token=${empToken}`);
    expect(res.status).toBe(403);
  });
});
