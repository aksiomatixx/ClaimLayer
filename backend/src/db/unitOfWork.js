'use strict';

/**
 * Unit of work (ADR-0006).
 *
 *   const result = await runInTransaction({ tenantId, actorId }, async (tx) => {
 *     ...state change...
 *     await auditLedger.append(entry, { tx });   // same transaction
 *     await jobQueue.enqueue(tx, { queue, payload }); // same transaction
 *   });
 *
 * In 'pg' mode everything inside fn commits or rolls back together, and
 * the transaction carries `app.tenant_id` / `app.actor_id` settings for
 * triggers and row-level security. Deadlocks and serialization failures
 * are retried: fn must therefore only touch the database — external side
 * effects belong in the outbox or a job, enqueued inside fn.
 *
 * afterCommit hooks run once, after a successful commit, and never throw
 * into the caller (they are opportunistic: anything they do must also be
 * recoverable by a worker).
 */

const config   = require('../config');
const logger   = require('../logger');
const { getPool } = require('./pool');
const { pgAdapter, compatAdapter } = require('./adapters');

const RETRYABLE = new Set(['40P01', '40001']); // deadlock_detected, serialization_failure
const MAX_ATTEMPTS = 3;

function isTransactional() {
  return !!getPool();
}

async function _runHooks(hooks) {
  for (const fn of hooks) {
    try {
      await fn();
    } catch (e) {
      logger.error({ msg: 'unitOfWork: afterCommit hook failed (recoverable by worker)', err: e.message });
    }
  }
}

async function runInTransaction({ tenantId, actorId = null, label = 'unit_of_work' } = {}, fn) {
  const tenant = tenantId || config.tenancy.defaultTenantId;
  const pool = getPool();

  if (!pool) {
    if (config.nodeEnv === 'production') {
      // Defense in depth: config validation already refuses to boot.
      throw new Error('DATABASE_URL is required in production — consequential writes must be transactional');
    }
    const { supabase } = require('../services/supabase');
    const tx = compatAdapter(supabase, { tenantId: tenant });
    const result = await fn(tx);
    await _runHooks(tx._hooks);
    return result;
  }

  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    let tx;
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)`,
        [tenant, actorId || '']);
      tx = pgAdapter(client, { tenantId: tenant });
      const result = await fn(tx);
      await client.query('COMMIT');
      client.release();
      await _runHooks(tx._hooks);
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
      client.release();
      if (RETRYABLE.has(e.code) && attempt < MAX_ATTEMPTS) {
        logger.warn({ msg: 'unitOfWork: retrying after transient conflict', label, code: e.code, attempt });
        continue;
      }
      throw e;
    }
  }
}

module.exports = { runInTransaction, isTransactional, RETRYABLE, MAX_ATTEMPTS };
