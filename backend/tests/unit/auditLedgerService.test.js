'use strict';

/**
 * Unit tests — auditLedgerService (ADR-0003) and its dual-write call sites.
 *
 * The database guarantees (hash chain, append-only triggers, privileges,
 * tamper detection) are proven against real PostgreSQL in
 * backend/scripts/migration-contract-test.js. These tests cover entry
 * validation, failure semantics, and that consequential service paths
 * actually write ledger entries with the right actor.
 *
 * Run: npm test -- tests/unit/auditLedgerService.test.js
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));
jest.mock('../../src/services/aiService');
jest.mock('../../src/services/filehandler', () => ({
  createClaim: jest.fn(), setReserves: jest.fn().mockResolvedValue({ ok: true }),
  createDiary: jest.fn(), completeDiary: jest.fn(), addNote: jest.fn(),
}));

const { supabase } = require('../../src/services/supabase');
const auditLedger  = require('../../src/services/auditLedgerService');
const aid          = require('../../src/services/aiDecisionsService');
const claimService = require('../../src/services/claimService');
const { humanPrincipal, agentPrincipal, systemPrincipal } = require('../../src/policy/principal');

const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000001';
const ADJUSTER = humanPrincipal({ email: 'adj@tpa.test', role: 'adjuster', tenantId: DEFAULT_TENANT, mfa: true });

async function ledgerRows(filter = {}) {
  let q = supabase.from('audit_ledger').select('*');
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  const { data } = await q;
  return (data || []).sort((a, b) => a.seq - b.seq);
}

function seedClaim(overrides = {}) {
  return claimService._seedClaim({
    id: 'claim_ledger_1', claimNumber: 'CL-2026-L1', status: 'intake_complete',
    tenantId: DEFAULT_TENANT, employerId: 'emp-1', dateOfInjury: '2026-05-01',
    filehandlerId: 'fh_1', employee: {}, events: [], diaries: [], ...overrides,
  });
}

beforeEach(() => {
  supabase._resetStore();
  claimService._resetClaims();
});

describe('buildEntry validation', () => {
  test('rejects an unknown actor type', () => {
    expect(() => auditLedger.buildEntry({ actor: { type: 'robot', id: 'x' }, action: 'claim.viewed' }))
      .toThrow(/actor.type/);
  });

  test('rejects action names that are not dotted lower-case', () => {
    for (const action of ['Claim.Viewed', 'claim', 'claim status', 'claim.', '.claim']) {
      expect(() => auditLedger.buildEntry({ actor: ADJUSTER, action })).toThrow(/dotted lower-case/);
    }
  });

  test('rejects non-object payloads and non-array evidence', () => {
    expect(() => auditLedger.buildEntry({ actor: ADJUSTER, action: 'a.b', payload: [1] })).toThrow(/payload/);
    expect(() => auditLedger.buildEntry({ actor: ADJUSTER, action: 'a.b', evidence: {} })).toThrow(/evidence/);
  });

  test('never forwards chain fields — the database assigns them', () => {
    const row = auditLedger.buildEntry({
      actor: ADJUSTER, action: 'claim.status_changed', seq: 99, hash: 'forged', prev_hash: 'forged',
    });
    expect(row).not.toHaveProperty('seq');
    expect(row).not.toHaveProperty('hash');
    expect(row).not.toHaveProperty('prev_hash');
  });

  test('maps the principal to actor columns and falls back to the default tenant', () => {
    const row = auditLedger.buildEntry({ actor: agentPrincipal('document_classification'), action: 'document.filed' });
    expect(row).toMatchObject({
      actor_type: 'agent', actor_id: 'agent:document_classification', actor_role: 'agent',
      tenant_id: DEFAULT_TENANT,
    });
  });

  test('explicit tenantId (the claim tenant) wins over the actor tenant', () => {
    const other = '00000000-0000-0000-0000-0000000000b2';
    const row = auditLedger.buildEntry({ actor: ADJUSTER, action: 'a.b', tenantId: other });
    expect(row.tenant_id).toBe(other);
  });
});

describe('append semantics', () => {
  test('appends chain in order (mock mirrors the database trigger shape)', async () => {
    const a = await auditLedger.append({ actor: ADJUSTER, action: 'claim.created', claimId: 'c1' });
    const b = await auditLedger.append({ actor: ADJUSTER, action: 'claim.status_changed', claimId: 'c1' });
    expect(a.seq).toBe(1);
    expect(a.prev_hash).toBe('GENESIS');
    expect(b.seq).toBe(2);
    expect(b.prev_hash).toBe(a.hash);
  });

  test('a required append throws when persistence fails', async () => {
    const spy = jest.spyOn(supabase, 'from').mockImplementation(() => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'db down' } }) }) }),
    }));
    try {
      await expect(auditLedger.append({ actor: ADJUSTER, action: 'reserve.approved' }, { required: true }))
        .rejects.toThrow(/Audit ledger append failed for reserve.approved: db down/);
    } finally {
      spy.mockRestore();
    }
  });

  test('a best-effort append returns null instead of throwing', async () => {
    const spy = jest.spyOn(supabase, 'from').mockImplementation(() => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'db down' } }) }) }),
    }));
    try {
      await expect(auditLedger.append({ actor: ADJUSTER, action: 'reserve.approved' })).resolves.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test('a malformed entry always throws, even best-effort', async () => {
    await expect(auditLedger.append({ actor: ADJUSTER, action: 'NOT VALID' })).rejects.toThrow();
  });

  test('ledger rows cannot be updated or deleted through the client', async () => {
    const row = await auditLedger.append({ actor: ADJUSTER, action: 'claim.created' });
    const upd = await supabase.from('audit_ledger').update({ action: 'claim.deleted' }).eq('id', row.id);
    expect(upd.error.message).toMatch(/append-only/);
    const del = await supabase.from('audit_ledger').delete().eq('id', row.id);
    expect(del.error.message).toMatch(/append-only/);
  });
});

describe('dual-writes from consequential paths', () => {
  test('a status change records actor, role and from/to', async () => {
    seedClaim();
    await claimService.updateStatus('claim_ledger_1', 'accepted', 'adj@tpa.test', { actor: ADJUSTER });
    const [entry] = await ledgerRows({ action: 'claim.status_changed' });
    expect(entry).toMatchObject({
      actor_type: 'human', actor_id: 'adj@tpa.test', actor_role: 'adjuster',
      claim_id: 'claim_ledger_1', tenant_id: DEFAULT_TENANT,
      payload: { from: 'intake_complete', to: 'accepted' },
    });
  });

  test('a reserve approval records integer-cent amounts and its approval path', async () => {
    seedClaim();
    await claimService.approveReserves('claim_ledger_1',
      { medical: 12500.10, indemnity: 8000, expense: 1500.005, reason: 'Initial worksheet' },
      'adj@tpa.test', { actor: ADJUSTER, actionRequestId: 'ar_1' });
    const [entry] = await ledgerRows({ action: 'reserve.approved' });
    expect(entry.payload).toEqual({
      medical_cents: 1250010, indemnity_cents: 800000, expense_cents: 150001,
      total_cents: 2200011, reason: 'Initial worksheet', path: 'action_request',
    });
    expect(entry.evidence).toEqual([{ type: 'action_request', id: 'ar_1' }]);
  });

  test('an AI recommendation is recorded as an agent action without raw model text', async () => {
    await aid.logDecision({
      claim_id: 'claim_ledger_1', decision_type: 'compensability', prompt_name: 'compensability_analysis',
      model: 'claude-test', input_snapshot: { bodyPart: 'back' }, output_parsed: { priority: 'High' },
      output_raw: 'RAW MODEL TEXT WITH MEDICAL DETAIL', confidence: 81,
      guardrail_actions: [{ rule: 'no_auto_deny', triggered: true }, { rule: 'x', triggered: false }],
    }, { required: true });
    const [entry] = await ledgerRows({ action: 'agent.recommendation_recorded' });
    expect(entry).toMatchObject({
      actor_type: 'agent', actor_id: 'agent:compensability_analysis', entity_type: 'ai_decision',
      payload: { decision_type: 'compensability', confidence: 81, guardrails_triggered: ['no_auto_deny'] },
    });
    expect(JSON.stringify(entry)).not.toMatch(/RAW MODEL TEXT/);
  });

  test('a required AI decision fails closed when its ledger entry cannot be written', async () => {
    const realFrom = supabase.from.bind(supabase);
    const spy = jest.spyOn(supabase, 'from').mockImplementation((t) => {
      if (t !== 'audit_ledger') return realFrom(t);
      return { insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'ledger down' } }) }) }) };
    });
    try {
      await expect(aid.logDecision({
        claim_id: 'c1', decision_type: 'rfa_mtus', prompt_name: 'rfa_mtus_evaluation', model: 'm',
        input_snapshot: {}, output_parsed: {}, output_raw: '{}',
      }, { required: true })).rejects.toThrow(/AI decision audit persistence failed/);
    } finally {
      spy.mockRestore();
    }
  });

  test('a human review is appended as a new entry linked to the recommendation', async () => {
    const rec = await aid.logDecision({
      claim_id: 'claim_ledger_1', decision_type: 'compensability', prompt_name: 'compensability_analysis',
      model: 'm', input_snapshot: {}, output_parsed: {},
    });
    await aid.linkHumanDecision('claim_ledger_1', 'compensability', {
      human_decision: 'accepted by adj@tpa.test', actor: ADJUSTER,
    });
    const [entry] = await ledgerRows({ action: 'agent.recommendation_reviewed' });
    expect(entry).toMatchObject({
      actor_type: 'human', actor_id: 'adj@tpa.test', entity_id: rec.id,
      evidence: [{ type: 'ai_decision', id: rec.id }],
    });
  });

  test('system principals are namespaced so they can never collide with a person', () => {
    expect(systemPrincipal('diary_aftermath').id).toBe('system:diary_aftermath');
    expect(agentPrincipal('reserve_analysis').id).toBe('agent:reserve_analysis');
  });
});
