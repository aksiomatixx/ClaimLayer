'use strict';

/**
 * The approval lifecycle on real PostgreSQL (ADR-0004 + ADR-0006): every
 * transition commits with its audit-ledger entry or not at all, an approved
 * action's effects commit with its 'executed' record, races resolve to
 * exactly one winner, and FileHandler is reached only through the outbox.
 *
 * Ledger failures are injected with a temporary NOT VALID CHECK constraint
 * on audit_ledger, so the database itself refuses the write mid-transaction.
 */

jest.mock('../../src/services/supabase', () => require('./pgSupabase'));
jest.mock('../../src/services/filehandler', () => ({
  setReserves: jest.fn().mockResolvedValue({ ok: true }),
  createClaim: jest.fn(), createDiary: jest.fn(), completeDiary: jest.fn(), addNote: jest.fn(),
  attachDocument: jest.fn(),
}));

const crypto       = require('crypto');
const config       = require('../../src/config');
const filehandler  = require('../../src/services/filehandler');
const claimService = require('../../src/services/claimService');
const rfaService   = require('../../src/services/rfaService');
const approvals    = require('../../src/services/approvalService');
const { getExecutor } = require('../../src/services/actionExecutors');
const { humanPrincipal, agentPrincipal } = require('../../src/policy/principal');
const { getPool, closePool } = require('../../src/db/pool');

const TENANT = '00000000-0000-0000-0000-000000000001';
const ADJ  = humanPrincipal({ email: 'adj@tpa.test', role: 'adjuster', mfa: true, tenantId: TENANT });
const ADJ2 = humanPrincipal({ email: 'adj2@tpa.test', role: 'adjuster', mfa: true, tenantId: TENANT });
const SUP  = humanPrincipal({ email: 'sup@tpa.test', role: 'supervisor', mfa: true, tenantId: TENANT });
const SUP2 = humanPrincipal({ email: 'sup2@tpa.test', role: 'supervisor', mfa: true, tenantId: TENANT });
const RESERVES = { medical_cents: 3_500_000, indemnity_cents: 2_000_000, expense_cents: 500_000, reason: 'Surgery recommended per PR-2' };
const WHY = 'Supported by the PR-2 findings and the worksheet.';

const db = (sql, params) => getPool().query(sql, params).then(r => r.rows);
let n = 0;

async function seedClaim() {
  const id = `claim_apg_${process.pid}_${++n}`;
  const number = `APG-${process.pid % 100000}-${n}`;           // claim_number is VARCHAR(20)
  await db(`INSERT INTO claims (id, claim_number, status, date_of_injury, filehandler_id)
            VALUES ($1, $2, 'accepted', '2026-05-01', $3)`, [id, number, `fh_${id}`]);
  claimService._seedClaim({
    id, claimNumber: number, status: 'accepted', employerId: 'emp-1', dateOfInjury: '2026-05-01',
    filehandlerId: `fh_${id}`, tenantId: TENANT, employee: {}, events: [], diaries: [],
  });
  return id;
}

async function blockLedger(action, fn) {
  const name = `test_block_${action.replace(/\W/g, '_')}`;
  await db(`ALTER TABLE audit_ledger ADD CONSTRAINT ${name} CHECK (action <> '${action}') NOT VALID`);
  try {
    return await fn();
  } finally {
    await db(`ALTER TABLE audit_ledger DROP CONSTRAINT ${name}`);
  }
}

const proposeReserve = (claimId, extra = {}) => approvals.propose({
  actionType: 'reserve.change', claimId, proposer: ADJ, payload: RESERVES,
  rationale: 'Exceeds my authority; surgery now likely.', ...extra,
}).then(r => r.request);

const ledgerFor = (requestId) => db(
  `SELECT action, actor_id FROM audit_ledger
    WHERE entity_id = $1 OR evidence @> $2::jsonb ORDER BY seq`,
  [requestId, JSON.stringify([{ type: 'action_request', id: requestId }])]);

beforeEach(() => {
  filehandler.setReserves.mockClear();
  filehandler.setReserves.mockResolvedValue({ ok: true });
  config.jobs.kick = false;
});
afterEach(() => jest.restoreAllMocks());
afterAll(closePool);

