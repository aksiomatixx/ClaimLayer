'use strict';

/**
 * Integration tests — action requests: propose → decide → execute (ADR-0004).
 *
 * The reserve-change path end to end over HTTP: authority by amount, claim
 * escalation, self-approval, MFA step-up, modification, rejection, races,
 * idempotency, execution failure + retry, tenant isolation, and the audit
 * ledger trail each step leaves.
 *
 * Run: npm test -- tests/integration/action-requests.test.js
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));
jest.mock('../../src/services/aiService');
jest.mock('../../src/services/filehandler', () => ({
  createClaim: jest.fn(), createDiary: jest.fn(), completeDiary: jest.fn(), addNote: jest.fn(),
  setReserves: jest.fn().mockResolvedValue({ ok: true }),
}));

const request      = require('supertest');
const app          = require('../../src/index');
const filehandler  = require('../../src/services/filehandler');
const claimService = require('../../src/services/claimService');
const approvals    = require('../../src/services/approvalService');
const { supabase } = require('../../src/services/supabase');
const { generateStaffToken, generateEmployerToken } = require('../../src/middleware/auth');
const { agentPrincipal } = require('../../src/policy/principal');

const OTHER_TENANT = '00000000-0000-0000-0000-0000000000b2';
const CLAIM = 'claim_ar_1';

const token = (role, email, extra = {}) =>
  `Bearer ${generateStaffToken({ role, sub: email, email, mfa: true, ...extra })}`;
const ADJ       = token('adjuster', 'adj1@tpa.test');
const ADJ2      = token('adjuster', 'adj2@tpa.test');
const SUP       = token('supervisor', 'sup@tpa.test');
const SUP_NOMFA = token('supervisor', 'sup@tpa.test', { mfa: false });
const SUP_OTHER_TENANT = token('supervisor', 'sup-b@other.test', { tenantId: OTHER_TENANT });

const RESERVES_60K = { medical_cents: 3_500_000, indemnity_cents: 2_000_000, expense_cents: 500_000, reason: 'Surgery recommended per PR-2' };

function seedClaim(overrides = {}) {
  claimService._seedClaim({
    id: CLAIM, claimNumber: 'CL-2026-AR1', status: 'accepted', employerId: 'emp-1',
    dateOfInjury: '2026-05-01', filehandlerId: 'fh_ar_1', employee: {}, events: [], diaries: [],
    ...overrides,
  });
}

async function propose(auth = ADJ, payload = RESERVES_60K, extra = {}) {
  return request(app).post(`/api/v1/claims/${CLAIM}/action-requests`).set('Authorization', auth)
    .send({ action_type: 'reserve.change', payload, rationale: 'Exceeds my authority; surgery now likely.', ...extra });
}

async function decide(id, auth, body) {
  return request(app).post(`/api/v1/action-requests/${id}/decision`).set('Authorization', auth).send(body);
}

async function ledger() {
  const { data } = await supabase.from('audit_ledger').select('*');
  return (data || []).sort((a, b) => a.seq - b.seq);
}

beforeEach(() => {
  supabase._resetStore();
  claimService._resetClaims();
  filehandler.setReserves.mockClear();
  filehandler.setReserves.mockResolvedValue({ ok: true });
  seedClaim();
});

describe('proposal', () => {
  test('an adjuster escalates a reserve change above their authority', async () => {
    const res = await propose();
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({
      status: 'pending_approval', proposed_by: 'adj1@tpa.test', proposed_by_type: 'human',
      amount_cents: 6_000_000, required_approver_role: 'supervisor',
      policy_version: 'authority-default@2026-10-01',
    });
    expect(res.body.request.authority_evaluation.withinAuthority).toBe(false);
    const [entry] = await ledger();
    expect(entry).toMatchObject({ action: 'action.proposed', actor_id: 'adj1@tpa.test', claim_id: CLAIM });
  });

  test('payloads in dollars or with fractional cents are refused', async () => {
    const res = await propose(ADJ, { ...RESERVES_60K, medical_cents: 35000.5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PAYLOAD');
  });

  test('a proposal needs a real rationale', async () => {
    const res = await propose(ADJ, RESERVES_60K, { rationale: 'ok' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('RATIONALE_REQUIRED');
  });

  test('unknown action types are refused', async () => {
    const res = await propose(ADJ, RESERVES_60K, { action_type: 'claim.delete' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNKNOWN_ACTION');
  });

  test('the same idempotency key never creates a second request', async () => {
    const a = await propose(ADJ, RESERVES_60K, { idempotency_key: 'reserve-review-2026-10-01' });
    const b = await propose(ADJ, RESERVES_60K, { idempotency_key: 'reserve-review-2026-10-01' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ idempotent: true, request: { id: a.body.request.id } });
  });

  test('an idempotency key cannot be replayed against another claim (no cross-record lookup)', async () => {
    await propose(ADJ, RESERVES_60K, { idempotency_key: 'shared-key-0000001' });
    claimService._seedClaim({
      id: 'claim_ar_2', claimNumber: 'CL-2026-AR2', status: 'accepted', employerId: 'emp-2',
      dateOfInjury: '2026-05-02', filehandlerId: 'fh_ar_2', employee: {}, events: [], diaries: [],
    });
    const res = await request(app).post('/api/v1/claims/claim_ar_2/action-requests').set('Authorization', ADJ2)
      .send({ action_type: 'reserve.change', payload: RESERVES_60K,
              rationale: 'Different claim, same key.', idempotency_key: 'shared-key-0000001' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'IDEMPOTENCY_KEY_CONFLICT', message: 'This idempotency key is already in use' });
  });

  test('a litigated claim escalates even a small reserve change', async () => {
    claimService._resetClaims();
    seedClaim({ status: 'litigated' });
    const res = await propose(ADJ, { medical_cents: 1_000_000, indemnity_cents: 0, expense_cents: 0, reason: 'Defense costs' });
    expect(res.body.request.required_approver_role).toBe('supervisor');
    expect(res.body.request.authority_evaluation.reasons.join(' ')).toMatch(/litigated_claim/);
  });

  test('client portal users cannot reach the approval queue', async () => {
    const employer = `Bearer ${generateEmployerToken({ sub: 'e1', employerId: 'emp-1' })}`;
    expect((await propose(employer)).status).toBe(403);
    expect((await request(app).get('/api/v1/action-requests').set('Authorization', employer)).status).toBe(403);
  });
});

describe('decision', () => {
  test('nobody approves their own proposal', async () => {
    const { body } = await propose();
    const res = await decide(body.request.id, ADJ, { decision: 'approve', rationale: 'Approving my own request.' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('SELF_APPROVAL');
  });

  test('a peer without enough authority cannot approve', async () => {
    const { body } = await propose();
    const res = await decide(body.request.id, ADJ2, { decision: 'approve', rationale: 'Looks reasonable to me.' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'INSUFFICIENT_AUTHORITY', details: { required_role: 'supervisor' } });
    expect(filehandler.setReserves).not.toHaveBeenCalled();
  });

  test('approving a financial action requires an MFA-verified session', async () => {
    const { body } = await propose();
    const res = await decide(body.request.id, SUP_NOMFA, { decision: 'approve', rationale: 'Supported by the PR-2.' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MFA_REQUIRED');
  });

  test('a decision needs a rationale', async () => {
    const { body } = await propose();
    const res = await decide(body.request.id, SUP, { decision: 'approve', rationale: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('RATIONALE_REQUIRED');
  });

  test('an authorized supervisor approves → the system executes as the approver → full ledger trail', async () => {
    const { body } = await propose();
    const res = await decide(body.request.id, SUP, { decision: 'approve', rationale: 'Surgical recommendation supports the increase.' });

    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({
      status: 'executed', decision: 'approve', decided_by: 'sup@tpa.test', executed_by: 'sup@tpa.test',
      execution_result: { total_cents: 6_000_000 },
    });
    expect(filehandler.setReserves).toHaveBeenCalledWith(
      'fh_ar_1', expect.objectContaining({ medical: 35000, indemnity: 20000, expense: 5000 }),
      'ADJUSTER', 'sup@tpa.test');

    const trail = await ledger();
    expect(trail.map(e => [e.action, e.actor_id])).toEqual([
      ['action.proposed', 'adj1@tpa.test'],
      ['action.approved', 'sup@tpa.test'],
      ['reserve.approved', 'sup@tpa.test'],
      ['action.executed', 'sup@tpa.test'],
    ]);
    expect(trail[2].evidence).toEqual([{ type: 'action_request', id: body.request.id }]);
    for (let i = 1; i < trail.length; i++) expect(trail[i].prev_hash).toBe(trail[i - 1].hash);
  });

  test('a modification executes the modified amounts and records the diff', async () => {
    const { body } = await propose();
    const res = await decide(body.request.id, SUP, {
      decision: 'modify', rationale: 'Surgery not yet authorized; set medical lower.',
      payload: { ...RESERVES_60K, medical_cents: 1_500_000 },
    });
    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({
      status: 'executed', decision: 'modify',
      modifications: { medical_cents: { from: 3_500_000, to: 1_500_000 } },
      execution_result: { total_cents: 4_000_000 },
    });
    expect((await ledger()).map(e => e.action)).toContain('action.modified');
  });

  test('a modification is re-checked against the approver authority', async () => {
    const { body } = await propose();
    const res = await decide(body.request.id, SUP, {
      decision: 'modify', rationale: 'Raising to cover future surgery as well.',
      payload: { ...RESERVES_60K, medical_cents: 30_000_000 },
    });
    expect(res.status).toBe(403);
    expect(res.body.details.required_role).toBe('claims_manager');
  });

  test('a modify that changes nothing is refused (use approve)', async () => {
    const { body } = await propose();
    const res = await decide(body.request.id, SUP, { decision: 'modify', rationale: 'No change really.', payload: RESERVES_60K });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NO_MODIFICATION');
  });

  test('a rejection records the reason and executes nothing', async () => {
    const { body } = await propose();
    const res = await decide(body.request.id, SUP, { decision: 'reject', rationale: 'No medical support for surgery yet.' });
    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({ status: 'rejected', approved_payload: null });
    expect(filehandler.setReserves).not.toHaveBeenCalled();
    expect((await ledger()).map(e => e.action)).toEqual(['action.proposed', 'action.rejected']);
  });

  test('a peer cannot block an escalation by rejecting it', async () => {
    const { body } = await propose();
    const res = await decide(body.request.id, ADJ2, { decision: 'reject', rationale: 'I would not increase this.' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'INSUFFICIENT_AUTHORITY', details: { required_role: 'supervisor' } });
    const still = await request(app).get(`/api/v1/action-requests/${body.request.id}`).set('Authorization', SUP);
    expect(still.body.request.status).toBe('pending_approval');
  });

  test('a request can be decided only once', async () => {
    const { body } = await propose();
    await decide(body.request.id, SUP, { decision: 'reject', rationale: 'Not supported by the file.' });
    const again = await decide(body.request.id, SUP, { decision: 'approve', rationale: 'Changed my mind later.' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('NOT_PENDING');
  });
});

describe('execution', () => {
  test('a failed execution is recorded, surfaced as 502, and retryable', async () => {
    filehandler.setReserves.mockRejectedValueOnce(new Error('ledger system unavailable'));
    const { body } = await propose();
    const res = await decide(body.request.id, SUP, { decision: 'approve', rationale: 'Supported by the PR-2 findings.' });
    expect(res.status).toBe(502);
    expect(res.body.request).toMatchObject({ status: 'execution_failed', execution_error: 'ledger system unavailable' });

    const retry = await request(app).post(`/api/v1/action-requests/${body.request.id}/execute`).set('Authorization', SUP);
    expect(retry.status).toBe(200);
    expect(retry.body.request).toMatchObject({ status: 'executed', execution_attempts: 2 });
    expect((await ledger()).map(e => e.action)).toEqual(expect.arrayContaining(['action.execution_failed', 'action.executed']));
  });

  test('a retry requires the same authority as the approval', async () => {
    filehandler.setReserves.mockRejectedValueOnce(new Error('ledger system unavailable'));
    const { body } = await propose();
    await decide(body.request.id, SUP, { decision: 'approve', rationale: 'Supported by the PR-2 findings.' });
    const retry = await request(app).post(`/api/v1/action-requests/${body.request.id}/execute`).set('Authorization', ADJ2);
    expect(retry.status).toBe(403);
  });

  test('re-executing an executed request is a no-op', async () => {
    const { body } = await propose();
    await decide(body.request.id, SUP, { decision: 'approve', rationale: 'Supported by the PR-2 findings.' });
    const again = await request(app).post(`/api/v1/action-requests/${body.request.id}/execute`).set('Authorization', SUP);
    expect(again.status).toBe(200);
    expect(filehandler.setReserves).toHaveBeenCalledTimes(1);
  });
});

describe('agents and tenants', () => {
  test('an agent may propose a reserve change but may not decide one', async () => {
    const { request: req } = await approvals.propose({
      actionType: 'reserve.change', claimId: CLAIM, proposer: agentPrincipal('reserve_analysis'),
      payload: { medical_cents: 800_000, indemnity_cents: 0, expense_cents: 0, reason: 'Worksheet total' },
      rationale: 'Itemized worksheet supports $8,000 medical.', evidence: [{ type: 'worksheet', id: 'ws_1' }],
    });
    expect(req).toMatchObject({ proposed_by_type: 'agent', required_approver_role: 'adjuster' });
    await expect(approvals.decide(req.id, {
      decision: 'approve', decider: agentPrincipal('supervisor_qa'), rationale: 'Agent approving agent.',
    })).rejects.toMatchObject({ code: 'HUMAN_DECISION_REQUIRED' });

    // Within an adjuster's authority — and the adjuster is not the proposer.
    const res = await decide(req.id, ADJ, { decision: 'approve', rationale: 'Worksheet lines verified.' });
    expect(res.body.request.status).toBe('executed');
  });

  test('an agent cannot even propose an analyze-only action', async () => {
    await expect(approvals.propose({
      actionType: 'claim.compensability.deny', claimId: CLAIM, proposer: agentPrincipal('compensability_analysis'),
      payload: {}, rationale: 'Facts suggest the injury is not work related.',
    })).rejects.toMatchObject({ code: 'AGENT_ANALYZE_ONLY', status: 403 });
  });

  test('another tenant cannot see or decide the request', async () => {
    const { body } = await propose();
    const read = await request(app).get(`/api/v1/action-requests/${body.request.id}`).set('Authorization', SUP_OTHER_TENANT);
    expect(read.status).toBe(404);
    const res = await decide(body.request.id, SUP_OTHER_TENANT, { decision: 'approve', rationale: 'Cross-tenant attempt.' });
    expect(res.status).toBe(404);
    const queue = await request(app).get('/api/v1/action-requests').set('Authorization', SUP_OTHER_TENANT);
    expect(queue.body.requests).toEqual([]);
  });

  test('another tenant cannot propose against the claim', async () => {
    const res = await propose(SUP_OTHER_TENANT);
    expect(res.status).toBe(404);
  });

  test('the queue lists pending requests for the caller tenant', async () => {
    await propose();
    const res = await request(app).get('/api/v1/action-requests?status=pending_approval').set('Authorization', SUP);
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
  });

  test('the registry endpoint publishes autonomy tiers and executability', async () => {
    const res = await request(app).get('/api/v1/action-registry').set('Authorization', ADJ);
    const reserve = res.body.actions.find(a => a.id === 'reserve.change');
    const deny = res.body.actions.find(a => a.id === 'claim.compensability.deny');
    expect(reserve).toMatchObject({ agent_autonomy: 'prepare_for_approval', executable: true });
    expect(deny).toMatchObject({ agent_autonomy: 'analyze_only', executable: false });
  });
});
