'use strict';

/**
 * Unit tests — M19 C&R pricing guardrails.
 *
 * Tests guardrail thresholds + AI mock for priceCnr.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');

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

const mockCallClaude = jest.fn();
jest.mock('../../src/services/aiService', () => ({
  analyzeCompensability: jest.fn(),
  evaluateRFA: jest.fn(),
  _callClaude: (...args) => mockCallClaude(...args),
}));

const pdPricingService = require('../../src/services/pdPricingService');
const { CNR_GUARDRAILS } = pdPricingService;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedClaimWithPD(overrides = {}) {
  const claimId = `claim_cnr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from('claims').insert({
    id: claimId,
    claim_number: 'HHW-2026-CNR',
    employer_id: 'employer-brightcare-001',
    employer_name: 'BrightCare Home Health',
    status: 'pd_evaluation',
    employee: { firstName: 'Maria', lastName: 'Santos', dob: '1985-03-12', jobTitle: 'HHA' },
    aww: 750.75, td_rate: 500.50,
    date_of_injury: '2025-06-15',
    body_part: 'Lumbar Spine',
    filed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  // Seed PD evaluation (what calculateStipValue reads from)
  const pdEvalId = `pdeval_${Date.now()}`;
  await supabase.from('pd_evaluations').insert({
    id: pdEvalId,
    claim_id: claimId,
    wpi: overrides.wpi || 10,
    pd_percent: overrides.pdPercent || 16,
    pd_weeks: overrides.pdWeeks || 48,
    pd_weekly_rate: overrides.pdWeeklyRate || 290,
    pd_total_value: overrides.pdTotalValue || 13920,
    apportionment_percent: overrides.apportionment || 0,
    adjusted_pd_percent: overrides.adjustedPdPercent || overrides.pdPercent || 16,
    adjusted_total_value: overrides.adjustedTotalValue || overrides.pdTotalValue || 13920,
    calculated_at: new Date().toISOString(),
  });

  return { claimId, pdEvalId };
}

beforeEach(() => {
  supabase._resetStore();
  mockCallClaude.mockReset();
});

// ═════════════════════════════════════════════════════════════════════════════
// priceCnr
// ═════════════════════════════════════════════════════════════════════════════
describe('priceCnr', () => {
  it('calls Claude and writes settlement_offers row', async () => {
    const { claimId } = await seedClaimWithPD({ pdTotalValue: 13920 });
    mockCallClaude.mockResolvedValue({
      cnrValueLow: 18000,
      cnrValueMid: 22000,
      cnrValueHigh: 28000,
      futureMedicalEstimate: 8000,
      closureValueEstimate: 4000,
      rationale: 'Moderate lumbar injury with future PT needs.',
      riskFactors: ['Potential future surgery'],
      recommendation: 'adjuster_review',
    });

    const result = await pdPricingService.priceCnr(claimId);

    expect(result.cnrValue).toBe(22000);
    expect(result.stipValue).toBe(13920);
    expect(result.recommendation).toBe('adjuster_review');
    expect(result.rationale).toContain('lumbar');

    // Verify settlement_offers row
    const { data: offers } = await supabase.from('settlement_offers').select('*').eq('claim_id', claimId);
    expect(offers.length).toBe(1);
    expect(offers[0].offer_type).toBe('cnr');
    expect(offers[0].pricing_method).toBe('claude_ai');
  });

  it('forces recommendation to adjuster_review if AI returns something else', async () => {
    const { claimId } = await seedClaimWithPD();
    mockCallClaude.mockResolvedValue({
      cnrValueMid: 20000,
      recommendation: 'auto_approve',
    });

    const result = await pdPricingService.priceCnr(claimId);
    expect(result.recommendation).toBe('adjuster_review');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// compareOffers — guardrail thresholds
// ═════════════════════════════════════════════════════════════════════════════
describe('compareOffers guardrails', () => {
  it('DONT_OFFER_CNR when cnr < stip × 1.15', async () => {
    const { claimId } = await seedClaimWithPD({ pdTotalValue: 10000, adjustedTotalValue: 10000 });
    // Seed a C&R offer that is only 10% above stip (below 15% threshold)
    await supabase.from('settlement_offers').insert({
      id: `so_${Date.now()}`,
      claim_id: claimId,
      offer_type: 'cnr',
      stip_value: 10000,
      cnr_value: 11000,  // 10% premium, below 15% threshold
      pricing_method: 'claude_ai',
      status: 'draft',
      created_at: new Date().toISOString(),
    });

    const result = await pdPricingService.compareOffers(claimId);
    expect(result.flag).toBe('DONT_OFFER_CNR');
  });

  it('REQUIRES_ADJUSTER_REVIEW when cnr > stip × 5', async () => {
    const { claimId } = await seedClaimWithPD({ pdTotalValue: 10000, adjustedTotalValue: 10000 });
    await supabase.from('settlement_offers').insert({
      id: `so_${Date.now()}`,
      claim_id: claimId,
      offer_type: 'cnr',
      stip_value: 10000,
      cnr_value: 60000,  // 6x stip
      pricing_method: 'claude_ai',
      status: 'draft',
      created_at: new Date().toISOString(),
    });

    const result = await pdPricingService.compareOffers(claimId);
    expect(result.flag).toBe('REQUIRES_ADJUSTER_REVIEW');
  });

  it('CNR_VIABLE when cnr is within acceptable range', async () => {
    const { claimId } = await seedClaimWithPD({ pdTotalValue: 10000, adjustedTotalValue: 10000 });
    await supabase.from('settlement_offers').insert({
      id: `so_${Date.now()}`,
      claim_id: claimId,
      offer_type: 'cnr',
      stip_value: 10000,
      cnr_value: 18000,  // 1.8x — within range
      pricing_method: 'claude_ai',
      status: 'draft',
      created_at: new Date().toISOString(),
    });

    const result = await pdPricingService.compareOffers(claimId);
    expect(result.flag).toBe('CNR_VIABLE');
  });

  it('NO_CNR_PRICED when no C&R offer exists', async () => {
    const { claimId } = await seedClaimWithPD();

    const result = await pdPricingService.compareOffers(claimId);
    expect(result.flag).toBe('NO_CNR_PRICED');
  });
});
