'use strict';

/**
 * Integration tests — demo seed + reset.
 *
 * Verifies:
 *   - seedDemo creates exactly 8 claims
 *   - all 7 distinct lifecycle statuses are represented
 *   - every seeded claim carries metadata.demo === true
 *   - re-running seedDemo is idempotent (still 8, same IDs)
 *   - POST /api/v1/admin/demo-reset wipes + re-seeds
 *   - POST /api/v1/admin/demo-reset returns 403 in production
 *   - GET  /api/v1/admin/demo-status reflects the demo flag
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const request                = require('supertest');
const app                    = require('../../src/index');
const { supabase }           = require('../../src/services/supabase');
const { generateAdminToken } = require('../../src/middleware/auth');
const { seedDemo, wipeDemo, LIFECYCLE_PLANS,
        makeClaimId }         = require('../../src/scripts/seedDemo');

jest.mock('../../src/services/aiService',     () => ({ analyzeCompensability: jest.fn(), evaluateRFA: jest.fn() }));
jest.mock('../../src/services/filehandler',   () => ({
  setReserves: jest.fn().mockResolvedValue({ status: 'ok' }),
  createClaim: jest.fn().mockResolvedValue({ claimId: 'fh_mock', status: 'created' }),
  createDiary: jest.fn(), completeDiary: jest.fn(), attachDocument: jest.fn(),
  getLedger: jest.fn().mockResolvedValue({ entries: [] }),
  recordPayment: jest.fn(),
}));
jest.mock('../../src/services/adp', () => ({ getEmployeeWithFinancials: jest.fn().mockResolvedValue({}) }));
jest.mock('../../src/services/lobService', () => ({ sendLetter: jest.fn().mockResolvedValue({ letterId: 'ltr_mock' }) }));

const adminToken = generateAdminToken({ sub: 'admin-001', email: 'admin@homecaretpa.com' });

beforeEach(() => {
  supabase._resetStore();
});

// ═════════════════════════════════════════════════════════════════════════════
// seedDemo (direct service call)
// ═════════════════════════════════════════════════════════════════════════════
describe('seedDemo', () => {
  it('creates exactly 8 claims with deterministic IDs', async () => {
    const out = await seedDemo();
    expect(out.count).toBe(8);
    expect(out.ids).toHaveLength(8);
    expect(out.ids[0]).toBe('claim_demo_001');
    expect(out.ids[7]).toBe('claim_demo_008');

    const { data: rows } = await supabase.from('claims').select('*');
    expect(rows).toHaveLength(8);
  });

  it('every seeded claim has metadata.demo === true', async () => {
    await seedDemo();
    const { data: rows } = await supabase.from('claims').select('*');
    for (const r of rows) {
      expect(r.metadata).toBeTruthy();
      expect(r.metadata.demo).toBe(true);
    }
  });

  it('all distinct lifecycle statuses are represented', async () => {
    await seedDemo();
    const { data: rows } = await supabase.from('claims').select('*');
    const statuses = new Set(rows.map(r => r.status));
    const expected = new Set(LIFECYCLE_PLANS.map(p => p.status));
    for (const s of expected) {
      expect(statuses.has(s)).toBe(true);
    }
  });

  it('is idempotent — re-running yields the same 8 IDs', async () => {
    const a = await seedDemo();
    const b = await seedDemo();
    expect(b.count).toBe(8);
    expect(b.ids).toEqual(a.ids);
    const { data: rows } = await supabase.from('claims').select('*');
    expect(rows).toHaveLength(8);
  });

  it('writes claim_events and diaries per plan', async () => {
    await seedDemo();
    const { data: events }  = await supabase.from('claim_events').select('*').eq('claim_id', makeClaimId(0));
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', makeClaimId(0));
    expect(events.length).toBeGreaterThan(0);
    expect(diaries.length).toBeGreaterThan(0);
  });

  it('writes pd_evaluations only for pd_evaluation + settlement_discussions claims', async () => {
    await seedDemo();
    const { data: pds } = await supabase.from('pd_evaluations').select('*');
    expect(pds.length).toBe(2);
    expect(pds.every(p => p.pd_total_value > 0)).toBe(true);
  });

  it('writes a settlement_offers row only for the settlement_discussions claim', async () => {
    await seedDemo();
    const { data: offers } = await supabase.from('settlement_offers').select('*');
    expect(offers.length).toBe(1);
    expect(offers[0].cnr_value).toBeGreaterThan(offers[0].stip_value);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// wipeDemo
// ═════════════════════════════════════════════════════════════════════════════
describe('wipeDemo', () => {
  it('removes seeded claims and child rows', async () => {
    await seedDemo();
    await wipeDemo();
    const { data: rows }   = await supabase.from('claims').select('*');
    const { data: diaries }= await supabase.from('diaries').select('*');
    const { data: pds }    = await supabase.from('pd_evaluations').select('*');
    expect(rows).toHaveLength(0);
    expect(diaries).toHaveLength(0);
    expect(pds).toHaveLength(0);
  });

  it('does not error when no demo data exists', async () => {
    await expect(wipeDemo()).resolves.toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/v1/admin/demo-reset
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/admin/demo-reset', () => {
  it('happy path — wipes + re-seeds, returns count 8', async () => {
    await seedDemo();
    const res = await request(app)
      .post('/api/v1/admin/demo-reset')
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(8);

    const { data: rows } = await supabase.from('claims').select('*');
    expect(rows).toHaveLength(8);
  });

  it('401 without admin token', async () => {
    const res = await request(app).post('/api/v1/admin/demo-reset');
    expect(res.status).toBe(401);
  });

  it('403 when NODE_ENV=production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await request(app)
        .post('/api/v1/admin/demo-reset')
        .set('Cookie', `token=${adminToken}`);
      expect(res.status).toBe(403);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/v1/admin/demo-status
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/v1/admin/demo-status', () => {
  it('reports demo=false when nothing seeded', async () => {
    const res = await request(app).get('/api/v1/admin/demo-status').set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.demo).toBe(false);
    expect(res.body.count).toBe(0);
  });

  it('reports demo=true and count=8 after seed', async () => {
    await seedDemo();
    const res = await request(app).get('/api/v1/admin/demo-status').set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.demo).toBe(true);
    expect(res.body.count).toBe(8);
  });
});
