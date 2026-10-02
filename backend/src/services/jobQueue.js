'use strict';

/**
 * jobQueue — durable background work (ADR-0006; table `jobs`, migration
 * 20261002000001_transactional_core.sql). Replaces in-process setImmediate()
 * fire-and-forget calls, which lost their work on any crash, restart or
 * deploy and never retried.
 *
 *   await jobQueue.enqueue({ queue: 'claim.analysis', payload: { claimId }, claimId });
 *   await jobQueue.enqueue({ queue, payload }, { tx });   // inside a unit of work
 *
 * Two modes, chosen like the unit of work:
 *
 * 'pg' (DATABASE_URL set — required in production)
 *   enqueue INSERTs a jobs row — inside the caller's transaction when `tx`
 *   is given, so the job exists if and only if the change that needs it
 *   committed. After commit the API process "kicks" the job for low
 *   latency; workers (src/worker.js, or the in-process poller) claim due
 *   jobs with FOR UPDATE SKIP LOCKED under a lease, retry failures with
 *   exponential backoff, reclaim expired leases, and dead-letter jobs that
 *   exhaust their attempts (audit-ledger entry + a claim diary, never a
 *   silent drop).
 *
 * 'compat' (no DATABASE_URL: the in-memory test suite and the DB-less demo)
 *   The handler runs on the next macrotask (setImmediate) — exactly the
 *   timing of the code this replaced — with errors logged. No durability,
 *   no retry. Production refuses this mode.
 */

const os     = require('os');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');
const { getPool } = require('../db/pool');
const registry    = require('../jobs/registry');

const WORKER_ID       = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
const BASE_BACKOFF_S  = 30;
const MAX_BACKOFF_S   = 3600;
const MAX_ERROR_CHARS = 2000;

/** Seconds before retry `attempt` (1-based): 30s·2^(n−1), capped at 1h, ±20% jitter. */
function backoffSeconds(attempt, rand = Math.random) {
  const base = Math.min(MAX_BACKOFF_S, BASE_BACKOFF_S * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.round(base * (0.8 + 0.4 * rand())));
}

function _definition(queue) {
  const def = registry.get(queue);
  if (!def) throw new Error(`jobQueue: unknown queue '${queue}' (register it in src/jobs/registry.js)`);
  return def;
}

function _json(payload) {
  if (payload == null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('jobQueue: payload must be a plain object');
  }
  return JSON.parse(JSON.stringify(payload)); // the shape a handler sees in either mode
}

// ── compat mode ──────────────────────────────────────────────────────────────

async function _runInline(queue, payload) {
  try {
    await _definition(queue).run(payload, { mode: 'compat', job: null });
  } catch (err) {
    logger.error({ msg: 'jobQueue: inline job failed (compat mode: not retried)', queue, err: err.message });
  }
}

// ── enqueue ──────────────────────────────────────────────────────────────────

/**
 * Enqueue one job. Returns { id, duplicate } in pg mode ({ id: null,
 * duplicate: true } when the idempotency key already exists), or
 * { id: null, mode: 'compat' }.
 *
 * NOTE: in compat mode the handler is scheduled synchronously, before the
 * first await, so callers keep the exact ordering setImmediate gave them.
 */
async function enqueue(job, { tx } = {}) {
  const { queue, payload, runAt = null, idempotencyKey = null, maxAttempts = null,
          claimId = null, correlationId = null, tenantId = null } = job || {};
  const def  = _definition(queue);
  const body = _json(payload);
  const pool = tx ? null : getPool();
  const mode = tx ? tx.mode : (pool ? 'pg' : 'compat');

  if (mode === 'compat') {
    // A delayed job waits for its time (unref'd: it never holds the
    // process open); a due job runs on the next macrotask.
    const delayMs = runAt ? Date.parse(runAt) - Date.now() : 0;
    const schedule = delayMs > 0
      ? () => { setTimeout(() => { _runInline(queue, body); }, delayMs).unref(); }
      : () => setImmediate(() => { _runInline(queue, body); });
    if (tx) tx.afterCommit(schedule); else schedule();
    return { id: null, mode: 'compat' };
  }

  const params = [
    tenantId || tx?.tenantId || config.tenancy.defaultTenantId,
    queue, body, runAt, maxAttempts || def.maxAttempts,
    idempotencyKey, claimId, correlationId,
  ];
  const sql = `
    INSERT INTO jobs (tenant_id, queue, payload, run_at, max_attempts, idempotency_key, claim_id, correlation_id)
    VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5, $6, $7, $8)
    ON CONFLICT (queue, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id, run_at <= now() AS due`;
  const rows = tx ? await tx.query(sql, params) : (await pool.query(sql, params)).rows;
  if (!rows.length) return { id: null, duplicate: true };

  const { id, due } = rows[0];
  if (due && config.jobs.kick) {
    const kick = () => setImmediate(() => {
      runOnce({ ids: [id] }).catch(err =>
        logger.warn({ msg: 'jobQueue: kick failed (a worker will pick the job up)', jobId: id, err: err.message }));
    });
    if (tx) tx.afterCommit(kick); else kick();
  }
  return { id, duplicate: false };
}

