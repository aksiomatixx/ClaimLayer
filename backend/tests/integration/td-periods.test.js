'use strict';

/**
 * Integration tests — TD period routes.
 *
 *   GET    /api/v1/claims/:claimId/td-periods
 *   GET    /api/v1/claims/:claimId/td-summary
 *   POST   /api/v1/claims/:claimId/td-periods
 *   PATCH  /api/v1/td-periods/:id/close
 *   PATCH  /api/v1/td-periods/:id/reinstate
 *   PATCH  /api/v1/td-periods/:id
 *
 * Also asserts GET /api/v1/claims (the list) inlines td_summary per
 * row so the AdminDashboard columns can render without a fan-out.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const request                = require('supertest');
const app                    = require('../../src/index');
const { supabase }           = require('../../src/services/supabase');
const { generateAdminToken } = require('../../src/middleware/auth');

jest.mock('../../src/services/aiService', () => ({
  analyzeCompensability: jest.fn(),
  evaluateRFA: jest.fn(),
}));
jest.mock('../../src/services/filehandler', () => ({
  setReserves:   jest.fn().mockResolvedValue({ status: 'ok' }),
  createClaim:   jest.fn().mockResolvedValue({ claimId: 'fh_mock', status: 'created' }),
  createDiary:   jest.fn().mockResolvedValue({ diaryId: 'diy_mock' }),
  completeDiary: jest.fn().mockResolvedValue({ status: 'completed' }),
  attachDocument: jest.fn().mockResolvedValue({ documentId: 'doc_mock' }),
  getLedger:      jest.fn().mockResolvedValue({ entries: [] }),
  recordPayment:  jest.fn().mockResolvedValue({ paymentId: 'pay_mock' }),
}));
jest.mock('../../src/services/adp', () => ({
  getEmployeeWithFinancials: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../src/services/lobService', () => ({
  sendLetter: jest.fn().mockResolvedValue({ letterId: 'ltr_mock', status: 'queued' }),
}));

const adminToken = generateAdminToken({ sub: 'admin-001', email: 'admin@homecaretpa.com' });

async function seedClaim(id = 'claim_td_int') {
  await supabase.from('claims').insert({
    id,
    claim_number: 'HHW-2026-TD',
    employer_id: 'employer-brightcare-001',
    status: 'active_medical',
    employee: { firstName: 'Maria', lastName: 'Santos' },
    aww: 750.75, td_rate: 500.50,
    date_of_injury: '2025-06-15',
    body_part: 'Lumbar Spine',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return id;
}

beforeEach(() => {
  supabase._resetStore();
});

// ═════════════════════════════════════════════════════════════════════════════
// GET td-periods + td-summary
// ═════════════════════════════════════════════════════════════════════════════
describe('GET routes', () => {
  it('GET td-periods empty → []', async () => {
    const claimId = await seedClaim();
    const res = await request(app)
      .get(`/api/v1/claims/${claimId}/td-periods`)
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.periods).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  it('GET td-periods populated → ordered by start_date DESC', async () => {
    const claimId = await seedClaim();
    await supabase.from('td_periods').insert([
      { id: 'tdp_old', claim_id: claimId, benefit_type: 'TTD', start_date: '2025-07-01', end_date: '2025-08-01', weekly_rate: 500, reason_started: 'initial_disability', reason_ended: 'rtw_full', created_at: new Date().toISOString() },
      { id: 'tdp_new', claim_id: claimId, benefit_type: 'TTD', start_date: '2025-09-01', end_date: null,         weekly_rate: 525, reason_started: 'reinstatement',     created_at: new Date().toISOString() },
    ]);
    const res = await request(app)
      .get(`/api/v1/claims/${claimId}/td-periods`)
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.periods.length).toBe(2);
    expect(res.body.periods[0].id).toBe('tdp_new');
  });

  it('GET td-summary empty', async () => {
    const claimId = await seedClaim();
    const res = await request(app)
      .get(`/api/v1/claims/${claimId}/td-summary`)
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.active).toBeNull();
    expect(res.body.total_weeks_paid).toBe(0);
    expect(res.body.statutory_cap_weeks).toBe(104);
    expect(res.body.weeks_remaining).toBe(104);
  });

  it('GET td-summary populated', async () => {
    const claimId = await seedClaim();
    await supabase.from('td_periods').insert({
      id: 'tdp_one', claim_id: claimId, benefit_type: 'TTD',
      start_date: '2025-07-01', end_date: '2025-07-14',
      weekly_rate: 500, reason_started: 'initial_disability', reason_ended: 'rtw_full',
      created_at: new Date().toISOString(),
    });
    const res = await request(app)
      .get(`/api/v1/claims/${claimId}/td-summary`)
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total_weeks_paid).toBe(2);
    expect(res.body.total_indemnity_paid).toBe(1000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// POST create
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/claims/:claimId/td-periods', () => {
  it('happy path → 201', async () => {
    const claimId = await seedClaim();
    const res = await request(app)
      .post(`/api/v1/claims/${claimId}/td-periods`)
      .set('Cookie', `token=${adminToken}`)
      .send({ benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 500.50, reason_started: 'initial_disability' });
    expect(res.status).toBe(201);
    expect(res.body.benefit_type).toBe('TTD');
    expect(Number(res.body.weekly_rate)).toBe(500.50);
  });

  it('400 on validation failure (bad benefit_type)', async () => {
    const claimId = await seedClaim();
    const res = await request(app)
      .post(`/api/v1/claims/${claimId}/td-periods`)
      .set('Cookie', `token=${adminToken}`)
      .send({ benefit_type: 'NONSENSE', start_date: '2025-07-01', weekly_rate: 500 });
    expect(res.status).toBe(400);
  });

  it('400 (or 500) on missing required field — express-validator catches', async () => {
    const claimId = await seedClaim();
    const res = await request(app)
      .post(`/api/v1/claims/${claimId}/td-periods`)
      .set('Cookie', `token=${adminToken}`)
      .send({ start_date: '2025-07-01', weekly_rate: 500 });
    expect(res.status).toBe(400);
  });

  it('500 (Claim not found surfaces from service) when claim does not exist', async () => {
    const res = await request(app)
      .post(`/api/v1/claims/nonexistent/td-periods`)
      .set('Cookie', `token=${adminToken}`)
      .send({ benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 500 });
    // Service throws "Claim not found" → mapped to 404 by route.
    expect(res.status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PATCH close
// ═════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/v1/td-periods/:id/close', () => {
  async function seedActive(claimId) {
    const id = 'tdp_close_' + Date.now();
    await supabase.from('td_periods').insert({
      id, claim_id: claimId, benefit_type: 'TTD',
      start_date: '2025-07-01', end_date: null,
      weekly_rate: 500, reason_started: 'initial_disability',
      created_at: new Date().toISOString(),
    });
    return id;
  }

  it('happy path', async () => {
    const claimId = await seedClaim();
    const id = await seedActive(claimId);
    const res = await request(app)
      .patch(`/api/v1/td-periods/${id}/close`)
      .set('Cookie', `token=${adminToken}`)
      .send({ end_date: '2025-09-01', reason_ended: 'rtw_full' });
    expect(res.status).toBe(200);
    expect(res.body.end_date).toBe('2025-09-01');
    expect(res.body.reason_ended).toBe('rtw_full');
  });

  it('409 on already-closed', async () => {
    const claimId = await seedClaim();
    const id = await seedActive(claimId);
    await request(app).patch(`/api/v1/td-periods/${id}/close`).set('Cookie', `token=${adminToken}`)
      .send({ end_date: '2025-09-01', reason_ended: 'rtw_full' });
    const res = await request(app).patch(`/api/v1/td-periods/${id}/close`).set('Cookie', `token=${adminToken}`)
      .send({ end_date: '2025-09-15', reason_ended: 'mmi_reached' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PERIOD_ALREADY_CLOSED');
  });

  it('404 on missing period', async () => {
    const res = await request(app).patch(`/api/v1/td-periods/nonexistent/close`).set('Cookie', `token=${adminToken}`)
      .send({ end_date: '2025-09-01', reason_ended: 'rtw_full' });
    expect(res.status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PATCH reinstate
// ═════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/v1/td-periods/:id/reinstate', () => {
  async function seedClosed(claimId) {
    const id = 'tdp_reinst_' + Date.now() + '_' + Math.random().toString(36).slice(2,5);
    await supabase.from('td_periods').insert({
      id, claim_id: claimId, benefit_type: 'TTD',
      start_date: '2025-07-01', end_date: '2025-09-01',
      weekly_rate: 500, reason_started: 'initial_disability', reason_ended: 'rtw_full',
      created_at: new Date().toISOString(),
    });
    return id;
  }

  it('happy path → 201, sets reinstated_from_period_id', async () => {
    const claimId = await seedClaim();
    const sourceId = await seedClosed(claimId);
    const res = await request(app)
      .patch(`/api/v1/td-periods/${sourceId}/reinstate`)
      .set('Cookie', `token=${adminToken}`)
      .send({ start_date: '2025-10-01', weekly_rate: 525 });
    expect(res.status).toBe(201);
    expect(res.body.reinstated_from_period_id).toBe(sourceId);
    expect(res.body.reason_started).toBe('reinstatement');
  });

  it('409 when an active period already exists', async () => {
    const claimId = await seedClaim();
    const sourceId = await seedClosed(claimId);
    // Create an active period
    await supabase.from('td_periods').insert({
      id: 'tdp_active', claim_id: claimId, benefit_type: 'TTD',
      start_date: '2025-10-01', end_date: null,
      weekly_rate: 525, reason_started: 'reinstatement',
      created_at: new Date().toISOString(),
    });
    const res = await request(app)
      .patch(`/api/v1/td-periods/${sourceId}/reinstate`)
      .set('Cookie', `token=${adminToken}`)
      .send({ start_date: '2025-11-01', weekly_rate: 525 });
    expect(res.status).toBe(409);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PATCH metadata
// ═════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/v1/td-periods/:id (metadata only)', () => {
  it('happy path', async () => {
    const claimId = await seedClaim();
    await supabase.from('td_periods').insert({
      id: 'tdp_meta', claim_id: claimId, benefit_type: 'TTD',
      start_date: '2025-07-01', end_date: null,
      weekly_rate: 500, reason_started: 'initial_disability',
      created_at: new Date().toISOString(),
    });
    const res = await request(app)
      .patch(`/api/v1/td-periods/tdp_meta`)
      .set('Cookie', `token=${adminToken}`)
      .send({ notes: 'updated note', suspension_reason_code: 'S1' });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe('updated note');
    expect(res.body.suspension_reason_code).toBe('S1');
  });

  // The route handler explicitly forwards only {notes,
  // suspension_reason_code} to the service, so any structural
  // field in the body is silently dropped (defense in depth — the
  // unit-test suite covers the service-level reject path directly).
  it('silently drops forbidden structural fields — start_date stays unchanged', async () => {
    const claimId = await seedClaim();
    await supabase.from('td_periods').insert({
      id: 'tdp_meta2', claim_id: claimId, benefit_type: 'TTD',
      start_date: '2025-07-01', end_date: null,
      weekly_rate: 500, reason_started: 'initial_disability',
      created_at: new Date().toISOString(),
    });
    const res = await request(app)
      .patch(`/api/v1/td-periods/tdp_meta2`)
      .set('Cookie', `token=${adminToken}`)
      .send({ start_date: '2025-08-01', notes: 'meta only' });
    expect(res.status).toBe(200);
    expect(res.body.start_date).toBe('2025-07-01');   // unchanged
    expect(res.body.notes).toBe('meta only');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Auth — every route 401 without token
// ═════════════════════════════════════════════════════════════════════════════
describe('Auth (no token)', () => {
  it('all 6 routes return 401 without admin token', async () => {
    const calls = [
      ['get',   '/api/v1/claims/x/td-periods'],
      ['get',   '/api/v1/claims/x/td-summary'],
      ['post',  '/api/v1/claims/x/td-periods'],
      ['patch', '/api/v1/td-periods/x/close'],
      ['patch', '/api/v1/td-periods/x/reinstate'],
      ['patch', '/api/v1/td-periods/x'],
    ];
    for (const [method, url] of calls) {
      const res = await request(app)[method](url).send({});
      expect(res.status).toBe(401);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/v1/claims inlines td_summary per row
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/v1/claims includes td_summary inline', () => {
  it('every claim row carries a td_summary object', async () => {
    const claimId = await seedClaim('claim_list_one');
    await supabase.from('td_periods').insert({
      id: 'tdp_list', claim_id: claimId, benefit_type: 'TPD',
      start_date: '2025-07-01', end_date: null,
      weekly_rate: 312, reason_started: 'initial_disability',
      created_at: new Date().toISOString(),
    });
    const res = await request(app)
      .get('/api/v1/claims')
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    const c = res.body.claims.find(x => x.id === claimId);
    expect(c).toBeTruthy();
    expect(c.td_summary).toBeTruthy();
    expect(c.td_summary.active.benefit_type).toBe('TPD');
    expect(c.td_summary.statutory_cap_weeks).toBe(104);
  });
});
