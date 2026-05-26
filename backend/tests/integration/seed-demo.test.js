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

    // 8 from LIFECYCLE_PLANS + 1 pre-migrated legacy example (LEG-000).
    const { data: rows } = await supabase.from('claims').select('*');
    expect(rows).toHaveLength(9);
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
    // 8 lifecycle-plan claims + 1 pre-migrated legacy example (LEG-000).
    const { data: rows } = await supabase.from('claims').select('*');
    expect(rows).toHaveLength(9);
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
// td_periods seeding
// ═════════════════════════════════════════════════════════════════════════════
describe('td_periods seeding', () => {
  async function tdFor(claimId) {
    const { data } = await supabase.from('td_periods').select('*').eq('claim_id', claimId);
    return (data || []).sort((a, b) => a.start_date.localeCompare(b.start_date));
  }

  it('claim_demo_004 has exactly 1 active TTD period', async () => {
    await seedDemo();
    const periods = await tdFor(makeClaimId(3));
    expect(periods).toHaveLength(1);
    expect(periods[0].benefit_type).toBe('TTD');
    expect(periods[0].end_date).toBeNull();
    expect(periods[0].reason_started).toBe('initial_disability');
  });

  it('claim_demo_005 has exactly 1 active TTD period', async () => {
    await seedDemo();
    const periods = await tdFor(makeClaimId(4));
    expect(periods).toHaveLength(1);
    expect(periods[0].end_date).toBeNull();
  });

  it('claim_demo_006 has 1 closed period with reason_ended=mmi_reached', async () => {
    await seedDemo();
    const periods = await tdFor(makeClaimId(5));
    expect(periods).toHaveLength(1);
    expect(periods[0].end_date).not.toBeNull();
    expect(periods[0].reason_ended).toBe('mmi_reached');
  });

  it('claim_demo_007 has 2 closed periods — one TTD then one TPD', async () => {
    await seedDemo();
    const periods = await tdFor(makeClaimId(6));
    expect(periods).toHaveLength(2);
    expect(periods[0].benefit_type).toBe('TTD');
    expect(periods[0].end_date).not.toBeNull();
    expect(periods[1].benefit_type).toBe('TPD');
    expect(periods[1].end_date).not.toBeNull();
    expect(periods[1].reason_started).toBe('benefit_type_change');
  });

  it('claim_demo_008 has 2 closed periods, second reinstated_from_period_id points to the first', async () => {
    await seedDemo();
    const periods = await tdFor(makeClaimId(7));
    expect(periods).toHaveLength(2);
    expect(periods[0].reason_ended).toBe('rtw_full');
    expect(periods[1].reason_started).toBe('reinstatement');
    expect(periods[1].reinstated_from_period_id).toBe(periods[0].id);
  });

  it('claims 1-3 have zero td_periods (pre-TD lifecycle stages)', async () => {
    await seedDemo();
    for (const i of [0, 1, 2]) {
      const periods = await tdFor(makeClaimId(i));
      expect(periods).toHaveLength(0);
    }
  });

  it('total td_periods rows after seed = 7', async () => {
    await seedDemo();
    const { data } = await supabase.from('td_periods').select('*');
    // 0+0+0+1+1+1+2+2 = 7
    expect(data).toHaveLength(7);
  });

  it('claim_demo_006 summary math — Carlos Ruiz tdRate $497, P&S 4d ago, ~41-day span', async () => {
    await seedDemo();
    const tdPeriodsService = require('../../src/services/tdPeriodsService');
    const summary = await tdPeriodsService.summary(makeClaimId(5));
    // claim_demo_006: daysAgo=47, pAndSDate=4 (per existing convention
    // where pAndSDate is "days ago" — see line 269 of seedDemo.js).
    // Period spans (47 - 3)=44 days ago → 4 days ago = 41-day
    // inclusive span = 5.86 weeks. Tolerance accounts for the
    // date-of-execution drift (test runs at varying times of day).
    expect(summary.total_weeks_paid).toBeGreaterThanOrEqual(5.5);
    expect(summary.total_weeks_paid).toBeLessThanOrEqual(6);
    expect(summary.weeks_remaining).toBeGreaterThanOrEqual(98);
    expect(summary.weeks_remaining).toBeLessThanOrEqual(98.5);
    // ~$497/wk × ~5.86wk ≈ $2,911.
    expect(summary.total_indemnity_paid).toBeGreaterThanOrEqual(2750);
    expect(summary.total_indemnity_paid).toBeLessThanOrEqual(3050);
    expect(summary.active).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ai_decisions seeding
// ═════════════════════════════════════════════════════════════════════════════
describe('ai_decisions seeding', () => {
  async function aidFor(claimId) {
    const { data } = await supabase.from('ai_decisions').select('*').eq('claim_id', claimId);
    return data || [];
  }

  it('claim_demo_003 has 1 compensability decision row', async () => {
    await seedDemo();
    const rows = await aidFor(makeClaimId(2));
    expect(rows).toHaveLength(1);
    expect(rows[0].decision_type).toBe('compensability');
    expect(rows[0].confidence).toBe(62);
  });

  it('claim_demo_004 has 1 compensability + 1 rfa_mtus row', async () => {
    await seedDemo();
    const rows = await aidFor(makeClaimId(3));
    expect(rows).toHaveLength(2);
    const types = rows.map(r => r.decision_type).sort();
    expect(types).toEqual(['compensability', 'rfa_mtus']);
  });

  it('claim_demo_005 rfa_mtus row has no human_decision (pending review)', async () => {
    await seedDemo();
    const rows = await aidFor(makeClaimId(4));
    const rfa = rows.find(r => r.decision_type === 'rfa_mtus');
    expect(rfa).toBeTruthy();
    expect(rfa.human_decision).toBeNull();
  });

  it('claim_demo_008 has compensability + cnr_pricing + msa_screening rows', async () => {
    await seedDemo();
    const rows = await aidFor(makeClaimId(7));
    const types = rows.map(r => r.decision_type).sort();
    expect(types).toEqual(['cnr_pricing', 'compensability', 'msa_screening'].sort());
  });

  it('claim_demo_008 cnr_pricing row has the 1.15x guardrail triggered', async () => {
    await seedDemo();
    const rows = await aidFor(makeClaimId(7));
    const cnr = rows.find(r => r.decision_type === 'cnr_pricing');
    expect(cnr).toBeTruthy();
    const triggered = cnr.guardrail_actions.find(g => g.rule === 'cnr_premium_cap_1.15x');
    expect(triggered).toBeTruthy();
    expect(triggered.triggered).toBe(true);
    expect(triggered.action).toBe('flagged_above_premium_threshold');
  });

  it('total ai_decisions rows after seed = 10', async () => {
    await seedDemo();
    const { data } = await supabase.from('ai_decisions').select('*');
    // claims 1+2 (new_claim, intake_complete) → 0 each.
    // claim_3 (under_investigation) → 1 (compensability).
    // claim_4 (auto-approved RFA) → 2 (compensability + rfa_mtus).
    // claim_5 (pending RFA)       → 2 (compensability + rfa_mtus).
    // claim_6 (p_and_s)           → 1 (compensability).
    // claim_7 (pd_evaluation)     → 1 (compensability).
    // claim_8 (settlement_discussions) → 3 (compensability + cnr_pricing + msa_screening).
    // Total = 1+2+2+1+1+3 = 10.
    expect(data).toHaveLength(10);
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

    // 8 lifecycle-plan claims + 1 pre-migrated legacy example (LEG-000).
    const { data: rows } = await supabase.from('claims').select('*');
    expect(rows).toHaveLength(9);
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

  it('reports demo=true and count=9 after seed', async () => {
    // 8 lifecycle-plan claims + 1 pre-migrated legacy example (LEG-000).
    await seedDemo();
    const res = await request(app).get('/api/v1/admin/demo-status').set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.demo).toBe(true);
    expect(res.body.count).toBe(9);
  });
});
