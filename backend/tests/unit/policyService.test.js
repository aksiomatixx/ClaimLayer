'use strict';

/**
 * Unit tests — Carrier & Policy Modeling (policyService).
 *
 * Covers: insurer/policy validation, DOI-interval policy resolution
 * (incl. open-ended policies, carrier change mid-year, overlap
 * tiebreak), and the WCIS insurer-context preference order.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const policyService = require('../../src/services/policyService');

const EMPLOYER = 'employer-test-001';

beforeEach(async () => {
  supabase._resetStore();
  await supabase.from('employers').insert({ id: EMPLOYER, name: 'Test Employer', fein: '770000001' });
});

async function seedInsurer(fein = '954000001', name = 'Pacific Compass') {
  return policyService.createInsurer({ fein, name });
}

describe('createInsurer', () => {
  it('creates with valid FEIN', async () => {
    const ins = await seedInsurer();
    expect(ins.id).toMatch(/^ins_/);
    expect(ins.fein).toBe('954000001');
    expect(ins.active).toBe(true);
  });

  it('rejects malformed FEIN', async () => {
    await expect(policyService.createInsurer({ fein: '12-3456789', name: 'X' }))
      .rejects.toThrow('fein must be 9 digits');
  });
});

describe('createPolicy', () => {
  it('creates a carried policy', async () => {
    const ins = await seedInsurer();
    const pol = await policyService.createPolicy({
      employer_id: EMPLOYER, insurer_id: ins.id, policy_number: 'WC-1',
      effective_date: '2026-01-01', expiration_date: '2026-12-31',
    });
    expect(pol.insurer_id).toBe(ins.id);
    expect(pol.self_insured).toBe(false);
  });

  it('creates a self-insured policy with no carrier', async () => {
    const pol = await policyService.createPolicy({
      employer_id: EMPLOYER, policy_number: 'SI-1',
      effective_date: '2026-01-01', self_insured: true,
    });
    expect(pol.insurer_id).toBeNull();
    expect(pol.self_insured).toBe(true);
  });

  it('rejects a carried policy without insurer_id', async () => {
    await expect(policyService.createPolicy({
      employer_id: EMPLOYER, policy_number: 'WC-1', effective_date: '2026-01-01',
    })).rejects.toThrow('insurer_id is required');
  });

  it('rejects expiration before effective', async () => {
    const ins = await seedInsurer();
    await expect(policyService.createPolicy({
      employer_id: EMPLOYER, insurer_id: ins.id, policy_number: 'WC-1',
      effective_date: '2026-06-01', expiration_date: '2026-01-01',
    })).rejects.toThrow('expiration_date');
  });

  it('rejects unknown employer and unknown insurer', async () => {
    const ins = await seedInsurer();
    await expect(policyService.createPolicy({
      employer_id: 'nope', insurer_id: ins.id, policy_number: 'X', effective_date: '2026-01-01',
    })).rejects.toThrow('Employer not found');
    await expect(policyService.createPolicy({
      employer_id: EMPLOYER, insurer_id: 'nope', policy_number: 'X', effective_date: '2026-01-01',
    })).rejects.toThrow('Insurer not found');
  });
});

describe('resolvePolicy — DOI interval logic', () => {
  it('resolves the policy whose interval contains the DOI (carrier change mid-year)', async () => {
    const a = await seedInsurer('954000001', 'Carrier A');
    const b = await seedInsurer('954000002', 'Carrier B');
    await policyService.createPolicy({
      employer_id: EMPLOYER, insurer_id: a.id, policy_number: 'A-1',
      effective_date: '2026-01-01', expiration_date: '2026-06-30',
    });
    await policyService.createPolicy({
      employer_id: EMPLOYER, insurer_id: b.id, policy_number: 'B-1',
      effective_date: '2026-07-01', expiration_date: '2027-06-30',
    });

    const before = await policyService.resolvePolicy(EMPLOYER, '2026-03-15');
    const after  = await policyService.resolvePolicy(EMPLOYER, '2026-08-15');
    expect(before.policy_number).toBe('A-1');
    expect(after.policy_number).toBe('B-1');
  });

  it('matches an open-ended policy for any later DOI', async () => {
    await policyService.createPolicy({
      employer_id: EMPLOYER, policy_number: 'SI-1',
      effective_date: '2025-01-01', self_insured: true,
    });
    const pol = await policyService.resolvePolicy(EMPLOYER, '2026-06-10');
    expect(pol.policy_number).toBe('SI-1');
  });

  it('returns null when nothing is in force (no throw)', async () => {
    await policyService.createPolicy({
      employer_id: EMPLOYER, policy_number: 'SI-1',
      effective_date: '2026-01-01', expiration_date: '2026-01-31', self_insured: true,
    });
    expect(await policyService.resolvePolicy(EMPLOYER, '2026-06-10')).toBeNull();
    expect(await policyService.resolvePolicy(EMPLOYER, '2025-12-31')).toBeNull();
  });

  it('on overlap, prefers the most recently effective policy', async () => {
    const a = await seedInsurer();
    await policyService.createPolicy({
      employer_id: EMPLOYER, insurer_id: a.id, policy_number: 'OLD',
      effective_date: '2026-01-01', expiration_date: '2026-12-31',
    });
    await policyService.createPolicy({
      employer_id: EMPLOYER, insurer_id: a.id, policy_number: 'NEW',
      effective_date: '2026-03-01', expiration_date: '2026-12-31',
    });
    const pol = await policyService.resolvePolicy(EMPLOYER, '2026-06-15');
    expect(pol.policy_number).toBe('NEW');
  });
});

describe('insurerContextForClaim — WCIS preference', () => {
  it('returns carrier FEIN from the resolved policy', async () => {
    const ins = await seedInsurer('954000009', 'Carrier');
    const pol = await policyService.createPolicy({
      employer_id: EMPLOYER, insurer_id: ins.id, policy_number: 'WC-9',
      effective_date: '2026-01-01',
    });
    const ctx = await policyService.insurerContextForClaim({
      policy_id: pol.id, employer_id: EMPLOYER,
    });
    expect(ctx.insurer_fein).toBe('954000009');
    expect(ctx.source).toBe('policy');
  });

  it('self-insured policy: employer FEIN is both insurer and administrator', async () => {
    const pol = await policyService.createPolicy({
      employer_id: EMPLOYER, policy_number: 'SI-9',
      effective_date: '2026-01-01', self_insured: true,
    });
    const ctx = await policyService.insurerContextForClaim({
      policy_id: pol.id, employer_id: EMPLOYER,
    });
    expect(ctx.insurer_fein).toBe('770000001');
    expect(ctx.claim_administrator_fein).toBe('770000001');
    expect(ctx.source).toBe('policy_self_insured');
  });

  it('returns null when claim has no policy (caller falls back to employer row)', async () => {
    const ctx = await policyService.insurerContextForClaim({
      policy_id: null, employer_id: EMPLOYER,
    });
    expect(ctx).toBeNull();
  });
});
