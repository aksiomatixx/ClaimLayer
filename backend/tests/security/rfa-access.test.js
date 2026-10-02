'use strict';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));
jest.mock('../../src/services/aiService');

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/index');
const config = require('../../src/config');
const { supabase } = require('../__mocks__/supabaseClient');

const auth = (payload) => `Bearer ${jwt.sign(payload, config.jwtSecret, { expiresIn: '1h' })}`;
const employee = auth({ sub: 'worker-a', role: 'employee', claimId: 'claim-a' });
const employer = auth({ sub: 'employer-user-a', role: 'employer', employerId: 'employer-a' });

beforeEach(async () => {
  supabase._resetStore();
  for (const suffix of ['a', 'b']) {
    await supabase.from('claims').insert({
      id: `claim-${suffix}`, employer_id: `employer-${suffix}`, tenant_id: config.tenancy.defaultTenantId,
    });
    await supabase.from('rfas').insert({
      id: `rfa-${suffix}`, claim_id: `claim-${suffix}`,
      treatment_description: `Private treatment ${suffix}`, decision: 'adjuster_review',
    });
    await supabase.from('rfa_evaluations').insert({
      id: `eval-${suffix}`, rfa_id: `rfa-${suffix}`, rationale: `Private evaluation ${suffix}`,
      evaluated_at: '2026-10-01T12:00:00.000Z',
    });
  }
});

function denied(res) {
  expect(res.status).toBe(403);
  expect(res.body).toEqual({ error: 'Access denied' });
}

describe.each([['employee', employee], ['employer', employer]])('%s RFA read access', (_role, token) => {
  test('reads the authorized claim and its evaluation', async () => {
    const single = await request(app).get('/api/v1/rfas/rfa-a').set('Authorization', token);
    expect(single.status).toBe(200);
    expect(single.body.evaluation.rationale).toBe('Private evaluation a');
    const list = await request(app).get('/api/v1/rfas?claimId=claim-a').set('Authorization', token);
    expect(list.status).toBe(200);
    expect(list.body.rfas.map(r => r.id)).toEqual(['rfa-a']);
  });

  test('cannot read another claim RFA or its evaluation', async () => {
    denied(await request(app).get('/api/v1/rfas/rfa-b').set('Authorization', token));
  });

  test.each(['', '&status=adjuster_review'])('cannot list another claim, including with a status filter: %s', async (extra) => {
    denied(await request(app).get(`/api/v1/rfas?claimId=claim-b${extra}`).set('Authorization', token));
  });

  test('does not reveal whether a guessed RFA or claim exists', async () => {
    denied(await request(app).get('/api/v1/rfas/missing').set('Authorization', token));
    denied(await request(app).get('/api/v1/rfas?claimId=missing').set('Authorization', token));
  });

  test('cannot enumerate the book with only a status filter', async () => {
    const res = await request(app).get('/api/v1/rfas?status=adjuster_review').set('Authorization', token);
    expect(res.status).toBe(403);
    expect(res.body.rfas).toBeUndefined();
  });
});

test.each(['admin', 'adjuster', 'supervisor'])('preserves existing %s claim-specific read access', async (role) => {
  const token = auth({ sub: `staff-${role}`, role });
  expect((await request(app).get('/api/v1/rfas/rfa-a').set('Authorization', token)).status).toBe(200);
  expect((await request(app).get('/api/v1/rfas?claimId=claim-a').set('Authorization', token)).status).toBe(200);
});

test.each(['admin', 'adjuster'])('preserves the %s status work queue', async (role) => {
  const res = await request(app).get('/api/v1/rfas?status=adjuster_review')
    .set('Authorization', auth({ sub: `staff-${role}`, role }));
  expect(res.status).toBe(200);
  expect(res.body.rfas).toHaveLength(2);
});

test('rejects unauthenticated reads', async () => {
  expect((await request(app).get('/api/v1/rfas/rfa-a')).status).toBe(401);
  expect((await request(app).get('/api/v1/rfas?claimId=claim-a')).status).toBe(401);
});

