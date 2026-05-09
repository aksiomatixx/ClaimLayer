'use strict';

/**
 * Integration tests — /api/v1/ai-decisions and /api/v1/prompts/:name.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const request                = require('supertest');
const app                    = require('../../src/index');
const { supabase }           = require('../../src/services/supabase');
const { generateAdminToken } = require('../../src/middleware/auth');

const adminToken = generateAdminToken({ sub: 'admin-001', email: 'admin@homecaretpa.com' });

beforeEach(() => { supabase._resetStore(); });

async function seedDecisions() {
  for (const r of [
    { id: '11111111-1111-4111-8111-111111111111', claim_id: 'A', decision_type: 'compensability', prompt_name: 'compensability_analysis',  model: 'claude-sonnet-4-20250514', input_snapshot: { x: 1 }, output_parsed: { compensability: 'Likely Compensable' }, input_tokens: 800, output_tokens: 600, latency_ms: 3500, confidence: 88, guardrail_actions: [],                                          created_at: new Date().toISOString() },
    { id: '22222222-2222-4222-8222-222222222222', claim_id: 'A', decision_type: 'rfa_mtus',       prompt_name: 'rfa_mtus_evaluation',     model: 'claude-sonnet-4-20250514', input_snapshot: { y: 2 }, output_parsed: { recommendedAction: 'auto_approve' }, input_tokens: 600, output_tokens: 400, latency_ms: 2200, confidence: 90, guardrail_actions: [{ rule: 'no_auto_deny', triggered: true }], human_decision: 'adjuster_approved', human_decision_at: new Date().toISOString(), created_at: new Date().toISOString() },
    { id: '33333333-3333-4333-8333-333333333333', claim_id: 'B', decision_type: 'cnr_pricing',    prompt_name: 'cnr_pricing',             model: 'claude-sonnet-4-20250514', input_snapshot: { z: 3 }, output_parsed: { cnrValueMid: 27500 }, input_tokens: 1200, output_tokens: 900, latency_ms: 5800, confidence: null, guardrail_actions: [{ rule: 'cnr_premium_cap_1.15x', triggered: true, action: 'flagged_above_premium_threshold' }], created_at: new Date().toISOString() },
  ]) {
    await supabase.from('ai_decisions').insert(r);
  }
}

describe('GET /api/v1/ai-decisions', () => {
  it('lists all rows for admin', async () => {
    await seedDecisions();
    const res = await request(app).get('/api/v1/ai-decisions').set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.rows).toHaveLength(3);
  });

  it('filters by decision_type', async () => {
    await seedDecisions();
    const res = await request(app).get('/api/v1/ai-decisions?decision_type=rfa_mtus').set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].decision_type).toBe('rfa_mtus');
  });

  it('filters by hasOverride=true', async () => {
    await seedDecisions();
    const res = await request(app).get('/api/v1/ai-decisions?hasOverride=true').set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it('filters by guardrailTriggered=true', async () => {
    await seedDecisions();
    const res = await request(app).get('/api/v1/ai-decisions?guardrailTriggered=true').set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('401 without admin token', async () => {
    const res = await request(app).get('/api/v1/ai-decisions');
    expect(res.status).toBe(401);
  });

  it('400 on invalid decision_type filter', async () => {
    const res = await request(app).get('/api/v1/ai-decisions?decision_type=fake').set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/ai-decisions/:id', () => {
  it('returns the row', async () => {
    await seedDecisions();
    const res = await request(app)
      .get('/api/v1/ai-decisions/11111111-1111-4111-8111-111111111111')
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('11111111-1111-4111-8111-111111111111');
  });
  it('404 when missing', async () => {
    const res = await request(app)
      .get('/api/v1/ai-decisions/99999999-9999-4999-8999-999999999999')
      .set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(404);
  });
  it('400 on non-UUID id', async () => {
    const res = await request(app).get('/api/v1/ai-decisions/not-a-uuid').set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/ai-decisions/stats', () => {
  it('returns the stats shape with zero rows', async () => {
    const res = await request(app).get('/api/v1/ai-decisions/stats').set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total', 0);
    expect(res.body).toHaveProperty('by_type');
    expect(res.body).toHaveProperty('pct_with_human_override', 0);
    expect(res.body).toHaveProperty('pct_with_guardrail_triggered', 0);
    expect(res.body).toHaveProperty('median_latency_ms');
  });
  it('aggregates after seed', async () => {
    await seedDecisions();
    const res = await request(app).get('/api/v1/ai-decisions/stats').set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.by_type.compensability).toBe(1);
    expect(res.body.by_type.rfa_mtus).toBe(1);
    expect(res.body.by_type.cnr_pricing).toBe(1);
    expect(res.body.pct_with_human_override).toBeCloseTo(33.3, 1);
  });
});

describe('GET /api/v1/prompts/:name', () => {
  it('returns the prompt text for a real prompt name', async () => {
    const res = await request(app).get('/api/v1/prompts/compensability_analysis').set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('compensability_analysis');
    expect(typeof res.body.text).toBe('string');
    expect(res.body.text.length).toBeGreaterThan(20);
  });
  it('rejects path-traversal via ..', async () => {
    const res = await request(app).get('/api/v1/prompts/..%2F..%2Fpackage').set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(400);
  });
  it('rejects names with slashes', async () => {
    const res = await request(app).get('/api/v1/prompts/foo%2Fbar').set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(400);
  });
  it('404 on unknown but safe-named prompt', async () => {
    const res = await request(app).get('/api/v1/prompts/no_such_prompt').set('Cookie', `token=${adminToken}`);
    expect(res.status).toBe(404);
  });
  it('401 without admin token', async () => {
    const res = await request(app).get('/api/v1/prompts/compensability_analysis');
    expect(res.status).toBe(401);
  });
});
