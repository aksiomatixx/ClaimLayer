'use strict';

/**
 * Unit tests — pdService.setPAndSDate (M14.5 write-through helper).
 *
 * Priority order (highest → lowest):
 *   qme_report > pr_4 > treating_physician > award_document > adjuster_entry
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const pdService   = require('../../src/services/pdService');
const { supabase } = require('../../src/services/supabase');

async function seedClaim(overrides = {}) {
  const id = overrides.id || `claim_ps_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from('claims').insert({
    id,
    status:     'pd_evaluation',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

async function readClaim(claimId) {
  const { data } = await supabase.from('claims').select('*').eq('id', claimId).single();
  return data;
}

beforeEach(() => {
  supabase._resetStore();
});

describe('setPAndSDate — fresh write (existing NULL)', () => {
  it('writes date, source, confirmedBy, confirmedAt', async () => {
    const claimId = await seedClaim();
    await pdService.setPAndSDate(claimId, {
      date:        '2026-02-15',
      source:      'pr_4',
      confirmedBy: 'adj-001',
    });
    const c = await readClaim(claimId);
    expect(c.p_and_s_date).toBe('2026-02-15');
    expect(c.p_and_s_source).toBe('pr_4');
    expect(c.p_and_s_confirmed_by).toBe('adj-001');
    expect(c.p_and_s_confirmed_at).toBeTruthy();
  });

  it('writes an audit_log entry on fresh write', async () => {
    const claimId = await seedClaim();
    await pdService.setPAndSDate(claimId, { date: '2026-02-15', source: 'pr_4' });
    const { data: logs } = await supabase.from('audit_log').select('*');
    expect(logs.some(l => l.action === 'p_and_s_set')).toBe(true);
  });
});

describe('setPAndSDate — source priority on same date', () => {
  it('higher source upgrades silently (pr_4 → qme_report, same date)', async () => {
    const claimId = await seedClaim();
    await pdService.setPAndSDate(claimId, { date: '2026-02-15', source: 'pr_4' });
    await pdService.setPAndSDate(claimId, { date: '2026-02-15', source: 'qme_report' });
    const c = await readClaim(claimId);
    expect(c.p_and_s_date).toBe('2026-02-15');
    expect(c.p_and_s_source).toBe('qme_report');
  });

  it('lower source is a no-op (pr_4 stays, award_document ignored)', async () => {
    const claimId = await seedClaim();
    await pdService.setPAndSDate(claimId, { date: '2026-02-15', source: 'pr_4' });
    await pdService.setPAndSDate(claimId, { date: '2026-02-15', source: 'award_document' });
    const c = await readClaim(claimId);
    expect(c.p_and_s_source).toBe('pr_4');
  });

  it('same date + same source is idempotent', async () => {
    const claimId = await seedClaim();
    await pdService.setPAndSDate(claimId, { date: '2026-02-15', source: 'pr_4' });
    const before = await readClaim(claimId);
    await pdService.setPAndSDate(claimId, { date: '2026-02-15', source: 'pr_4' });
    const after = await readClaim(claimId);
    expect(after.p_and_s_date).toBe(before.p_and_s_date);
    expect(after.p_and_s_source).toBe(before.p_and_s_source);
  });
});

describe('setPAndSDate — source priority on different date', () => {
  it('higher source overwrites lower + writes p_and_s_overwrite audit', async () => {
    const claimId = await seedClaim();
    await pdService.setPAndSDate(claimId, { date: '2026-02-15', source: 'award_document' });
    await pdService.setPAndSDate(claimId, { date: '2026-03-01', source: 'qme_report', confirmedBy: 'adj-002' });

    const c = await readClaim(claimId);
    expect(c.p_and_s_date).toBe('2026-03-01');
    expect(c.p_and_s_source).toBe('qme_report');

    const { data: logs } = await supabase.from('audit_log').select('*');
    expect(logs.some(l => l.action === 'p_and_s_overwrite')).toBe(true);
  });

  it('lower source does NOT overwrite + creates P_AND_S_CONFLICT_REVIEW diary', async () => {
    const claimId = await seedClaim();
    await pdService.setPAndSDate(claimId, { date: '2026-02-15', source: 'qme_report' });
    await pdService.setPAndSDate(claimId, { date: '2026-03-01', source: 'adjuster_entry' });

    const c = await readClaim(claimId);
    expect(c.p_and_s_date).toBe('2026-02-15'); // unchanged
    expect(c.p_and_s_source).toBe('qme_report');

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claimId);
    const conflict = diaries.find(d => d.diary_type === 'P_AND_S_CONFLICT_REVIEW');
    expect(conflict).toBeDefined();
    expect(conflict.priority).toBe('HIGH');
    expect(conflict.notes).toContain('2026-03-01');
  });
});

describe('setPAndSDate — full priority chain', () => {
  it('qme_report (5) > pr_4 (4) > treating_physician (3) > award_document (2) > adjuster_entry (1)', async () => {
    const claimId = await seedClaim();

    // Start low — adjuster_entry.
    await pdService.setPAndSDate(claimId, { date: '2026-01-01', source: 'adjuster_entry' });
    expect((await readClaim(claimId)).p_and_s_source).toBe('adjuster_entry');

    // Award (2) overrides adjuster (1).
    await pdService.setPAndSDate(claimId, { date: '2026-01-10', source: 'award_document' });
    expect((await readClaim(claimId)).p_and_s_source).toBe('award_document');

    // Treating physician (3) overrides award.
    await pdService.setPAndSDate(claimId, { date: '2026-01-20', source: 'treating_physician' });
    expect((await readClaim(claimId)).p_and_s_source).toBe('treating_physician');

    // PR-4 (4) overrides treating.
    await pdService.setPAndSDate(claimId, { date: '2026-02-01', source: 'pr_4' });
    expect((await readClaim(claimId)).p_and_s_source).toBe('pr_4');

    // QME (5) overrides PR-4.
    await pdService.setPAndSDate(claimId, { date: '2026-02-15', source: 'qme_report' });
    const final = await readClaim(claimId);
    expect(final.p_and_s_source).toBe('qme_report');
    expect(final.p_and_s_date).toBe('2026-02-15');
  });
});

describe('setPAndSDate — validation', () => {
  it('throws when date is missing', async () => {
    const claimId = await seedClaim();
    await expect(pdService.setPAndSDate(claimId, { source: 'pr_4' })).rejects.toThrow('date is required');
  });

  it('throws when source is missing', async () => {
    const claimId = await seedClaim();
    await expect(pdService.setPAndSDate(claimId, { date: '2026-02-01' })).rejects.toThrow('source is required');
  });

  it('throws on an unknown source', async () => {
    const claimId = await seedClaim();
    await expect(pdService.setPAndSDate(claimId, { date: '2026-02-01', source: 'rumor' })).rejects.toThrow('invalid P&S source');
  });

  it('throws when claim is not found', async () => {
    await expect(pdService.setPAndSDate('claim_missing', { date: '2026-02-01', source: 'pr_4' })).rejects.toThrow('not found');
  });
});