describe('reserve change: propose → approve → execute', () => {
  test('commits the request, the reserve, its event, the outbox row and a verifiable ledger trail', async () => {
    const claimId = await seedClaim();
    const req = await proposeReserve(claimId);
    const { request } = await approvals.decide(req.id, { decision: 'approve', decider: SUP, rationale: WHY });

    expect(request).toMatchObject({ status: 'executed', executed_by: 'sup@tpa.test', execution_attempts: 1 });
    expect(await db(`SELECT medical::float, approved_by FROM reserves WHERE claim_id = $1`, [claimId]))
      .toEqual([{ medical: 35000, approved_by: 'sup@tpa.test' }]);
    expect(await db(`SELECT type FROM claim_events WHERE claim_id = $1`, [claimId])).toEqual([{ type: 'reserves_approved' }]);

    // FileHandler was reached through the outbox, after commit, with a stable key.
    const [row] = await db(`SELECT * FROM integration_outbox WHERE claim_id = $1`, [claimId]);
    expect(row).toMatchObject({ operation: 'set_reserves', status: 'succeeded' });
    expect(filehandler.setReserves).toHaveBeenCalledWith(`fh_${claimId}`,
      expect.objectContaining({ medical: 35000, indemnity: 20000, expense: 5000 }),
      'ADJUSTER', 'sup@tpa.test', { idempotencyKey: row.id });

    expect((await ledgerFor(req.id)).map(e => [e.action, e.actor_id])).toEqual([
      ['action.proposed', 'adj@tpa.test'],
      ['action.approved', 'sup@tpa.test'],
      ['reserve.approved', 'sup@tpa.test'],
      ['action.executed', 'sup@tpa.test'],
    ]);
    const [verify] = await db(`SELECT * FROM app.audit_ledger_verify($1)`, [TENANT]);
    expect(verify.ok).toBe(true);
  });

  test('a FileHandler outage leaves the approval committed and the sync pending in the outbox', async () => {
    filehandler.setReserves.mockRejectedValueOnce(new Error('FileHandler 503'));
    const claimId = await seedClaim();
    const req = await proposeReserve(claimId);
    const { request } = await approvals.decide(req.id, { decision: 'approve', decider: SUP, rationale: WHY });
    expect(request.status).toBe('executed');
    expect(await db(`SELECT status, attempts, last_error FROM integration_outbox WHERE claim_id = $1`, [claimId]))
      .toEqual([{ status: 'pending', attempts: 1, last_error: 'FileHandler 503' }]);
  });
});

