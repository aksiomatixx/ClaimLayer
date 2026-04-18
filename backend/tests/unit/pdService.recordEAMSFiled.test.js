'use strict';

/**
 * Unit tests — pdService.recordEAMSFiled (M14.5 bug fix) and
 * pdService.recordStipAwardServed (new in M14.5).
 *
 * M14.5 change: recordEAMSFiled no longer transitions claim status.
 * Transition happens at disbursementService.recordDisbursementPayment.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const pdService    = require('../../src/services/pdService');
const { supabase } = require('../../src/services/supabase');

async function seedClaim(overrides = {}) {
  const id = overrides.id || `claim_eams_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from('claims').insert({
    id,
    status:     'pd_evaluation',
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
    claim_id:              claimId,
    pd_percent:            24,
    pd_total_value:        20_880,
    future_medical:        true,
    status:                'eams_ready',
    eams_package_ready:    true,
    worker_signed_at:      new Date().toISOString(),
    adjuster_signed_at:    new Date().toISOString(),
    created_at:            new Date().toISOString(),
    updated_at:            new Date().toISOString(),
    ...overrides,
  });
  return id;
}

beforeEach(() => {
  supabase._resetStore();
});

describe('recordEAMSFiled — M14.5 bug fix', () => {
  it('persists eams_filed_at and flips status to filed', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);

    const updated = await pdService.recordEAMSFiled(stipId, { filedDate: '2026-06-15', filedBy: 'adj-001' });

    expect(updated.status).toBe('filed');
    expect(updated.eams_filed_at).toBe('2026-06-15');
  });

  it('persists eams_filed_by (M14.5 column addition)', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);

    const updated = await pdService.recordEAMSFiled(stipId, { filedDate: '2026-06-15', filedBy: 'adj-123' });
    expect(updated.eams_filed_by).toBe('adj-123');
  });

  it('does NOT change claim status (future_medical=true case)', async () => {
    const claimId = await seedClaim({ status: 'pd_evaluation' });
    const stipId  = await seedStip(claimId, { future_medical: true });

    await pdService.recordEAMSFiled(stipId, { filedDate: '2026-06-15' });

    const { data: c } = await supabase.from('claims').select('*').eq('id', claimId).single();
    expect(c.status).toBe('pd_evaluation'); // unchanged
  });

  it('does NOT change claim status (future_medical=false case)', async () => {
    const claimId = await seedClaim({ status: 'pd_evaluation' });
    const stipId  = await seedStip(claimId, { future_medical: false });

    await pdService.recordEAMSFiled(stipId, { filedDate: '2026-06-15' });

    const { data: c } = await supabase.from('claims').select('*').eq('id', claimId).single();
    expect(c.status).toBe('pd_evaluation'); // unchanged even when no future medical
  });

  it('audit_log entry notes the delayed-transition behavior', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId);
    await pdService.recordEAMSFiled(stipId, { filedDate: '2026-06-15' });

    const { data: logs } = await supabase.from('audit_log').select('*');
    const eams = logs.find(l => l.action === 'eams_filed');
    expect(eams).toBeDefined();
    expect(eams.description).toMatch(/unchanged|disbursement/i);
  });

  it('rejects when stipulation status is not eams_ready / adjuster_signed', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId, { status: 'draft' });
    await expect(pdService.recordEAMSFiled(stipId, { filedDate: '2026-06-15' })).rejects.toThrow(/Cannot file EAMS/);
  });
});

describe('recordStipAwardServed — M14.5', () => {
  it('persists award_service_date + award_served_by', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId, { status: 'filed' });

    const updated = await pdService.recordStipAwardServed(stipId, {
      serviceDate: '2026-07-01',
      servedBy:    'WCAB LA',
    });
    expect(updated.award_service_date).toBe('2026-07-01');
    expect(updated.award_served_by).toBe('WCAB LA');
  });

  it('creates STIP_AWARD_FOLLOWUP diary (CRITICAL, due = service + 10 days)', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId, { status: 'filed' });
    await pdService.recordStipAwardServed(stipId, { serviceDate: '2026-07-01' });

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claimId);
    const diary = diaries.find(d => d.diary_type === 'STIP_AWARD_FOLLOWUP');
    expect(diary).toBeDefined();
    expect(diary.priority).toBe('CRITICAL');
    expect(diary.due_date).toBe('2026-07-11'); // +10 calendar days
    expect(diary.no_snooze).toBe(true);
  });

  it('closes EAMS_FILE diary if open', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId, { status: 'filed' });

    // Seed an open EAMS_FILE diary.
    await supabase.from('diaries').insert({
      claim_id:    claimId,
      diary_type:  'EAMS_FILE',
      due_date:    '2026-06-22',
      assigned_to: 'system@homecaretpa.com',
      priority:    'HIGH',
      status:      'open',
      created_at:  new Date().toISOString(),
    });

    await pdService.recordStipAwardServed(stipId, { serviceDate: '2026-07-01' });

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claimId);
    const closed = diaries.find(d => d.diary_type === 'EAMS_FILE');
    expect(closed.status).toBe('completed');
  });

  it('throws when serviceDate is missing', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId, { status: 'filed' });
    await expect(pdService.recordStipAwardServed(stipId, {})).rejects.toThrow('serviceDate is required');
  });

  it('throws when stipulation not found', async () => {
    await expect(pdService.recordStipAwardServed('no_such_stip', { serviceDate: '2026-07-01' }))
      .rejects.toThrow('not found');
  });

  it('writes claim_event type=stip_award_served', async () => {
    const claimId = await seedClaim();
    const stipId  = await seedStip(claimId, { status: 'filed' });
    await pdService.recordStipAwardServed(stipId, { serviceDate: '2026-07-01' });

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', claimId);
    expect(events.some(e => e.type === 'stip_award_served')).toBe(true);
  });
});
