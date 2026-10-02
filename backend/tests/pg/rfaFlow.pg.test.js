'use strict';

/**
 * The RFA service flow against the REAL schema (ADR-0006). The in-memory
 * double accepts any column, so a write the schema rejects can pass every
 * mock test; here each step must actually persist.
 */

jest.mock('../../src/services/supabase', () => require('./pgSupabase'));
jest.mock('../../src/services/aiService', () => ({ evaluateRFA: jest.fn(), analyzeCompensability: jest.fn() }));
jest.mock('../../src/services/filehandler', () => ({
  setReserves: jest.fn(), createClaim: jest.fn(), createDiary: jest.fn(), completeDiary: jest.fn(),
  addNote: jest.fn(), attachDocument: jest.fn(),
}));

const config       = require('../../src/config');
const aiService    = require('../../src/services/aiService');
const claimService = require('../../src/services/claimService');
const rfaService   = require('../../src/services/rfaService');
const jobQueue     = require('../../src/services/jobQueue');
const registry     = require('../../src/jobs/registry');
const { humanPrincipal } = require('../../src/policy/principal');
const { getPool, closePool } = require('../../src/db/pool');

const TENANT = '00000000-0000-0000-0000-000000000001';
const ADJ = humanPrincipal({ email: 'adj@tpa.test', role: 'adjuster', mfa: true, tenantId: TENANT });
const db = (sql, params) => getPool().query(sql, params).then(r => r.rows);

let claimId;
beforeAll(async () => {
  config.jobs.kick = false;
  claimId = `claim_rfaflow_${process.pid}`;
  await db(`INSERT INTO claims (id, claim_number, status, date_of_injury, body_part)
            VALUES ($1, $2, 'accepted', '2026-01-05', 'lumbar spine')`, [claimId, `RF-${process.pid % 100000}`]);
  claimService._seedClaim({
    id: claimId, claimNumber: `RF-${process.pid % 100000}`, status: 'accepted', dateOfInjury: '2026-01-05',
    bodyPart: 'lumbar spine', tenantId: TENANT, employee: {}, events: [], diaries: [],
  });
});
afterAll(closePool);

test('create → AI routes to adjuster review → adjuster approves: every step persists', async () => {
  const created = await rfaService.createRFA(claimId, {
    treatmentDescription: 'Physical therapy 2x/week for 6 weeks',
    cptCodes: ['97110'], requestingPhysician: 'Dr. Real Schema', urgency: 'standard',
  }, 'fax');
  expect(created.id).toEqual(expect.any(String));

  const [rfa] = await db('SELECT * FROM rfas WHERE id = $1', [created.id]);
  expect(rfa).toMatchObject({ claim_id: claimId, decision: null });
  expect(await db(`SELECT diary_type, status FROM diaries WHERE rfa_id = $1`, [created.id]))
    .toEqual([{ diary_type: 'RFA_RESPONSE_DUE', status: 'open' }]);
  expect(await db(`SELECT queue FROM jobs WHERE claim_id = $1`, [claimId])).toEqual([{ queue: 'rfa.evaluate' }]);

  // The evaluation job runs (through the queue, as in production).
  aiService.evaluateRFA.mockResolvedValue({
    mtusConsistency: true, withinFrequencyLimits: true, withinDurationLimits: true,
    formularyStatus: 'n_a', recommendedAction: 'physician_review', rationale: 'Consistent; needs a human.',
  });
  const run = jest.spyOn(registry.QUEUES['rfa.evaluate'], 'run');
  // Scope the worker to this test's job: other files share the database.
  const [{ id: jobId }] = await db(`SELECT id FROM jobs WHERE claim_id = $1 AND queue = 'rfa.evaluate'`, [claimId]);
  expect(await jobQueue.runOnce({ ids: [jobId] })).toMatchObject({ claimed: 1, succeeded: 1 });
  expect(run).toHaveBeenCalledWith({ rfaId: created.id }, expect.anything());

  expect(await db('SELECT decision, decision_made_by FROM rfas WHERE id = $1', [created.id]))
    .toEqual([{ decision: 'pending_adjuster_review', decision_made_by: 'ai_system' }]);
  expect(await db('SELECT recommendation FROM rfa_evaluations WHERE rfa_id = $1', [created.id]))
    .toEqual([{ recommendation: 'adjuster_review' }]);

  const approved = await rfaService.adjusterApproveRFA(created.id, 'adj@tpa.test', { actor: ADJ });
  expect(approved).toMatchObject({ decision: 'adjuster_approved', decision_made_by: 'adj@tpa.test' });
  expect(await db(`SELECT status FROM diaries WHERE rfa_id = $1`, [created.id])).toEqual([{ status: 'completed' }]);
  const types = (await db(`SELECT type FROM claim_events WHERE claim_id = $1 ORDER BY timestamp`, [claimId])).map(r => r.type);
  expect(types).toEqual(expect.arrayContaining(['rfa_received', 'rfa_approved']));
});