// ── workers (pg mode) ────────────────────────────────────────────────────────

function _requirePool() {
  const pool = getPool();
  if (!pool) throw new Error('jobQueue: workers require DATABASE_URL');
  return pool;
}

/**
 * Claim up to `limit` runnable jobs: due pending jobs, plus running jobs
 * whose lease expired (their worker died). Claiming counts as an attempt.
 */
async function _claim(pool, { limit, queues, ids, workerId }) {
  const { rows } = await pool.query(`
    UPDATE jobs j
       SET status = 'running', locked_by = $1, attempts = j.attempts + 1, updated_at = now(),
           locked_until = now() + make_interval(secs => $2)
     WHERE j.id IN (
       SELECT id FROM jobs
        WHERE ((status = 'pending' AND run_at <= now())
               OR (status = 'running' AND locked_until < now()))
          AND ($3::text[] IS NULL OR queue = ANY($3))
          AND ($4::bigint[] IS NULL OR id = ANY($4))
        ORDER BY run_at, id
        LIMIT $5
        FOR UPDATE SKIP LOCKED)
    RETURNING *`,
  [workerId, config.jobs.leaseSeconds, queues || null, ids || null, limit]);
  return rows;
}

async function _succeed(pool, job, workerId) {
  const { rowCount } = await pool.query(`
    UPDATE jobs SET status = 'succeeded', finished_at = now(), updated_at = now(),
                    locked_by = NULL, locked_until = NULL, last_error = NULL
     WHERE id = $1 AND status = 'running' AND locked_by = $2`, [job.id, workerId]);
  if (!rowCount) logger.warn({ msg: 'jobQueue: lease lost before completion was recorded', jobId: job.id, queue: job.queue });
  return rowCount > 0;
}

async function _retry(pool, job, workerId, message) {
  const delay = backoffSeconds(job.attempts);
  const { rowCount } = await pool.query(`
    UPDATE jobs SET status = 'pending', run_at = now() + make_interval(secs => $3), updated_at = now(),
                    locked_by = NULL, locked_until = NULL, last_error = $4
     WHERE id = $1 AND status = 'running' AND locked_by = $2`, [job.id, workerId, delay, message]);
  return rowCount > 0;
}

