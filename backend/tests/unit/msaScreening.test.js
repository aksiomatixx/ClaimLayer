'use strict';

/**
 * Unit tests — M19 MSA Screening gate logic.
 *
 * Tests all 4 gate combinations:
 *   1. Medicare eligible (age ≥65) + settlement >$25k → required
 *   2. SSDI receiving + settlement >$25k → required
 *   3. Age ≥35 + settlement >$250k → required (likely eligible within 30 years)
 *   4. Young worker + low settlement → NOT required
 *   5. Age ≥65 + settlement ≤$25k → NOT required (below threshold)
 *   6. SSDI + settlement ≤$25k → NOT required
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const claimService = require('../../src/services/claimService');

jest.mock('../../src/services/aiService');
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

const msaScreeningService = require('../../src/services/msaScreeningService');

async function seedClaim(overrides = {}) {
  const id = overrides.id || `claim_msa_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const claim = {
    id,
    claim_number: 'HHW-2026-MSA',
    employer_id: 'employer-brightcare-001',
    employer_name: 'BrightCare Home Health',
    status: 'pd_evaluation',
    employee: {
      firstName: 'Maria', lastName: 'Santos',
      dob: overrides.dob || '1985-03-12',
      adpEmployeeId: overrides.adpEmployeeId || 'BC-001',
    },
    aww: 750.75, td_rate: 500.50,
    date_of_injury: '2025-06-15',
    body_part: 'Lumbar Spine',
    filed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  await supabase.from('claims').insert(claim);
  return claim;
}

async function seedEmployee(adpId, ssdi = false) {
  await supabase.from('employees').insert({
    adp_employee_id: adpId,
    first_name: 'Maria', last_name: 'Santos',
    ssdi_receiving: ssdi,
    created_at: new Date().toISOString(),
  });
}

beforeEach(() => {
  supabase._resetStore();
  claimService._resetClaims();
});

describe('MSA Screening gate logic', () => {
  it('Medicare eligible (age ≥65) + settlement >$25k → required', async () => {
    // DOB makes worker ~66 years old
    const claim = await seedClaim({ dob: '1960-01-15', employee: { firstName: 'Maria', lastName: 'Santos', dob: '1960-01-15', adpEmployeeId: 'BC-001' } });
    await seedEmployee('BC-001', false);

    const result = await msaScreeningService.screenMSA(claim.id, 50000);

    expect(result.required).toBe(true);
    expect(result.reason).toContain('65');
    expect(result.reason).toContain('25,000');
    expect(result.screeningId).toBeDefined();
  });

  it('SSDI receiving + settlement >$25k → required', async () => {
    const claim = await seedClaim({ employee: { firstName: 'Maria', lastName: 'Santos', dob: '1985-03-12', adpEmployeeId: 'BC-SSDI' } });
    await seedEmployee('BC-SSDI', true);

    const result = await msaScreeningService.screenMSA(claim.id, 30000);

    expect(result.required).toBe(true);
    expect(result.reason).toContain('SSDI');
  });

  it('Age ≥35 + settlement >$250k → required (likely eligible)', async () => {
    const claim = await seedClaim({ employee: { firstName: 'Maria', lastName: 'Santos', dob: '1985-03-12', adpEmployeeId: 'BC-35' } });
    await seedEmployee('BC-35', false);

    const result = await msaScreeningService.screenMSA(claim.id, 300000);

    expect(result.required).toBe(true);
    expect(result.reason).toContain('35');
    expect(result.reason).toContain('250,000');
  });

  it('Young worker + low settlement → NOT required', async () => {
    const claim = await seedClaim({ employee: { firstName: 'Maria', lastName: 'Santos', dob: '2000-06-01', adpEmployeeId: 'BC-YOUNG' } });
    await seedEmployee('BC-YOUNG', false);

    const result = await msaScreeningService.screenMSA(claim.id, 15000);

    expect(result.required).toBe(false);
  });

  it('Age ≥65 + settlement ≤$25k → NOT required (below threshold)', async () => {
    const claim = await seedClaim({ employee: { firstName: 'Maria', lastName: 'Santos', dob: '1955-01-15', adpEmployeeId: 'BC-OLD-LOW' } });
    await seedEmployee('BC-OLD-LOW', false);

    const result = await msaScreeningService.screenMSA(claim.id, 20000);

    expect(result.required).toBe(false);
  });

  it('SSDI + settlement ≤$25k → NOT required (below threshold)', async () => {
    const claim = await seedClaim({ employee: { firstName: 'Maria', lastName: 'Santos', dob: '1985-03-12', adpEmployeeId: 'BC-SSDI-LOW' } });
    await seedEmployee('BC-SSDI-LOW', true);

    const result = await msaScreeningService.screenMSA(claim.id, 10000);

    expect(result.required).toBe(false);
  });
});
