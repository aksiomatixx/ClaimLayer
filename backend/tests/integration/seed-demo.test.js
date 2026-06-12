'use strict';

/**
 * Integration tests — demo seed + reset.
 *
 * Verifies:
 *   - seedDemo creates exactly 12 claims (IDs skip 009 — reserved for
 *     the linked 2024 prior claim)
 *   - all distinct lifecycle statuses are represented
 *   - every seeded claim carries metadata.demo === true
 *   - re-running seedDemo is idempotent (still 12, same IDs)
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
  it('creates exactly 12 claims with deterministic IDs (skipping the reserved 009)', async () => {
    const out = await seedDemo();
    expect(out.count).toBe(12);
    expect(out.ids).toHaveLength(12);
    expect(out.ids[0]).toBe('claim_demo_001');
    expect(out.ids[7]).toBe('claim_demo_008');
    // 009 is reserved for the linked 2024 prior Rosa Mendez claim.
    expect(out.ids[8]).toBe('claim_demo_010');
    expect(out.ids[11]).toBe('claim_demo_013');
    expect(out.ids).not.toContain('claim_demo_009');

    // 12 from LIFECYCLE_PLANS + 1 pre-migrated legacy example (LEG-000)
    // + the linked 2024 prior Rosa Mendez claim (CL-DEMO2).
    const { data: rows } = await supabase.from('claims').select('*');
    expect(rows).toHaveLength(14);
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

  it('is idempotent — re-running yields the same 12 IDs', async () => {
    const a = await seedDemo();
    const b = await seedDemo();
    expect(b.count).toBe(12);
    expect(b.ids).toEqual(a.ids);
    // 12 lifecycle-plan claims + 1 pre-migrated legacy example (LEG-000)
    // + the linked 2024 prior claim (CL-DEMO2).
    const { data: rows } = await supabase.from('claims').select('*');
    expect(rows).toHaveLength(14);
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

  it('claim_demo_010 (accepted, on TD payments) has 1 active TTD period', async () => {
    await seedDemo();
    const periods = await tdFor(makeClaimId(8));
    expect(periods).toHaveLength(1);
    expect(periods[0].benefit_type).toBe('TTD');
    expect(periods[0].end_date).toBeNull();
  });

  it('claim_demo_011 (MMI solicitation) has 1 active TTD period — TD continues pending P&S', async () => {
    await seedDemo();
    const periods = await tdFor(makeClaimId(9));
    expect(periods).toHaveLength(1);
    expect(periods[0].end_date).toBeNull();
  });

  it('claim_demo_012 (future_medical_only) has 1 closed period ended rtw_full', async () => {
    await seedDemo();
    const periods = await tdFor(makeClaimId(10));
    expect(periods).toHaveLength(1);
    expect(periods[0].reason_ended).toBe('rtw_full');
  });

  it('claim_demo_013 (litigated) has 1 closed period ended rtw_modified', async () => {
    await seedDemo();
    const periods = await tdFor(makeClaimId(11));
    expect(periods).toHaveLength(1);
    expect(periods[0].reason_ended).toBe('rtw_modified');
  });

  it('total td_periods rows after seed = 11', async () => {
    await seedDemo();
    const { data } = await supabase.from('td_periods').select('*');
    // 0+0+0+1+1+1+2+2 (original eight) + 1+1+1+1 (claims 010-013) = 11
    expect(data).toHaveLength(11);
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

  it('total ai_decisions rows after seed = 14', async () => {
    await seedDemo();
    const { data } = await supabase.from('ai_decisions').select('*');
    // claims 1+2 (new_claim, intake_complete) → 0 each.
    // claim_3 (under_investigation) → 1 (compensability).
    // claim_4 (auto-approved RFA) → 2 (compensability + rfa_mtus).
    // claim_5 (pending RFA)       → 2 (compensability + rfa_mtus).
    // claim_6 (p_and_s)           → 1 (compensability).
    // claim_7 (pd_evaluation)     → 1 (compensability).
    // claim_8 (settlement_discussions) → 3 (compensability + cnr_pricing + msa_screening).
    // claims 010-013 → 1 compensability each.
    // Total = 1+2+2+1+1+3+4 = 14.
    expect(data).toHaveLength(14);
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
  it('happy path — wipes + re-seeds, returns count 12', async () => {
    await seedDemo();
    const res = await request(app)
      .post('/api/v1/admin/demo-reset')
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(12);

    // 12 lifecycle-plan claims + 1 pre-migrated legacy example (LEG-000)
    // + the linked 2024 prior claim (CL-DEMO2).
    const { data: rows } = await supabase.from('claims').select('*');
    expect(rows).toHaveLength(14);
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

  it('reports demo=true and count=14 after seed', async () => {
    // 12 lifecycle-plan claims + 1 pre-migrated legacy example (LEG-000)
    // + the linked 2024 prior claim (CL-DEMO2).
    await seedDemo();
    const res = await request(app).get('/api/v1/admin/demo-status').set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.demo).toBe(true);
    expect(res.body.count).toBe(14);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// New lifecycle stages: accepted (on TD payments), MMI solicitation with
// estimated PD, future_medical_only, litigated
// ═════════════════════════════════════════════════════════════════════════════
describe('extended lifecycle claims (010–013)', () => {
  beforeEach(async () => { await seedDemo(); });

  it('claim_demo_010 is accepted with an open TD payment review diary', async () => {
    const { data: claim } = await supabase.from('claims').select('*').eq('id', makeClaimId(8)).single();
    expect(claim.status).toBe('accepted');
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', makeClaimId(8));
    const td = diaries.find(d => d.diary_type === 'TD_PAYMENT_REVIEW');
    expect(td).toBeTruthy();
    expect(td.status).toBe('open');
  });

  it('claim_demo_011 carries the full MMI-solicitation footprint', async () => {
    const claimId = makeClaimId(9);

    const { data: evals } = await supabase.from('mmi_evaluations').select('*').eq('claim_id', claimId);
    expect(evals).toHaveLength(1);
    expect(evals[0].recommendation).toBe('solicit_pr4');
    expect(evals[0].adjuster_action).toBe('pr4_solicited');
    expect(evals[0].signal_count).toBe(3);

    const { data: pr4s } = await supabase.from('pr4_solicitations').select('*').eq('claim_id', claimId);
    expect(pr4s).toHaveLength(1);
    expect(pr4s[0].status).toBe('sent');
    expect(pr4s[0].mmi_evaluation_id).toBe(evals[0].id);
    // 30-day response clock from the solicitation date.
    expect(pr4s[0].response_due_date > pr4s[0].solicitation_date).toBe(true);

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claimId);
    const due = diaries.find(d => d.diary_type === 'PR4_RESPONSE_DUE');
    expect(due).toBeTruthy();
    expect(due.status).toBe('open');
  });

  it('claim_demo_011 reserve worksheet includes an estimated PD line pending the rating', async () => {
    const { data: items } = await supabase.from('reserve_line_items').select('*').eq('claim_id', makeClaimId(9));
    const pd = items.find(i => i.label === 'Estimated permanent disability');
    expect(pd).toBeTruthy();
    expect(pd.category).toBe('indemnity');
    expect(pd.total).toBeGreaterThan(0);
    expect(pd.basis_note).toMatch(/SYNTHETIC DEMO ESTIMATE/);
    // Estimated only — no pd_evaluations row until the PR-4 is rated.
    const { data: pds } = await supabase.from('pd_evaluations').select('*').eq('claim_id', makeClaimId(9));
    expect(pds).toHaveLength(0);
  });

  it('claim_demo_012 is future_medical_only and claim_demo_013 is litigated with a legal review diary', async () => {
    const { data: fmo } = await supabase.from('claims').select('*').eq('id', makeClaimId(10)).single();
    expect(fmo.status).toBe('future_medical_only');

    const { data: lit } = await supabase.from('claims').select('*').eq('id', makeClaimId(11)).single();
    expect(lit.status).toBe('litigated');
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', makeClaimId(11));
    expect(diaries.some(d => d.diary_type === 'LEGAL_REVIEW' && d.status === 'open')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('CL-DEMO2 — linked prior claim + body-part consistency', () => {
  const CURRENT = makeClaimId(2);     // Rosa Mendez 2026
  const PRIOR   = 'claim_demo_009';   // Rosa Mendez 2024

  beforeEach(async () => { await seedDemo(); });

  it('both Rosa Mendez claims load: same worker, right shoulder, 2024 one closed', async () => {
    const { data: cur } = await supabase.from('claims').select('*').eq('id', CURRENT).single();
    const { data: prior } = await supabase.from('claims').select('*').eq('id', PRIOR).single();

    expect(prior.claim_number).toBe('HHW-2024-D09');
    expect(prior.status).toBe('closed');
    expect(prior.date_of_injury).toBe('2024-03-12');
    expect(prior.body_part).toBe('Shoulder');
    expect(prior.employee.adpEmployeeId).toBe('DEMO-3');
    expect(cur.employee.adpEmployeeId).toBe('DEMO-3'); // SAME worker
    expect(prior.metadata.resolution).toBe('stipulated_award');
  });

  it('the link resolves in both directions through the real service', async () => {
    const claimLinks = require('../../src/services/claimLinkService');
    const from2026 = await claimLinks.listLinks(CURRENT);
    const from2024 = await claimLinks.listLinks(PRIOR);

    expect(from2026).toHaveLength(1);
    expect(from2026[0].linked_claim.claim_number).toBe('HHW-2024-D09');
    expect(from2026[0].linked_claim.status).toBe('closed');
    expect(from2024).toHaveLength(1);
    expect(from2024[0].linked_claim.id).toBe(CURRENT);
  });

  it('the descriptions cross-reference each other by claim number', async () => {
    const { data: cur } = await supabase.from('claims').select('*').eq('id', CURRENT).single();
    const { data: prior } = await supabase.from('claims').select('*').eq('id', PRIOR).single();
    expect(cur.injury_description).toContain('HHW-2024-D09');
    expect(prior.injury_description).toContain(cur.claim_number);
  });

  it("the 2026 red flag cites the linked 2024 claim number — traceable, not vague", async () => {
    const { data: cur } = await supabase.from('claims').select('*').eq('id', CURRENT).single();
    expect(cur.ai_analysis.redFlags.join(' ')).toContain('HHW-2024-D09');
    expect(cur.ai_analysis.rationale).toContain('HHW-2024-D09');
  });

  it('the body-part discrepancy is fixed: PR-1 reads right shoulder, never lumbar', async () => {
    const { data: docs } = await supabase.from('claim_documents').select('*').eq('claim_id', CURRENT);
    const pr1 = docs.find(d => d.title.includes('PR-1'));
    expect(pr1.ai_summary).toContain('right shoulder');
    expect(pr1.ai_summary).toContain('no lifting >10 lbs');
    for (const d of docs) {
      expect(String(d.ai_summary || '')).not.toMatch(/lumbar/i);
      expect(String(d.content_text || '')).not.toMatch(/lumbar/i);
    }
  });

  it('the 2024 claim carries a closed file: completed diaries, documents, an approved worksheet', async () => {
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', PRIOR);
    expect(diaries.length).toBeGreaterThanOrEqual(3);
    expect(diaries.every(d => d.status === 'completed')).toBe(true);

    const { data: docs } = await supabase.from('claim_documents').select('*').eq('claim_id', PRIOR);
    expect(docs.some(d => d.title.includes('Stipulations'))).toBe(true);
    for (const d of docs) expect(String(d.ai_summary || '')).toMatch(/right shoulder|shoulder/i);

    const worksheet = require('../../src/services/reserveWorksheetService');
    const ws = await worksheet.getWorksheet(PRIOR);
    expect(ws.grand_total).toBeGreaterThan(0);
    expect(ws.proposal.status).toBe('approved'); // closed file: reserves match the worksheet
  });
});