describe('atomicity: no unaudited state change', () => {
  test('a proposal whose ledger entry fails is not queued at all', async () => {
    const claimId = await seedClaim();
    await blockLedger('action.proposed', () =>
      expect(proposeReserve(claimId)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE', status: 503 }));
    expect(await db(`SELECT * FROM action_requests WHERE claim_id = $1`, [claimId])).toEqual([]);
  });

  test('a decision whose ledger entry fails is not recorded', async () => {
    const claimId = await seedClaim();
    const req = await proposeReserve(claimId);
    await blockLedger('action.approved', () =>
      expect(approvals.decide(req.id, { decision: 'approve', decider: SUP, rationale: WHY }))
        .rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' }));
    expect(await db(`SELECT status, decision, decided_by FROM action_requests WHERE id = $1`, [req.id]))
      .toEqual([{ status: 'pending_approval', decision: null, decided_by: null }]);
  });

  test('an execution whose ledger entry fails leaves NO effect behind, and is retryable', async () => {
    const claimId = await seedClaim();
    const req = await proposeReserve(claimId);
    const { request } = await blockLedger('reserve.approved', () =>
      approvals.decide(req.id, { decision: 'approve', decider: SUP, rationale: WHY }));

    expect(request).toMatchObject({ status: 'execution_failed', execution_attempts: 1 });
    expect(request.execution_error).toMatch(/Audit ledger append failed for reserve.approved/);
    for (const table of ['reserves', 'claim_events', 'integration_outbox']) {
      expect({ table, rows: await db(`SELECT * FROM ${table} WHERE claim_id = $1`, [claimId]) }).toEqual({ table, rows: [] });
    }
    expect(filehandler.setReserves).not.toHaveBeenCalled();
    expect((await ledgerFor(req.id)).map(e => e.action)).toEqual(['action.proposed', 'action.approved', 'action.execution_failed']);

    const retried = await approvals.execute(req.id, SUP);
    expect(retried.request).toMatchObject({ status: 'executed', execution_attempts: 2 });
    expect(await db(`SELECT count(*)::int AS n FROM reserves WHERE claim_id = $1`, [claimId])).toEqual([{ n: 1 }]);
  });

  test('a database failure inside the executor rolls back the executing claim too', async () => {
    const claimId = await seedClaim();
    const req = await proposeReserve(claimId);
    await db(`ALTER TABLE reserves ADD CONSTRAINT test_block_reserves CHECK (medical < 0) NOT VALID`);
    let out;
    try {
      out = await approvals.decide(req.id, { decision: 'approve', decider: SUP, rationale: WHY });
    } finally {
      await db('ALTER TABLE reserves DROP CONSTRAINT test_block_reserves');
    }
    // Never stuck in 'executing': the claim rolled back with the effect.
    expect(out.request.status).toBe('execution_failed');
    expect(await db(`SELECT count(*)::int AS n FROM claim_events WHERE claim_id = $1`, [claimId])).toEqual([{ n: 0 }]);
  });
});

describe('races resolve to exactly one winner', () => {
  test('two supervisors approving at once: one decision, one execution, one reserve', async () => {
    const claimId = await seedClaim();
    const req = await proposeReserve(claimId);
    const results = await Promise.allSettled([
      approvals.decide(req.id, { decision: 'approve', decider: SUP, rationale: WHY }),
      approvals.decide(req.id, { decision: 'approve', decider: SUP2, rationale: WHY }),
    ]);
    const won = results.filter(r => r.status === 'fulfilled');
    const lost = results.filter(r => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost.map(r => r.reason.code)).toEqual(['NOT_PENDING']);
    expect(await db(`SELECT count(*)::int AS n FROM reserves WHERE claim_id = $1`, [claimId])).toEqual([{ n: 1 }]);
    expect((await ledgerFor(req.id)).filter(e => e.action === 'action.approved')).toHaveLength(1);
  });

  test('two retries of a failed execution at once: one execution', async () => {
    const claimId = await seedClaim();
    const req = await proposeReserve(claimId);
    await blockLedger('reserve.approved', () =>
      approvals.decide(req.id, { decision: 'approve', decider: SUP, rationale: WHY }));

    const results = await Promise.allSettled([approvals.execute(req.id, SUP), approvals.execute(req.id, SUP2)]);
    const executed = results.filter(r => r.status === 'fulfilled' && r.value.request.status === 'executed');
    expect(executed.length).toBeGreaterThanOrEqual(1);
    for (const r of results.filter(x => x.status === 'rejected')) expect(r.reason.code).toBe('NOT_EXECUTABLE');
    expect(await db(`SELECT count(*)::int AS n FROM reserves WHERE claim_id = $1`, [claimId])).toEqual([{ n: 1 }]);
    expect((await ledgerFor(req.id)).filter(e => e.action === 'action.executed')).toHaveLength(1);
  });
});

describe('RFA approval', () => {
  async function seedRfa(claimId) {
    const id = crypto.randomUUID();
    await db(`INSERT INTO rfas (id, claim_id, treatment_description, cpt_codes, received_at, response_due_at, decision)
              VALUES ($1, $2, 'PT 2x/week', ARRAY['97110'], now(), now() + interval '5 days', 'pending_adjuster_review')`,
    [id, claimId]);
    await db(`INSERT INTO diaries (id, claim_id, rfa_id, diary_type, status) VALUES ($1, $2, $3, 'RFA_RESPONSE_DUE', 'open')`,
      [`diy_${id}`, claimId, id]);
    return id;
  }

  test('a direct approval commits decision, event, diary completion, ledger entry and letter job together', async () => {
    const claimId = await seedClaim();
    const rfaId = await seedRfa(claimId);
    const rfa = await rfaService.adjusterApproveRFA(rfaId, 'adj@tpa.test', { actor: ADJ });
    expect(rfa).toMatchObject({ decision: 'adjuster_approved', decision_made_by: 'adj@tpa.test' });
    expect(await db(`SELECT status FROM diaries WHERE rfa_id = $1`, [rfaId])).toEqual([{ status: 'completed' }]);
    expect(await db(`SELECT type FROM claim_events WHERE claim_id = $1`, [claimId])).toEqual([{ type: 'rfa_approved' }]);
    expect(await db(`SELECT actor_id, payload FROM audit_ledger WHERE action = 'rfa.approved' AND entity_id = $1`, [rfaId]))
      .toEqual([{ actor_id: 'adj@tpa.test', payload: { decision: 'adjuster_approved', path: 'direct' } }]);
    expect(await db(`SELECT queue, status, payload FROM jobs WHERE claim_id = $1`, [claimId]))
      .toEqual([{ queue: 'notice.rfa_letter', status: 'pending', payload: { rfaId } }]);
  });

  test('an unknown or malformed RFA id is "not found", not a database error', async () => {
    await expect(rfaService.adjusterApproveRFA('rfa_not_a_uuid', 'adj@tpa.test', { actor: ADJ })).resolves.toBeNull();
    await expect(rfaService.adjusterApproveRFA(crypto.randomUUID(), 'adj@tpa.test', { actor: ADJ })).resolves.toBeNull();
  });

  test('if any part fails, the RFA stays undecided with its diary open and no letter queued', async () => {
    const claimId = await seedClaim();
    const rfaId = await seedRfa(claimId);
    await blockLedger('rfa.approved', () =>
      expect(rfaService.adjusterApproveRFA(rfaId, 'adj@tpa.test', { actor: ADJ })).rejects.toThrow(/rfa.approved/));
    expect(await db(`SELECT decision FROM rfas WHERE id = $1`, [rfaId])).toEqual([{ decision: 'pending_adjuster_review' }]);
    expect(await db(`SELECT status FROM diaries WHERE rfa_id = $1`, [rfaId])).toEqual([{ status: 'open' }]);
    expect(await db(`SELECT * FROM claim_events WHERE claim_id = $1`, [claimId])).toEqual([]);
    expect(await db(`SELECT * FROM jobs WHERE claim_id = $1`, [claimId])).toEqual([]);
  });

  test('an agent proposal executes as the approving human; a decision taken meanwhile is not overwritten', async () => {
    const claimId = await seedClaim();
    const rfaId = await seedRfa(claimId);
    const { request: req } = await approvals.propose({
      actionType: 'medical.rfa.approve', claimId, proposer: agentPrincipal('rfa_mtus_evaluation', TENANT),
      payload: { rfa_id: rfaId }, rationale: 'MTUS-consistent PT request.', evidence: [{ type: 'rfa', id: rfaId }],
    });

    // The RFA is decided another way after the decision-time precheck passed:
    // the executor's re-check under the row lock must refuse to overwrite it.
    jest.spyOn(getExecutor('medical.rfa.approve'), 'precheck').mockImplementation(async () => {
      await db(`UPDATE rfas SET decision = 'uro_pending' WHERE id = $1`, [rfaId]);
    });
    const { request } = await approvals.decide(req.id, { decision: 'approve', decider: ADJ2, rationale: WHY });
    expect(request).toMatchObject({ status: 'execution_failed' });
    expect(request.execution_error).toMatch(/already decided \(uro_pending\)/);
    expect(await db(`SELECT decision FROM rfas WHERE id = $1`, [rfaId])).toEqual([{ decision: 'uro_pending' }]);
    expect(await db(`SELECT * FROM jobs WHERE claim_id = $1`, [claimId])).toEqual([]);
  });

  test('approving the agent proposal records the approver, not the agent', async () => {
    const claimId = await seedClaim();
    const rfaId = await seedRfa(claimId);
    const { request: req } = await approvals.propose({
      actionType: 'medical.rfa.approve', claimId, proposer: agentPrincipal('rfa_mtus_evaluation', TENANT),
      payload: { rfa_id: rfaId }, rationale: 'MTUS-consistent PT request.',
    });
    const { request } = await approvals.decide(req.id, { decision: 'approve', decider: ADJ2, rationale: WHY });
    expect(request.status).toBe('executed');
    expect(await db(`SELECT decision, decision_made_by FROM rfas WHERE id = $1`, [rfaId]))
      .toEqual([{ decision: 'adjuster_approved', decision_made_by: 'adj2@tpa.test' }]);
    expect(await db(`SELECT actor_id, payload->>'path' AS path FROM audit_ledger WHERE action = 'rfa.approved' AND entity_id = $1`, [rfaId]))
      .toEqual([{ actor_id: 'adj2@tpa.test', path: 'action_request' }]);
  });
});
