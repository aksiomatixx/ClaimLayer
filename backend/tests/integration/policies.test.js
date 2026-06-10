'use strict';

/** Integration — Carrier & Policy Modeling routes. */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const request                = require('supertest');
const app                    = require('../../src/index');
const { supabase }           = require('../../src/services/supabase');
const { generateAdminToken } = require('../../src/middleware/auth');

const adminToken = generateAdminToken({ sub: 'admin-001', email: 'admin@test' });
const auth = (r) => r.set('Cookie', `token=${adminToken}`);

beforeEach(async () => {
  supabase._resetStore();
  await supabase.from('employers').insert({ id: 'emp-1', name: 'Emp', fein: '770000001' });
});

describe('insurers + policies routes', () => {
  it('creates and lists insurers (admin only)', async () => {
    const created = await auth(request(app).post('/api/v1/insurers'))
      .send({ fein: '954000001', name: 'Pacific Compass' });
    expect(created.status).toBe(201);

    const list = await auth(request(app).get('/api/v1/insurers'));
    expect(list.status).toBe(200);
    expect(list.body.insurers).toHaveLength(1);

    const denied = await request(app).get('/api/v1/insurers');
    expect([401, 403]).toContain(denied.status);
  });

  it('rejects malformed FEIN with 400', async () => {
    const res = await auth(request(app).post('/api/v1/insurers'))
      .send({ fein: 'bad', name: 'X' });
    expect(res.status).toBe(400);
  });

  it('creates a policy and resolves it by DOI', async () => {
    const ins = (await auth(request(app).post('/api/v1/insurers'))
      .send({ fein: '954000001', name: 'Pacific' })).body.insurer;

    const pol = await auth(request(app).post('/api/v1/employers/emp-1/policies'))
      .send({ insurer_id: ins.id, policy_number: 'WC-1', effective_date: '2026-01-01', expiration_date: '2026-12-31' });
    expect(pol.status).toBe(201);

    const hit = await auth(request(app).get('/api/v1/employers/emp-1/policy-at?doi=2026-06-01'));
    expect(hit.status).toBe(200);
    expect(hit.body.policy.policy_number).toBe('WC-1');

    const miss = await auth(request(app).get('/api/v1/employers/emp-1/policy-at?doi=2027-06-01'));
    expect(miss.status).toBe(404);
  });

  it('lists policies for an employer newest-effective first', async () => {
    const ins = (await auth(request(app).post('/api/v1/insurers'))
      .send({ fein: '954000001', name: 'Pacific' })).body.insurer;
    await auth(request(app).post('/api/v1/employers/emp-1/policies'))
      .send({ insurer_id: ins.id, policy_number: 'OLD', effective_date: '2025-01-01', expiration_date: '2025-12-31' });
    await auth(request(app).post('/api/v1/employers/emp-1/policies'))
      .send({ insurer_id: ins.id, policy_number: 'NEW', effective_date: '2026-01-01' });

    const list = await auth(request(app).get('/api/v1/employers/emp-1/policies'));
    expect(list.body.policies.map(p => p.policy_number)).toEqual(['NEW', 'OLD']);
  });
});