test('fails closed if the RFA lookup throws during authorization', async () => {
  const rfaService = require('../../src/services/rfaService');
  const lookup = jest.spyOn(rfaService, 'getRFA').mockRejectedValueOnce(new Error('synthetic read failure'));
  try {
    denied(await request(app).get('/api/v1/rfas/rfa-a').set('Authorization', employee));
  } finally {
    lookup.mockRestore();
  }
});

describe('tenant-scoped RFA staff reads', () => {
  beforeEach(async () => {
    await supabase.from('claims').insert({ id: 'claim-other-tenant', tenant_id: 'other-tenant' });
    await supabase.from('rfas').insert({
      id: 'rfa-other-tenant', claim_id: 'claim-other-tenant', decision: 'adjuster_review',
      // Deliberately wrong child metadata: access follows the parent claim.
      tenant_id: config.tenancy.defaultTenantId,
    });
  });

  test.each(['admin', 'adjuster', 'supervisor'])('%s can read its own tenant but not another tenant', async (role) => {
    const token = auth({ sub: `tenant-staff-${role}`, role, tenantId: config.tenancy.defaultTenantId });
    expect((await request(app).get('/api/v1/rfas/rfa-a').set('Authorization', token)).status).toBe(200);
    expect((await request(app).get('/api/v1/rfas?claimId=claim-a').set('Authorization', token)).status).toBe(200);
    denied(await request(app).get('/api/v1/rfas/rfa-other-tenant').set('Authorization', token));
    denied(await request(app).get('/api/v1/rfas?claimId=claim-other-tenant').set('Authorization', token));
    denied(await request(app).get('/api/v1/rfas/missing').set('Authorization', token));
  });

  test.each(['admin', 'adjuster'])('%s status queue follows parent-claim tenancy', async (role) => {
    const token = auth({ sub: `tenant-staff-${role}`, role, tenantId: config.tenancy.defaultTenantId });
    const response = await request(app).get('/api/v1/rfas?status=adjuster_review').set('Authorization', token);
    expect(response.status).toBe(200);
    expect(response.body.rfas.map(rfa => rfa.id).sort()).toEqual(['rfa-a', 'rfa-b']);

    const other = await request(app).get('/api/v1/rfas?status=adjuster_review')
      .set('Authorization', auth({ sub: 'other-staff', role, tenantId: 'other-tenant' }));
    expect(other.status).toBe(200);
    expect(other.body.rfas.map(rfa => rfa.id)).toEqual(['rfa-other-tenant']);
  });

  test('a tenant with no claims receives an empty status queue', async () => {
    const response = await request(app).get('/api/v1/rfas?status=adjuster_review')
      .set('Authorization', auth({ sub: 'empty-staff', role: 'admin', tenantId: 'empty-tenant' }));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rfas: [], count: 0 });
  });

  test.each(['admin', 'adjuster', 'supervisor'])('legacy %s tokens are confined to the default tenant', async (role) => {
    const token = auth({ sub: 'legacy-staff', role });
    denied(await request(app).get('/api/v1/rfas/rfa-other-tenant').set('Authorization', token));
    denied(await request(app).get('/api/v1/rfas?claimId=claim-other-tenant').set('Authorization', token));
  });

  test.each(['admin', 'adjuster', 'supervisor', 'employer'])('fails closed for %s when the database returns an ownership error', async (role) => {
    const original = supabase.from.bind(supabase);
    const lookup = jest.spyOn(supabase, 'from').mockImplementation(table => {
      const builder = original(table);
      if (table === 'claims') builder.single = async () => ({ data: null, error: { code: '08006', message: 'connection failure' } });
      return builder;
    });
    try {
      denied(await request(app).get('/api/v1/rfas/rfa-a')
        .set('Authorization', auth({ sub: 'lookup-test', role, employerId: 'employer-a', tenantId: config.tenancy.defaultTenantId })));
    } finally {
      lookup.mockRestore();
    }
  });

  test('fails closed if the parent ownership lookup throws', async () => {
    const original = supabase.from.bind(supabase);
    const lookup = jest.spyOn(supabase, 'from').mockImplementation(table => {
      if (table === 'claims') throw new Error('synthetic ownership failure');
      return original(table);
    });
    try {
      denied(await request(app).get('/api/v1/rfas/rfa-a').set('Authorization', employer));
    } finally {
      lookup.mockRestore();
    }
  });
});
