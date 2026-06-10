'use strict';

/**
 * Tier-2 cleanup fixes: pd_weekly_rate bracket-crossing + WCIS quality
 * metrics endpoint.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const request                = require('supertest');
const app                    = require('../../src/index');
const { supabase }           = require('../../src/services/supabase');
const { _computePDWeeklyRate, PD_RATES_2026 } = require('../../src/services/pdService');
const { generateAdminToken } = require('../../src/middleware/auth');

const adminToken = generateAdminToken({ sub: 'admin-001', email: 'admin@test' });
const auth = (r) => r.set('Cookie', `token=${adminToken}`);

describe('pd_weekly_rate bracket-crossing fix', () => {
  // High AWW so the rate hits the band caps and exposes the tier choice.
  const AWW = 1500; // 2/3 = 1000, above both maxima

  it('69.75% (low band ceiling) uses the low tier cap', () => {
    expect(_computePDWeeklyRate(AWW, 69.75)).toBe(PD_RATES_2026.low.max);
  });

  it('70% uses the high tier cap', () => {
    expect(_computePDWeeklyRate(AWW, 70)).toBe(PD_RATES_2026.high.max);
  });

  it('the previously-dropped 69.76–69.99 zone now uses the high tier', () => {
    expect(_computePDWeeklyRate(AWW, 69.8)).toBe(PD_RATES_2026.high.max);
    expect(_computePDWeeklyRate(AWW, 69.99)).toBe(PD_RATES_2026.high.max);
  });

  it('low ratings still floor at the low-tier minimum', () => {
    expect(_computePDWeeklyRate(120, 10)).toBe(PD_RATES_2026.low.min); // 2/3*120=80 < 160
  });
});

describe('GET /api/v1/wcis/quality-metrics', () => {
  beforeEach(() => supabase._resetStore());

  it('computes rejection/TE rates, overdue acks, late triggers, and family breakdown', async () => {
    const base = { claim_id: 'c1', mtc_family: 'SROI', created_at: new Date().toISOString() };
    await supabase.from('wcis_transactions').insert({ ...base, id: 't1', status: 'accepted', ack_received_at: 'x' });
    await supabase.from('wcis_transactions').insert({ ...base, id: 't2', status: 'rejected', ack_received_at: 'x' });
    await supabase.from('wcis_transactions').insert({ ...base, id: 't3', status: 'accepted_with_error', ack_received_at: 'x' });
    await supabase.from('wcis_transactions').insert({ ...base, id: 't4', mtc_family: 'FROI', status: 'stub_transmitted', ack_received_at: null });
    await supabase.from('wcis_trigger_queue').insert({ id: 'q1', claim_id: 'c1', status: 'pending', deadline_date: '2020-01-01' });
    await supabase.from('wcis_claim_state').insert({ claim_id: 'c1', first_froi_accepted_at: null });

    const res = await auth(request(app).get('/api/v1/wcis/quality-metrics'));
    expect(res.status).toBe(200);
    expect(res.body.transmitted_total).toBe(4);
    expect(res.body.rejection_rate_pct).toBe(25);
    expect(res.body.te_rate_pct).toBe(25);
    expect(res.body.ack_overdue_count).toBe(1);
    expect(res.body.late_pending_triggers).toBe(1);
    expect(res.body.claims_without_accepted_froi).toBe(1);
    expect(res.body.by_mtc_family.SROI.rejected).toBe(1);
    expect(res.body.by_mtc_family.FROI.transmitted).toBe(1);
  });

  it('is admin-only and zero-safe on an empty book', async () => {
    const empty = await auth(request(app).get('/api/v1/wcis/quality-metrics'));
    expect(empty.body.rejection_rate_pct).toBe(0);
    const denied = await request(app).get('/api/v1/wcis/quality-metrics');
    expect([401, 403]).toContain(denied.status);
  });
});
