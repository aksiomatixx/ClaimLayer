'use strict';

/**
 * Integration tests — M19 Settlement Flow.
 *
 * End-to-end: calculate stip → price C&R → compare → MSA screen.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const request      = require('supertest');
const app          = require('../../src/index');
const { generateAdminToken, generateEmployerToken } = require('../../src/middleware/auth');
const { supabase } = require('../../src/services/supabase');

const mockCallClaude = jest.fn();
jest.mock('../../src/services/aiService', () => ({
  analyzeCompensability: jest.fn(),
  evaluateRFA: jest.fn(),
  _callClaude: (...args) => mockCallClaude(...args),
}));

jest.mock('../../src/services/filehandler', () => ({
  setReserves: jest.fn().mockResolvedValue({ status: 'ok' }),
  createClaim: jest.fn().mockResolvedValue({ claimId: 'fh_mock', status: 'created' }),
  createDiary: jest.fn().mockResolvedValue({ diaryId: 'diy_mock' }),
  completeDiary: jest.fn().mockResolvedValue({ status: 'completed' }),
  attachDocument: jest.fn().mockResolvedValue({ documentId: 'doc_mock' }),
  getLedger: jest.fn().mockResolvedValue({ entries: [] }),
  recordPayment: jest.fn().mockResolvedValue({ paymentId: 'pay_mock' }),
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
  getLetterStatus: jest.fn().mockResolvedValue({ letterId: 'ltr_mock', status: 'in_transit' }),
}));

const adminToken = generateAdminToken({ sub: 'admin-001', email: 'admin@homecaretpa.com' });

async function seedClaimWithPD() {
  const claimId = `claim_stl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from('claims').insert({
    id: claimId,
    claim_number: 'HHW-2026-STL',
    employer_id: 'employer-brightcare-001',
    employer_name: 'BrightCare Home Health',
    status: 'pd_evaluation',
    employee: { firstName: 'Maria', lastName: 'Santos', dob: '1985-03-12', adpEmployeeId: 'BC-001', jobTitle: 'HHA' },
    aww: 750.75, td_rate: 500.50,
    date_of_injury: '2025-06-15',
    body_part: 'Lumbar Spine',
    injury_type: 'Lifting Injury',
    filed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const pdEvalId = `pdeval_${Date.now()}`;
  await supabase.from('pd_evaluations').insert({
    id: pdEvalId,
    claim_id: claimId,
    wpi: 10,
    pd_percent: 16,
    pd_weeks: 48,
    pd_weekly_rate: 290,
    pd_total_value: 13920,
    apportionment_percent: 0,
    adjusted_pd_percent: 16,
    adjusted_total_value: 13920,
    calculated_at: new Date().toISOString(),
  });

  await supabase.from('employees').insert({
    adp_employee_id: 'BC-001',
    first_name: 'Maria', last_name: 'Santos',
    ssdi_receiving: false,
    created_at: new Date().toISOString(),
  });

  // M14: MSA screening required before priceCnr. Seed a "not required" row
  // so the existing M19 end-to-end test (which screens AFTER pricing) still
  // exercises the same assertions.
  await supabase.from('msa_screenings').insert({
    claim_id: claimId,
    screened_at: new Date().toISOString(),
    medicare_eligible: false,
    age_at_screening: 41,
    ssdi_receiving: false,
    projected_settlement_value: 22000,
    msa_required: false,
  });

  return { claimId, pdEvalId };
}

beforeEach(() => {
  supabase._resetStore();
  mockCallClaude.mockReset();
});

describe('Settlement flow — end-to-end', () => {
  it('calculate stip → price C&R → compare → MSA screen', async () => {
    const { claimId } = await seedClaimWithPD();

    // Step 1: Get stip value
    const stipRes = await request(app)
      .post(`/api/v1/claims/${claimId}/stip-value`)
      .set('Cookie', `token=${adminToken}`);

    expect(stipRes.status).toBe(200);
    expect(stipRes.body.stipValue).toBe(13920);

    // Step 2: Price C&R
    mockCallClaude.mockResolvedValue({
      cnrValueLow: 18000,
      cnrValueMid: 22000,
      cnrValueHigh: 28000,
      futureMedicalEstimate: 8000,
      rationale: 'Moderate lumbar injury.',
      riskFactors: ['Future PT'],
      recommendation: 'adjuster_review',
    });

    const cnrRes = await request(app)
      .post(`/api/v1/claims/${claimId}/cnr-price`)
      .set('Cookie', `token=${adminToken}`);

    expect(cnrRes.status).toBe(201);
    expect(cnrRes.body.cnrValue).toBe(22000);
    expect(cnrRes.body.stipValue).toBe(13920);
    expect(cnrRes.body.recommendation).toBe('adjuster_review');

    // Step 3: List settlement offers
    const offersRes = await request(app)
      .get(`/api/v1/claims/${claimId}/settlement-offers`)
      .set('Cookie', `token=${adminToken}`);

    expect(offersRes.status).toBe(200);
    expect(offersRes.body.count).toBe(1);
    expect(offersRes.body.offers[0].offer_type).toBe('cnr');

    // Step 4: MSA screen
    const msaRes = await request(app)
      .post(`/api/v1/claims/${claimId}/msa-screen`)
      .set('Cookie', `token=${adminToken}`)
      .send({ projectedSettlementValue: 22000 });

    expect(msaRes.status).toBe(201);
    expect(msaRes.body.required).toBe(false); // Worker age ~41, settlement $22k < $250k threshold
  });
});

describe('Settlement auth', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/v1/claims/xxx/msa-screen').send({ projectedSettlementValue: 10000 });
    expect(res.status).toBe(401);
  });

  it('returns 403 for employer role', async () => {
    const empToken = generateEmployerToken({ sub: 'e1', employerId: 'emp1', employerName: 'Test' });
    const res = await request(app)
      .post('/api/v1/claims/xxx/stip-value')
      .set('Cookie', `token=${empToken}`);
    expect(res.status).toBe(403);
  });
});
