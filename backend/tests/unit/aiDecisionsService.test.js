'use strict';

/**
 * Unit tests — aiDecisionsService.
 *
 * Covers logDecision / linkHumanDecision / listDecisions / getDecision /
 * stats including the zero-rows / all-overridden / all-guardrails edges.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const aid          = require('../../src/services/aiDecisionsService');

beforeEach(() => { supabase._resetStore(); });

async function seed(rows) {
  for (const r of rows) {
    await supabase.from('ai_decisions').insert({
      id: r.id || `aid_${Math.random().toString(36).slice(2, 8)}`,
      claim_id: r.claim_id || 'claim_test',
      decision_type: r.decision_type,
      prompt_name: r.prompt_name || 'p',
      model: r.model || 'claude-sonnet-4-6',
      input_snapshot: r.input_snapshot || {},
      output_parsed: r.output_parsed || null,
      output_raw: r.output_raw || null,
      input_tokens: r.input_tokens ?? null,
      output_tokens: r.output_tokens ?? null,
      latency_ms: r.latency_ms ?? null,
      confidence: r.confidence ?? null,
      guardrail_actions: r.guardrail_actions || [],
      human_decision: r.human_decision || null,
      human_decision_at: r.human_decision_at || null,
      created_at: r.created_at || new Date().toISOString(),
    });
  }
}

describe('logDecision', () => {
  it('inserts a row and returns it', async () => {
    const out = await aid.logDecision({
      claim_id: 'claim_test', decision_type: 'compensability',
      prompt_name: 'compensability_analysis', model: 'claude-sonnet-4-6',
      input_snapshot: { x: 1 }, output_parsed: { y: 2 },
      input_tokens: 800, output_tokens: 600, latency_ms: 3500, confidence: 87,
    });
    expect(out).toBeTruthy();
    expect(out.decision_type).toBe('compensability');
    expect(out.input_tokens).toBe(800);
    const { data } = await supabase.from('ai_decisions').select('*');
    expect(data).toHaveLength(1);
  });

  it('does not throw when supabase insert fails', async () => {
    const orig = supabase.from;
    supabase.from = (tbl) => {
      if (tbl === 'ai_decisions') {
        return { insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) };
      }
      return orig.call(supabase, tbl);
    };
    const out = await aid.logDecision({ decision_type: 'compensability', prompt_name: 'p', model: 'm' });
    expect(out).toBeNull();   // returns null, never throws
    supabase.from = orig;
  });
});

describe('linkHumanDecision', () => {
  it('updates the most recent matching row within 7 days', async () => {
    const recent = new Date().toISOString();
    await seed([{ decision_type: 'rfa_mtus', created_at: recent }]);
    const out = await aid.linkHumanDecision('claim_test', 'rfa_mtus',
      { human_reviewer_id: null, human_decision: 'adjuster_approved' });
    expect(out).toBeTruthy();
    expect(out.human_decision).toBe('adjuster_approved');
    expect(out.human_decision_at).toBeTruthy();
  });

  it('returns null and audit-logs an orphan when no recent row exists', async () => {
    const out = await aid.linkHumanDecision('claim_x', 'rfa_mtus', { human_decision: 'denied' });
    expect(out).toBeNull();
    const { data: audit } = await supabase.from('audit_log').select('*');
    expect(audit.some(a => a.action === 'ai_decision_link_orphan')).toBe(true);
  });

  it('returns null when claimId is missing', async () => {
    const out = await aid.linkHumanDecision(null, 'rfa_mtus', {});
    expect(out).toBeNull();
  });
});

describe('listDecisions', () => {
  it('filters by claimId + decision_type', async () => {
    await seed([
      { claim_id: 'A', decision_type: 'rfa_mtus' },
      { claim_id: 'A', decision_type: 'compensability' },
      { claim_id: 'B', decision_type: 'rfa_mtus' },
    ]);
    const out = await aid.listDecisions({ claimId: 'A' });
    expect(out.total).toBe(2);
    const out2 = await aid.listDecisions({ decision_type: 'rfa_mtus' });
    expect(out2.total).toBe(2);
  });

  it('respects hasOverride and guardrailTriggered filters', async () => {
    await seed([
      { decision_type: 'rfa_mtus', human_decision: 'adjuster_approved', guardrail_actions: [{ rule: 'no_auto_deny', triggered: true }] },
      { decision_type: 'rfa_mtus', human_decision: null, guardrail_actions: [{ rule: 'no_auto_deny', triggered: false }] },
    ]);
    expect((await aid.listDecisions({ hasOverride: true })).total).toBe(1);
    expect((await aid.listDecisions({ hasOverride: false })).total).toBe(1);
    expect((await aid.listDecisions({ guardrailTriggered: true })).total).toBe(1);
    expect((await aid.listDecisions({ guardrailTriggered: false })).total).toBe(1);
  });

  it('paginates via limit + offset', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ decision_type: 'compensability', id: `aid_${i}` }));
    await seed(rows);
    const a = await aid.listDecisions({ limit: 2, offset: 0 });
    const b = await aid.listDecisions({ limit: 2, offset: 2 });
    expect(a.total).toBe(5);
    expect(a.rows).toHaveLength(2);
    expect(b.rows).toHaveLength(2);
  });
});

describe('getDecision', () => {
  it('returns the row when present', async () => {
    await seed([{ id: 'aid_one', decision_type: 'compensability' }]);
    const row = await aid.getDecision('aid_one');
    expect(row).toBeTruthy();
    expect(row.id).toBe('aid_one');
  });
  it('returns null when absent', async () => {
    const row = await aid.getDecision('aid_missing');
    expect(row).toBeNull();
  });
});

describe('stats', () => {
  it('zero rows → all-zero shape', async () => {
    const s = await aid.stats({ windowDays: 30 });
    expect(s.total).toBe(0);
    expect(s.pct_with_human_override).toBe(0);
    expect(s.pct_with_guardrail_triggered).toBe(0);
    expect(s.median_latency_ms).toBe(0);
    expect(s.total_input_tokens).toBe(0);
  });
  it('all rows overridden → 100% override pct', async () => {
    await seed([
      { decision_type: 'rfa_mtus', human_decision: 'adjuster_approved' },
      { decision_type: 'rfa_mtus', human_decision: 'routed_to_uro' },
    ]);
    const s = await aid.stats({ windowDays: 30 });
    expect(s.pct_with_human_override).toBe(100);
  });
  it('all rows guardrail-triggered → 100% guardrail pct + median latency', async () => {
    await seed([
      { decision_type: 'rfa_mtus', latency_ms: 1000, guardrail_actions: [{ rule: 'r', triggered: true }] },
      { decision_type: 'rfa_mtus', latency_ms: 3000, guardrail_actions: [{ rule: 'r', triggered: true }] },
      { decision_type: 'rfa_mtus', latency_ms: 5000, guardrail_actions: [{ rule: 'r', triggered: true }] },
    ]);
    const s = await aid.stats({ windowDays: 30 });
    expect(s.pct_with_guardrail_triggered).toBe(100);
    expect(s.median_latency_ms).toBe(3000);
  });
  it('aggregates by_type and tokens', async () => {
    await seed([
      { decision_type: 'compensability', input_tokens: 800, output_tokens: 600 },
      { decision_type: 'rfa_mtus',       input_tokens: 600, output_tokens: 400 },
    ]);
    const s = await aid.stats({ windowDays: 30 });
    expect(s.by_type.compensability).toBe(1);
    expect(s.by_type.rfa_mtus).toBe(1);
    expect(s.total_input_tokens).toBe(1400);
    expect(s.total_output_tokens).toBe(1000);
  });
});
