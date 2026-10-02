'use strict';

/**
 * Durable job queue against real PostgreSQL (ADR-0006).
 */

jest.mock('../../src/services/supabase', () => require('./pgSupabase'));

const config   = require('../../src/config');
const jobQueue = require('../../src/services/jobQueue');
const registry = require('../../src/jobs/registry');
const { runInTransaction } = require('../../src/db/unitOfWork');
const { getPool, closePool } = require('../../src/db/pool');

const TENANT = '00000000-0000-0000-0000-000000000001';
const Q = 'rfa.evaluate';           // any registered queue; its handler is stubbed per test
let n = 0;
const uid = (p) => `${p}_${process.pid}_${++n}`;
const db = (sql, params) => getPool().query(sql, params).then(r => r.rows);
const job = async (id) => (await db('SELECT * FROM jobs WHERE id = $1', [id]))[0];

async function seedClaim() {
  const id = uid('claim_jq');
  await db(`INSERT INTO claims (id, claim_number, status, date_of_injury) VALUES ($1, $2, 'new_claim', '2026-05-01')`, [id, `JQ-${id}`]);
  return id;
}

let handler;
beforeEach(async () => {
  await db('DELETE FROM jobs');
  handler = jest.spyOn(registry.QUEUES[Q], 'run').mockResolvedValue();
  config.jobs.kick = false;
});
afterEach(() => jest.restoreAllMocks());
afterAll(closePool);

describe('enqueue', () => {
  test('inside a unit of work: the job exists only if the unit commits', async () => {
    await expect(runInTransaction({ tenantId: TENANT }, async (tx) => {
      await jobQueue.enqueue({ queue: Q, payload: { rfaId: 'r1' } }, { tx });
      throw new Error('the change failed');
    })).rejects.toThrow('the change failed');
    expect(await db('SELECT * FROM jobs')).toEqual([]);

    const { id } = await runInTransaction({ tenantId: TENANT }, (tx) =>
      jobQueue.enqueue({ queue: Q, payload: { rfaId: 'r2' }, correlationId: 'corr-1' }, { tx }));
    expect(await job(id)).toMatchObject({ queue: Q, status: 'pending', payload: { rfaId: 'r2' }, correlation_id: 'corr-1', tenant_id: TENANT });
  });

  test('an idempotency key makes a repeated enqueue a no-op', async () => {
    const a = await jobQueue.enqueue({ queue: Q, payload: { rfaId: 'x' }, idempotencyKey: 'rfa.evaluate:x' });
    const b = await jobQueue.enqueue({ queue: Q, payload: { rfaId: 'x' }, idempotencyKey: 'rfa.evaluate:x' });
    expect(a.duplicate).toBe(false);
    expect(b).toEqual({ id: null, duplicate: true });
    expect(await db('SELECT count(*)::int AS n FROM jobs')).toEqual([{ n: 1 }]);
  });

  test('uses the queue\'s registered retry budget unless overridden', async () => {
    const { id } = await jobQueue.enqueue({ queue: 'claim.legacy_writeback', payload: { claimId: 'c', change: {} } });
    expect((await job(id)).max_attempts).toBe(1);
    const { id: id2 } = await jobQueue.enqueue({ queue: Q, payload: {}, maxAttempts: 2 });
    expect((await job(id2)).max_attempts).toBe(2);
  });

  test('after commit, the API process kicks a due job immediately', async () => {
    config.jobs.kick = true;
    const { id } = await runInTransaction({ tenantId: TENANT }, (tx) =>
      jobQueue.enqueue({ queue: Q, payload: { rfaId: 'kick' } }, { tx }));
    for (let i = 0; i < 50 && (await job(id)).status !== 'succeeded'; i++) await new Promise(r => setTimeout(r, 20));
    expect((await job(id)).status).toBe('succeeded');
    expect(handler).toHaveBeenCalledWith({ rfaId: 'kick' }, expect.objectContaining({ mode: 'pg' }));
  });
});

