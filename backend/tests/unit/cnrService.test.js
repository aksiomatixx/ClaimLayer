'use strict';

/**
 * Unit tests — M14 Compromise and Release workflow.
 *
 * Covers state transitions, MSA gate, guardrail gate, represented-worker
 * rule, payment-due calculation, closure semantics, and the stubbed
 * document generator.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');

jest.mock('../../src/services/filehandler', () => ({
  setReserves:     jest.fn().mockResolvedValue({ status: 'ok' }),
  createClaim:     jest.fn().mockResolvedValue({ claimId: 'fh_mock', status: 'created' }),
  createDiary:     jest.fn().mockResolvedValue({ diaryId: 'diy_mock' }),
  completeDiary:   jest.fn().mockResolvedValue({ status: 'completed' }),
  attachDocument:  jest.fn().mockResolvedValue({ documentId: 'doc_mock' }),
  getLedger:       jest.fn().mockResolvedValue({ entries: [] }),
  recordPayment:   jest.fn().mockResolvedValue({ paymentId: 'pay_mock' }),
}));
jest.mock('../../src/services/adp', () => ({
  getEmployeeWithFinancials: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../src/services/lobService', () => ({
  sendLetter: jest.fn().mockResolvedValue({ letterId: 'ltr_mock', status: 'queued' }),
}));

const cnrService      = require('../../src/services/cnrService');
const pdPricingService = require('../../src/services/pdPricingService');

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedClaim({
  represented = false, status = 'pd_evaluation',
  stipValue = 13920, pdPercent = 16,
} = {}) {
  const claimId = `claim_cnr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from('claims').insert({
    id: claimId,
    claim_number: 'HHW-2026-CNR',
    employer_id: 'employer-brightcare-001',
    employer_name: 'BrightCare Home Health',
    status,
    employee: { firstName: 'Maria', lastName: 'Santos', dob: '1985-03-12', jobTitle: 'HHA' },
    attorney_represented: represented,
    aww: 750.75, td_rate: 500.50,
    date_of_injury: '2025-06-15',
    body_part: 'Lumbar Spine',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  // cnrService.offerCnr → compareOffers → calculateStipValue needs a PD eval.
  await supabase.from('pd_evaluations').insert({
    id: `pdeval_${Date.now()}_${Math.random().toString(36).slice(2, 4)}`,
    claim_id: claimId,
    wpi: 10, pd_percent: pdPercent, pd_weeks: 48, pd_weekly_rate: 290,
    pd_total_value: stipValue,
    apportionment_percent: 0,
    adjusted_pd_percent: pdPercent, adjusted_total_value: stipValue,
    calculated_at: new Date().toISOString(),
  });
  return claimId;
}

async function seedMsa(claimId, { msaRequired = false } = {}) {
  const { data } = await supabase.from('msa_screenings').insert({
    claim_id: claimId,
    screened_at: new Date().toISOString(),
    medicare_eligible: false,
    age_at_screening: 41,
    ssdi_receiving: false,
    projected_settlement_value: 22000,
    msa_required: msaRequired,
  }).select().single();
  return data.id;
}

async function seedOffer(claimId, {
  status = 'draft', cnrValue = 22000, stipValue = 13920, msaScreeningId = null,
} = {}) {
  const offerId = `so_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from('settlement_offers').insert({
    id: offerId,
    claim_id: claimId,
    offer_type: 'cnr',
    stip_value: stipValue,
    cnr_value: cnrValue,
    cnr_premium_pct: stipValue > 0 ? Math.round((cnrValue / stipValue - 1) * 10000) / 100 : null,
    pricing_method: 'claude_ai',
    msa_screening_id: msaScreeningId,
    status,
    created_at: new Date().toISOString(),
  });
  return offerId;
}

beforeEach(() => {
  supabase._resetStore();
});

// ═════════════════════════════════════════════════════════════════════════════
// offerCnr
// ═════════════════════════════════════════════════════════════════════════════
describe('offerCnr', () => {
  it('happy path — attorney target', async () => {
    const claimId = await seedClaim({ represented: true });
    const msaId   = await seedMsa(claimId);
    const offerId = await seedOffer(claimId, { msaScreeningId: msaId });

    const out = await cnrService.offerCnr(offerId, { offeredTo: 'attorney' });

    expect(out.status).toBe('offered');
    expect(out.offered_to).toBe('attorney');
    expect(out.offered_at).toBeTruthy();

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claimId);
    expect(diaries.some(d => d.diary_type === 'CNR_ATTORNEY_TRANSMIT')).toBe(true);

    const { data: claim } = await supabase.from('claims').select('*').eq('id', claimId).single();
    expect(claim.status).toBe('settlement_discussions');
  });

  it('happy path — worker target when unrepresented', async () => {
    const claimId = await seedClaim({ represented: false });
    await seedMsa(claimId);
    const offerId = await seedOffer(claimId);

    const out = await cnrService.offerCnr(offerId, { offeredTo: 'worker' });
    expect(out.status).toBe('offered');
    expect(out.offered_to).toBe('worker');

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claimId);
    expect(diaries.some(d => d.diary_type === 'CNR_WORKER_FOLLOWUP')).toBe(true);
  });

  it('rejects when no MSA screening exists', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOffer(claimId);

    await expect(cnrService.offerCnr(offerId, { offeredTo: 'worker' })).rejects.toThrow(
      'MSA_SCREENING_REQUIRED_BEFORE_CNR_OFFER',
    );
  });

  it('rejects when MSA required', async () => {
    const claimId = await seedClaim();
    await seedMsa(claimId, { msaRequired: true });
    const offerId = await seedOffer(claimId);

    await expect(cnrService.offerCnr(offerId, { offeredTo: 'worker' })).rejects.toThrow(
      'CNR_BLOCKED_MSA_REQUIRED',
    );
  });

  it('rejects DONT_OFFER_CNR when cnr < stip × 1.15', async () => {
    const claimId = await seedClaim({ stipValue: 10000 });
    await seedMsa(claimId);
    // stip 10k, cnr 11k → 10% premium → DONT_OFFER_CNR
    const offerId = await seedOffer(claimId, { stipValue: 10000, cnrValue: 11000 });

    await expect(cnrService.offerCnr(offerId, { offeredTo: 'worker' })).rejects.toThrow(
      /CNR_BLOCKED_GUARDRAIL_DONT_OFFER_CNR/,
    );
  });

  it('rejects represented worker when offeredTo=worker', async () => {
    const claimId = await seedClaim({ represented: true });
    await seedMsa(claimId);
    const offerId = await seedOffer(claimId);

    await expect(cnrService.offerCnr(offerId, { offeredTo: 'worker' })).rejects.toThrow(
      'CNR_BLOCKED_REPRESENTED_WORKER_MUST_USE_ATTORNEY',
    );
  });

  it('rejects invalid prior state (already offered)', async () => {
    const claimId = await seedClaim();
    await seedMsa(claimId);
    const offerId = await seedOffer(claimId, { status: 'offered' });

    await expect(cnrService.offerCnr(offerId, { offeredTo: 'worker' })).rejects.toThrow(
      /Invalid C&R transition: offered → offered/,
    );
  });

  it('rejects invalid offeredTo value', async () => {
    const claimId = await seedClaim();
    await seedMsa(claimId);
    const offerId = await seedOffer(claimId);

    await expect(cnrService.offerCnr(offerId, { offeredTo: 'system' })).rejects.toThrow(
      /offeredTo must be/,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// recordWorkerAcceptance
// ═════════════════════════════════════════════════════════════════════════════
describe('recordWorkerAcceptance', () => {
  it('happy path — offered → accepted', async () => {
    const claimId = await seedClaim();
    await seedMsa(claimId);
    const offerId = await seedOffer(claimId, { status: 'offered' });

    const out = await cnrService.recordWorkerAcceptance(offerId);
    expect(out.status).toBe('accepted');
    expect(out.worker_signed_at).toBeTruthy();

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claimId);
    expect(diaries.some(d => d.diary_type === 'CNR_ADJUSTER_SIGN')).toBe(true);
  });

  it('rejects when prior state is draft', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOffer(claimId, { status: 'draft' });
    await expect(cnrService.recordWorkerAcceptance(offerId)).rejects.toThrow(
      /Invalid C&R transition: draft → accepted/,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// recordAdjusterSignature
// ═════════════════════════════════════════════════════════════════════════════
describe('recordAdjusterSignature', () => {
  it('happy path — accepted → eams_ready (single step)', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOffer(claimId, { status: 'accepted' });

    const out = await cnrService.recordAdjusterSignature(offerId, 'adjuster-1');
    expect(out.status).toBe('eams_ready');
    expect(out.adjuster_signed_at).toBeTruthy();
    expect(out.adjuster_signed_by).toBe('adjuster-1');
    expect(out.eams_package_ready).toBe(true);

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claimId);
    expect(diaries.some(d => d.diary_type === 'CNR_EAMS_FILE')).toBe(true);
  });

  it('rejects when prior state is offered', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOffer(claimId, { status: 'offered' });
    await expect(cnrService.recordAdjusterSignature(offerId, 'a')).rejects.toThrow(
      /Invalid C&R transition: offered → signed/,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// recordEAMSFiled
// ═════════════════════════════════════════════════════════════════════════════
describe('recordEAMSFiled', () => {
  it('happy path — eams_ready → filed', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOffer(claimId, { status: 'eams_ready' });

    const out = await cnrService.recordEAMSFiled(offerId, { filedDate: '2026-05-01', filedBy: 'adj-1' });
    expect(out.status).toBe('filed');
    expect(out.eams_filed_at).toBe('2026-05-01');

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claimId);
    expect(diaries.some(d => d.diary_type === 'CNR_OACR_FOLLOWUP')).toBe(true);
  });

  it('rejects when prior state is accepted', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOffer(claimId, { status: 'accepted' });
    await expect(cnrService.recordEAMSFiled(offerId, { filedDate: '2026-05-01' })).rejects.toThrow(
      /Invalid C&R transition: accepted → filed/,
    );
  });

  it('requires filedDate', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOffer(claimId, { status: 'eams_ready' });
    await expect(cnrService.recordEAMSFiled(offerId, {})).rejects.toThrow(/filedDate is required/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// recordOACRReceived
// ═════════════════════════════════════════════════════════════════════════════
describe('recordOACRReceived', () => {
  it('happy path — filed → oacr_received; payment_due_date = oacr + 30 cal days', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOffer(claimId, { status: 'filed' });

    const out = await cnrService.recordOACRReceived(offerId, { oacrDate: '2026-06-01' });
    expect(out.status).toBe('oacr_received');
    expect(out.wcab_oacr_received_at).toBe('2026-06-01');
    expect(out.payment_due_date).toBe('2026-07-01');

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claimId);
    const pay = diaries.find(d => d.diary_type === 'CNR_PAYMENT_DUE');
    expect(pay).toBeDefined();
    expect(pay.due_date).toBe('2026-07-01');
    expect(pay.priority).toBe('CRITICAL');
    expect(pay.no_snooze).toBe(true);
  });

  it('rejects when prior state is oacr_received already', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOffer(claimId, { status: 'oacr_received' });
    await expect(cnrService.recordOACRReceived(offerId, { oacrDate: '2026-06-01' })).rejects.toThrow(
      /Invalid C&R transition: oacr_received → oacr_received/,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// recordPayment
// ═════════════════════════════════════════════════════════════════════════════
describe('recordPayment', () => {
  it('happy path — oacr_received → paid; claim → closed (NOT future_medical_only)', async () => {
    const claimId = await seedClaim({ status: 'settlement_discussions' });
    const offerId = await seedOffer(claimId, { status: 'oacr_received' });

    const out = await cnrService.recordPayment(offerId, { paidDate: '2026-06-20' });
    expect(out.status).toBe('paid');
    expect(out.paid_at).toBe('2026-06-20');

    const { data: claim } = await supabase.from('claims').select('*').eq('id', claimId).single();
    expect(claim.status).toBe('closed');
    expect(claim.status).not.toBe('future_medical_only');
  });

  it('rejects when prior state is filed', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOffer(claimId, { status: 'filed' });
    await expect(cnrService.recordPayment(offerId, { paidDate: '2026-06-20' })).rejects.toThrow(
      /Invalid C&R transition: filed → paid/,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// rejectOffer / withdrawOffer
// ═════════════════════════════════════════════════════════════════════════════
describe('rejectOffer / withdrawOffer', () => {
  it('rejectOffer from draft → rejected', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOffer(claimId, { status: 'draft' });

    const out = await cnrService.rejectOffer(offerId, { reason: 'Too low' });
    expect(out.status).toBe('rejected');
    expect(out.rejected_reason).toBe('Too low');
  });

  it('rejectOffer from offered → rejected; closes open CNR diaries', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOffer(claimId, { status: 'offered' });
    // pre-seed an open diary
    await supabase.from('diaries').insert({
      id: `d_${Date.now()}`,
      claim_id: claimId, diary_type: 'CNR_WORKER_FOLLOWUP',
      due_date: '2026-12-01', status: 'open', priority: 'MEDIUM',
      created_at: new Date().toISOString(),
    });

    await cnrService.rejectOffer(offerId, { reason: 'Worker refused' });

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claimId);
    const worker = diaries.find(d => d.diary_type === 'CNR_WORKER_FOLLOWUP');
    expect(worker.status).toBe('completed');
  });

  it('withdrawOffer from draft → withdrawn', async () => {
    const claimId = await seedClaim();
    const offerId = await seedOffer(claimId, { status: 'draft' });

    const out = await cnrService.withdrawOffer(offerId, { reason: 'Repricing needed' });
    expect(out.status).toBe('withdrawn');
    expect(out.withdrawn_reason).toBe('Repricing needed');
  });

  it('withdrawOffer from offered does NOT revert claim status', async () => {
    const claimId = await seedClaim({ status: 'settlement_discussions' });
    const offerId = await seedOffer(claimId, { status: 'offered' });

    await cnrService.withdrawOffer(offerId, { reason: 'Adjuster decision' });

    const { data: claim } = await supabase.from('claims').select('*').eq('id', claimId).single();
    expect(claim.status).toBe('settlement_discussions');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// getOfferWithTimeline
// ═════════════════════════════════════════════════════════════════════════════
describe('getOfferWithTimeline', () => {
  it('returns offer + chronological C&R events', async () => {
    const claimId = await seedClaim();
    await seedMsa(claimId);
    const offerId = await seedOffer(claimId);

    await cnrService.offerCnr(offerId, { offeredTo: 'worker' });

    const { offer, timeline } = await cnrService.getOfferWithTimeline(offerId);
    expect(offer.id).toBe(offerId);
    expect(timeline.some(t => t.type === 'cnr_offered')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// generateCnrDocument — DWC-CA form 10214(c) not provided
// ═════════════════════════════════════════════════════════════════════════════
describe('generateCnrDocument', () => {
  it('throws C&R_FORM_TEMPLATE_NOT_PROVIDED until the DWC-CA 10214(c) form is supplied', async () => {
    await expect(cnrService.generateCnrDocument('any-id')).rejects.toThrow(
      'C&R_FORM_TEMPLATE_NOT_PROVIDED',
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Fetch / validation edge cases
// ═════════════════════════════════════════════════════════════════════════════
describe('offer fetching', () => {
  it('throws not found for missing offer', async () => {
    await expect(cnrService.offerCnr('nope', { offeredTo: 'worker' })).rejects.toThrow(
      /Settlement offer not found/,
    );
  });

  it('rejects non-C&R offers', async () => {
    const claimId = await seedClaim();
    const offerId = `so_${Date.now()}`;
    await supabase.from('settlement_offers').insert({
      id: offerId, claim_id: claimId, offer_type: 'stip',
      stip_value: 10000, status: 'draft',
      created_at: new Date().toISOString(),
    });
    await expect(cnrService.offerCnr(offerId, { offeredTo: 'worker' })).rejects.toThrow(
      /is not a C&R offer/,
    );
  });
});

// Re-exercise the compareOffers guardrail path from inside cnrService for
// completeness — confirms pdPricingService.compareOffers is what offerCnr
// calls and that CNR_VIABLE does NOT trip the guardrail refusal.
describe('offerCnr integrates compareOffers', () => {
  it('allows REQUIRES_ADJUSTER_REVIEW to proceed (not blocked — adjuster acknowledges at offer time)', async () => {
    const claimId = await seedClaim({ stipValue: 10000 });
    await seedMsa(claimId);
    // cnr 60k vs stip 10k = 6x → REQUIRES_ADJUSTER_REVIEW
    const offerId = await seedOffer(claimId, { stipValue: 10000, cnrValue: 60000 });

    const cmp = await pdPricingService.compareOffers(claimId);
    expect(cmp.flag).toBe('REQUIRES_ADJUSTER_REVIEW');

    const out = await cnrService.offerCnr(offerId, { offeredTo: 'worker' });
    expect(out.status).toBe('offered');
  });
});