/** Dead-letter: the job row, its ledger entry and its claim diary commit together. */
async function _deadLetter(job, workerId, message) {
  const { runInTransaction } = require('../db/unitOfWork');
  const auditLedger = require('./auditLedgerService');
  const { systemPrincipal } = require('../policy/principal');

  return runInTransaction({ tenantId: job.tenant_id, actorId: 'system:job-queue', label: 'job.dead' }, async (tx) => {
    const [row] = await tx.query(`
      UPDATE jobs SET status = 'dead', finished_at = now(), updated_at = now(),
                      locked_by = NULL, locked_until = NULL, last_error = $3
       WHERE id = $1 AND status = 'running' AND locked_by = $2
      RETURNING id`, [job.id, workerId, message]);
    if (!row) return false; // lease lost — the new owner decides

    await auditLedger.append({
      actor:         systemPrincipal('job-queue', job.tenant_id),
      action:        'job.dead',
      entity:        { type: 'job', id: job.id },
      claimId:       job.claim_id,
      correlationId: job.correlation_id,
      payload:       { queue: job.queue, attempts: job.attempts, max_attempts: job.max_attempts, last_error: message },
    }, { tx });

    if (job.claim_id) {
      const now = new Date().toISOString();
      await tx.insert('diaries', {
        id:          `diy_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        claim_id:    job.claim_id,
        diary_type:  'BACKGROUND_JOB_FAILED',
        due_date:    now.slice(0, 10),
        assigned_to: config.adjuster.email,
        priority:    'HIGH',
        status:      'open',
        notes:       `Background task ${job.queue} failed after ${job.attempts} attempt(s): ${message}. ` +
                     `It will not run again unless re-queued (job ${job.id}).`,
        created_at:  now,
      });
    }
    return true;
  });
}

async function _process(pool, job, workerId) {
  if (job.attempts > job.max_attempts) {
    // Reclaimed after its worker died on the final attempt.
    await _deadLetter(job, workerId, `lease expired on the final attempt (${job.last_error || 'worker lost'})`);
    return 'dead';
  }
  const def = registry.get(job.queue);
  if (!def) {
    await _deadLetter(job, workerId, `no handler registered for queue '${job.queue}'`);
    return 'dead';
  }
  try {
    await def.run(job.payload, {
      mode: 'pg',
      job: { id: job.id, queue: job.queue, attempt: job.attempts, maxAttempts: job.max_attempts,
             claimId: job.claim_id, correlationId: job.correlation_id },
    });
  } catch (err) {
    const message = String(err && err.message || err).slice(0, MAX_ERROR_CHARS);
    if (job.attempts >= job.max_attempts) {
      logger.error({ msg: 'jobQueue: job dead-lettered', jobId: job.id, queue: job.queue, attempts: job.attempts, err: message });
      await _deadLetter(job, workerId, message);
      return 'dead';
    }
    logger.warn({ msg: 'jobQueue: job failed, will retry', jobId: job.id, queue: job.queue, attempt: job.attempts, err: message });
    await _retry(pool, job, workerId, message);
    return 'retried';
  }
  await _succeed(pool, job, workerId);
  return 'succeeded';
}

/**
 * Claim and run one batch. Returns counts. Safe to call concurrently from
 * any number of processes.
 */
async function runOnce({ limit = 10, queues = null, ids = null, workerId = WORKER_ID } = {}) {
  const pool = _requirePool();
  const jobs = await _claim(pool, { limit, queues, ids, workerId });
  const summary = { claimed: jobs.length, succeeded: 0, retried: 0, dead: 0 };
  for (const job of jobs) {
    try {
      summary[await _process(pool, job, workerId)] += 1;
    } catch (err) {
      // Bookkeeping failed (database unavailable): the lease expires and
      // another worker reclaims the job.
      logger.error({ msg: 'jobQueue: could not record job outcome', jobId: job.id, err: err.message });
    }
  }
  return summary;
}

/**
 * Poll for work until stopped. Drains while batches come back full, then
 * sleeps pollIntervalMs. stop() resolves once the in-flight batch is done.
 */
function startPoller({ intervalMs = config.jobs.pollIntervalMs, limit = 10, workerId = WORKER_ID, onIdle = null } = {}) {
  _requirePool();
  let stopped = false;
  let timer = null;
  let inFlight = Promise.resolve();

  const tick = async () => {
    timer = null;
    if (stopped) return;
    let full = false;
    try {
      const s = await runOnce({ limit, workerId });
      full = s.claimed >= limit;
      if (!full && onIdle) await onIdle();
    } catch (err) {
      logger.error({ msg: 'jobQueue: poll failed', err: err.message });
    }
    if (!stopped) timer = setTimeout(() => { inFlight = tick(); }, full ? 0 : intervalMs);
  };
  inFlight = tick();

  return {
    workerId,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}

// ── operations ───────────────────────────────────────────────────────────────

/** A tenant's jobs, newest first (operations view; payloads omitted). */
async function list({ tenantId, status = null, queue = null, claimId = null, limit = 100 } = {}) {
  if (!tenantId) throw new Error('jobQueue.list: tenantId is required');
  const { rows } = await _requirePool().query(`
    SELECT id, tenant_id, queue, status, attempts, max_attempts, run_at, locked_by, locked_until,
           last_error, idempotency_key, claim_id, correlation_id, created_at, updated_at, finished_at
      FROM jobs
     WHERE tenant_id = $1
       AND ($2::text IS NULL OR status = $2)
       AND ($3::text IS NULL OR queue = $3)
       AND ($4::text IS NULL OR claim_id = $4)
     ORDER BY id DESC
     LIMIT $5`, [tenantId, status, queue, claimId, Math.min(Math.max(1, limit || 100), 500)]);
  return rows;
}

/** Re-queue a dead job (operator action, recorded in the ledger). */
async function requeueDead(jobId, actor) {
  _requirePool();
  const { runInTransaction } = require('../db/unitOfWork');
  const auditLedger = require('./auditLedgerService');
  return runInTransaction({ tenantId: actor.tenantId, actorId: actor.id, label: 'job.requeued' }, async (tx) => {
    const [job] = await tx.query(`
      UPDATE jobs SET status = 'pending', attempts = 0, run_at = now(), finished_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'dead' AND tenant_id = $2
      RETURNING *`, [jobId, actor.tenantId]);
    if (!job) return null;
    await auditLedger.append({
      actor, action: 'job.requeued', entity: { type: 'job', id: job.id }, claimId: job.claim_id,
      payload: { queue: job.queue, last_error: job.last_error },
    }, { tx });
    return job;
  });
}

module.exports = {
  enqueue, runOnce, startPoller, list, requeueDead, backoffSeconds,
  WORKER_ID, BASE_BACKOFF_S, MAX_BACKOFF_S,
};