describe('workers', () => {
  test('a due job runs once and is marked succeeded', async () => {
    const { id } = await jobQueue.enqueue({ queue: Q, payload: { rfaId: 'ok' } });
    expect(await jobQueue.runOnce()).toEqual({ claimed: 1, succeeded: 1, retried: 0, dead: 0 });
    expect(await job(id)).toMatchObject({ status: 'succeeded', attempts: 1, locked_by: null, last_error: null });
    expect((await job(id)).finished_at).toEqual(expect.any(String));
    expect(await jobQueue.runOnce()).toEqual({ claimed: 0, succeeded: 0, retried: 0, dead: 0 });
  });

  test('a job scheduled for later is not run early', async () => {
    await jobQueue.enqueue({ queue: Q, payload: {}, runAt: new Date(Date.now() + 3600e3).toISOString() });
    expect((await jobQueue.runOnce()).claimed).toBe(0);
  });

  test('a failure is retried later with backoff, keeping the error', async () => {
    handler.mockRejectedValueOnce(new Error('vendor timeout'));
    const { id } = await jobQueue.enqueue({ queue: Q, payload: {} });
    expect(await jobQueue.runOnce()).toMatchObject({ claimed: 1, retried: 1 });
    const j = await job(id);
    expect(j).toMatchObject({ status: 'pending', attempts: 1, last_error: 'vendor timeout', locked_by: null });
    const delay = (Date.parse(j.run_at) - Date.now()) / 1000;
    expect(delay).toBeGreaterThan(20);            // 30 s ± 20 %
    expect(delay).toBeLessThan(40);

    await db(`UPDATE jobs SET run_at = now() WHERE id = $1`, [id]);   // time passes
    expect(await jobQueue.runOnce()).toMatchObject({ succeeded: 1 });
    expect(await job(id)).toMatchObject({ status: 'succeeded', attempts: 2, last_error: null });
  });

  test('exhausted attempts dead-letter the job with a ledger entry and a claim diary', async () => {
    handler.mockRejectedValue(new Error('still broken'));
    const claimId = await seedClaim();
    const { id } = await jobQueue.enqueue({ queue: Q, payload: {}, claimId, maxAttempts: 2, correlationId: 'corr-dead' });
    await jobQueue.runOnce();
    await db(`UPDATE jobs SET run_at = now() WHERE id = $1`, [id]);
    expect(await jobQueue.runOnce()).toMatchObject({ dead: 1 });

    expect(await job(id)).toMatchObject({ status: 'dead', attempts: 2, last_error: 'still broken' });
    const [entry] = await db(`SELECT * FROM audit_ledger WHERE action = 'job.dead' AND entity_id = $1`, [String(id)]);
    expect(entry).toMatchObject({
      actor_type: 'system', actor_id: 'system:job-queue', claim_id: claimId, correlation_id: 'corr-dead',
      payload: { queue: Q, attempts: 2, max_attempts: 2, last_error: 'still broken' },
    });
    const diaries = await db(`SELECT * FROM diaries WHERE claim_id = $1`, [claimId]);
    expect(diaries).toEqual([expect.objectContaining({ diary_type: 'BACKGROUND_JOB_FAILED', status: 'open', priority: 'HIGH' })]);
    expect(diaries[0].notes).toContain(Q);
  });

  test('if the dead-letter record cannot be written, nothing of it commits and the job is retried later', async () => {
    handler.mockRejectedValue(new Error('broken'));
    const claimId = await seedClaim();
    const { id } = await jobQueue.enqueue({ queue: Q, payload: {}, claimId, maxAttempts: 1 });
    await db(`ALTER TABLE diaries ADD CONSTRAINT test_block_job_diary
                CHECK (diary_type <> 'BACKGROUND_JOB_FAILED') NOT VALID`);
    try {
      await jobQueue.runOnce();
    } finally {
      await db('ALTER TABLE diaries DROP CONSTRAINT test_block_job_diary');
    }
    // Neither the dead state nor its ledger entry committed without the diary.
    expect(await job(id)).toMatchObject({ status: 'running', attempts: 1 });
    expect(await db(`SELECT 1 FROM audit_ledger WHERE action = 'job.dead' AND entity_id = $1`, [String(id)])).toEqual([]);

    // Once the lease expires, a worker reclaims it and dead-letters it properly.
    await db(`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await jobQueue.runOnce()).toMatchObject({ dead: 1 });
    expect(await db(`SELECT count(*)::int AS n FROM audit_ledger WHERE action = 'job.dead' AND entity_id = $1`, [String(id)]))
      .toEqual([{ n: 1 }]);
    expect(await db(`SELECT count(*)::int AS n FROM diaries WHERE claim_id = $1`, [claimId])).toEqual([{ n: 1 }]);
  });

  test('a job left running by a dead worker is reclaimed when its lease expires', async () => {
    const { id } = await jobQueue.enqueue({ queue: Q, payload: {} });
    await db(`UPDATE jobs SET status = 'running', locked_by = 'crashed-worker', attempts = 1,
                         locked_until = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await jobQueue.runOnce()).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await job(id)).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  test('a live lease is respected', async () => {
    const { id } = await jobQueue.enqueue({ queue: Q, payload: {} });
    await db(`UPDATE jobs SET status = 'running', locked_by = 'busy-worker', attempts = 1,
                         locked_until = now() + interval '5 minutes' WHERE id = $1`, [id]);
    expect((await jobQueue.runOnce()).claimed).toBe(0);
  });

  test('a worker that lost its lease cannot overwrite the new owner\'s outcome', async () => {
    const { id } = await jobQueue.enqueue({ queue: Q, payload: {} });
    handler.mockImplementationOnce(async () => {
      // While worker A runs, its lease is reclaimed and the job completes elsewhere.
      await db(`UPDATE jobs SET status = 'succeeded', locked_by = NULL, locked_until = NULL, finished_at = now() WHERE id = $1`, [id]);
      throw new Error('late failure from the old owner');
    });
    await jobQueue.runOnce({ workerId: 'worker-a' });
    expect(await job(id)).toMatchObject({ status: 'succeeded', last_error: null });
  });

  test('a reclaimed job on its final attempt is dead-lettered instead of running again', async () => {
    const { id } = await jobQueue.enqueue({ queue: Q, payload: {}, maxAttempts: 1 });
    await db(`UPDATE jobs SET status = 'running', locked_by = 'crashed', attempts = 1,
                         locked_until = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await jobQueue.runOnce()).toMatchObject({ dead: 1 });
    expect(handler).not.toHaveBeenCalled();
    expect((await job(id)).last_error).toMatch(/lease expired on the final attempt/);
  });

  test('a row for an unregistered queue is dead-lettered, not silently skipped', async () => {
    const [{ id }] = await db(`INSERT INTO jobs (queue) VALUES ('retired.queue') RETURNING id`);
    expect(await jobQueue.runOnce()).toMatchObject({ dead: 1 });
    expect((await job(id)).last_error).toMatch(/no handler registered/);
  });

  test('concurrent workers run each job exactly once', async () => {
    const seen = [];
    handler.mockImplementation(async (p) => { seen.push(p.i); await new Promise(r => setTimeout(r, 5)); });
    for (let i = 0; i < 30; i++) await jobQueue.enqueue({ queue: Q, payload: { i } });
    const workers = ['w1', 'w2', 'w3', 'w4'].map(async (w) => {
      let total = 0;
      for (;;) {
        const s = await jobQueue.runOnce({ limit: 3, workerId: w });
        total += s.succeeded;
        if (!s.claimed) return total;
      }
    });
    const totals = await Promise.all(workers);
    expect(totals.reduce((a, b) => a + b, 0)).toBe(30);
    expect(seen.sort((a, b) => a - b)).toEqual([...Array(30).keys()]);
    expect(await db(`SELECT count(*)::int AS n FROM jobs WHERE status = 'succeeded'`)).toEqual([{ n: 30 }]);
  });

  test('the poller drains work and stops cleanly', async () => {
    for (let i = 0; i < 5; i++) await jobQueue.enqueue({ queue: Q, payload: { i } });
    const poller = jobQueue.startPoller({ intervalMs: 20, limit: 2 });
    for (let i = 0; i < 100 && handler.mock.calls.length < 5; i++) await new Promise(r => setTimeout(r, 10));
    await poller.stop();
    expect(handler).toHaveBeenCalledTimes(5);
  });
});

describe('operations', () => {
  const ADMIN = { type: 'human', id: 'ops@tpa.test', role: 'admin', tenantId: TENANT };

  test('list is tenant-scoped and filterable', async () => {
    await jobQueue.enqueue({ queue: Q, payload: {} });
    await jobQueue.enqueue({ queue: Q, payload: {}, tenantId: TENANT, runAt: new Date(Date.now() + 1e6).toISOString() });
    expect(await jobQueue.list({ tenantId: TENANT, status: 'pending' })).toHaveLength(2);
    expect(await jobQueue.list({ tenantId: '00000000-0000-0000-0000-0000000000ff' })).toEqual([]);
    await expect(jobQueue.list({})).rejects.toThrow(/tenantId is required/);
  });

  test('a dead job can be re-queued by an operator, and that is ledgered', async () => {
    handler.mockRejectedValueOnce(new Error('broken'));
    const { id } = await jobQueue.enqueue({ queue: Q, payload: {}, maxAttempts: 1 });
    await jobQueue.runOnce();
    expect((await job(id)).status).toBe('dead');

    const requeued = await jobQueue.requeueDead(id, ADMIN);
    expect(requeued).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await jobQueue.requeueDead(id, ADMIN)).toBeNull();          // only dead jobs
    expect(await db(`SELECT actor_id FROM audit_ledger WHERE action = 'job.requeued' AND entity_id = $1`, [String(id)]))
      .toEqual([{ actor_id: 'ops@tpa.test' }]);
    expect(await jobQueue.runOnce()).toMatchObject({ succeeded: 1 });
  });
});
