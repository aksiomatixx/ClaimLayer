'use strict';

/**
 * Integration tests — /api/v1/integrations/* (legacy claims adapter layer).
 *
 * Covers:
 *   - GET  /integrations/systems
 *   - POST /integrations/:system/migrate (incl. idempotency)
 *   - GET  /integrations/migrated
 *   - GET  /integrations/:system/legacy-record/:externalId
 *   - Round trip: migrate a legacy claim → updateStatus pushes a
 *     legacy_updates row → legacy-record endpoint surfaces it
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));
jest.mock('../../src/services/filehandler', () => ({
  setReserves:    jest.fn().mockResolvedValue({ status: 'ok' }),
  createClaim:    jest.fn().mockResolvedValue({ claimId: 'fh_mock', status: 'created' }),
  createDiary:    jest.fn().mockResolvedValue({ diaryId: 'diy_mock', status: 'created' }),
  completeDiary:  jest.fn().mockResolvedValue({ status: 'completed' }),
  attachDocument: jest.fn().mockResolvedValue({ documentId: 'doc_mock' }),
  getLedger:      jest.fn().mockResolvedValue({ entries: [] }),
}));

const request                = require('supertest');
const app                    = require('../../src/index');
const { supabase }           = require('../../src/services/supabase');
const { generateAdminToken } = require('../../src/middleware/auth');
const claimService           = require('../../src/services/claimService');

const adminToken = generateAdminToken({ sub: 'admin-int-001', email: 'admin@homecaretpa.com' });

beforeEach(() => { supabase._resetStore(); claimService._resetClaims(); });

async function seedLegacy(id, overrides = {}) {
  await supabase.from('legacy_claims').insert({
    external_id:   id,
    claimant_name: overrides.claimant_name || `Claimant ${id}`,
    employer_name: overrides.employer_name || 'BrightCare HH',
    doi:           overrides.doi           || '2026-03-01',
    body_part:     overrides.body_part     || 'Shoulder',
    status:        overrides.status        || 'open',
    raw:           overrides.raw           || { injury_type: 'Strain / Sprain' },
  });
}

// ── GET /api/v1/integrations/systems ─────────────────────────────────────────
describe('GET /api/v1/integrations/systems', () => {
  it('401 without admin token', async () => {
    const res = await request(app).get('/api/v1/integrations/systems');
    expect(res.status).toBe(401);
  });

  it('lists both systems with health + claim_count for admin', async () => {
    await seedLegacy('LEG-S1');
    await supabase.from('claims').insert({
      id: 'native-1', source_system: 'native',
    });
    await supabase.from('claims').insert({
      id: 'leg-1', source_system: 'mock_legacy', external_claim_id: 'LEG-OLD',
    });
    const res = await request(app)
      .get('/api/v1/integrations/systems')
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.systems)).toBe(true);
    expect(res.body.systems).toHaveLength(2);
    const mock = res.body.systems.find(s => s.system === 'mock_legacy');
    expect(mock.health.ok).toBe(true);
    expect(mock.claim_count).toBe(1);
    const a1 = res.body.systems.find(s => s.system === 'a1_tracker');
    expect(a1.health.ok).toBe(true);
  });
});

// ── POST /api/v1/integrations/:system/migrate ────────────────────────────────
describe('POST /api/v1/integrations/:system/migrate', () => {
  it('401 without admin token', async () => {
    const res = await request(app).post('/api/v1/integrations/mock_legacy/migrate');
    expect(res.status).toBe(401);
  });

  it('migrates un-migrated legacy claims and returns counts', async () => {
    await seedLegacy('LEG-M1');
    await seedLegacy('LEG-M2');
    const res = await request(app)
      .post('/api/v1/integrations/mock_legacy/migrate')
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.migrated).toBe(2);
    expect(res.body.skipped).toBe(0);
    expect(res.body.ids).toEqual(expect.arrayContaining([
      'claim_legacy_LEG-M1', 'claim_legacy_LEG-M2',
    ]));
  });

  it('is idempotent — second migrate skips already-migrated rows', async () => {
    await seedLegacy('LEG-IDEMP');
    await request(app).post('/api/v1/integrations/mock_legacy/migrate').set('Cookie', `token=${adminToken}`);
    const second = await request(app).post('/api/v1/integrations/mock_legacy/migrate').set('Cookie', `token=${adminToken}`);
    expect(second.status).toBe(200);
    expect(second.body.migrated).toBe(0);
  });

  it('400 for unknown source system', async () => {
    const res = await request(app)
      .post('/api/v1/integrations/not_a_real_system/migrate')
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(400);
  });
});

// ── GET /api/v1/integrations/migrated ────────────────────────────────────────
describe('GET /api/v1/integrations/migrated', () => {
  it('returns claims with source_system <> native', async () => {
    await seedLegacy('LEG-LIST-A');
    await request(app).post('/api/v1/integrations/mock_legacy/migrate').set('Cookie', `token=${adminToken}`);
    await supabase.from('claims').insert({ id: 'native-x', source_system: 'native' });

    const res = await request(app)
      .get('/api/v1/integrations/migrated')
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.claims[0].external_claim_id).toBe('LEG-LIST-A');
  });
});

// ── GET /api/v1/integrations/:system/legacy-record/:externalId ──────────────
describe('GET /api/v1/integrations/mock_legacy/legacy-record/:externalId', () => {
  it('returns legacy record + diaries + documents + updates', async () => {
    await seedLegacy('LEG-REC-1');
    await supabase.from('legacy_diaries').insert({
      external_claim_id: 'LEG-REC-1', type: 'X', due_date: '2026-04-01',
    });
    await supabase.from('legacy_documents').insert({
      external_claim_id: 'LEG-REC-1', doc_type: 'PR2', title: 'PR-2',
    });
    await supabase.from('legacy_updates').insert({
      external_claim_id: 'LEG-REC-1', field: 'status',
      old_value: 'open', new_value: 'in_progress',
    });

    const res = await request(app)
      .get('/api/v1/integrations/mock_legacy/legacy-record/LEG-REC-1')
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.legacy_claim.external_id).toBe('LEG-REC-1');
    expect(res.body.diaries).toHaveLength(1);
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.updates).toHaveLength(1);
    expect(res.body.updates[0].field).toBe('status');
  });

  it('400 for non-mock systems (introspection limited to mock_legacy)', async () => {
    const res = await request(app)
      .get('/api/v1/integrations/a1_tracker/legacy-record/foo')
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(400);
  });
});

// ── Round-trip: migrate → updateStatus → legacy_updates row appears ─────────
describe('round-trip (migrate → write-back → introspect)', () => {
  it('updateStatus on a migrated claim pushes a legacy_updates row', async () => {
    await seedLegacy('LEG-RT-1', { status: 'open' });
    const migrate = await request(app)
      .post('/api/v1/integrations/mock_legacy/migrate')
      .set('Cookie', `token=${adminToken}`);
    expect(migrate.body.migrated).toBe(1);

    // Trigger a status change (intake_complete → under_investigation)
    const claimId = 'claim_legacy_LEG-RT-1';
    await claimService.updateStatus(claimId, 'under_investigation', 'adjuster@test');

    // Allow the setImmediate write-back to drain.
    await new Promise(r => setImmediate(r));
    await new Promise(r => setTimeout(r, 20));

    const res = await request(app)
      .get('/api/v1/integrations/mock_legacy/legacy-record/LEG-RT-1')
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.updates.length).toBeGreaterThanOrEqual(1);
    const statusUpdate = res.body.updates.find(u => u.field === 'status');
    expect(statusUpdate).toBeDefined();
    expect(statusUpdate.new_value).toBe('under_investigation');
  });
});
