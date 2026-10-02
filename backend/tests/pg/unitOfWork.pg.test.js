'use strict';

/**
 * Unit of work against real PostgreSQL (ADR-0006): commit, rollback,
 * transaction-local settings, after-commit hooks, and deadlock retry.
 */

jest.mock('../../src/services/supabase', () => require('./pgSupabase'));

const { runInTransaction, isTransactional, MAX_ATTEMPTS } = require('../../src/db/unitOfWork');
const { getPool, closePool } = require('../../src/db/pool');

const TENANT = '00000000-0000-0000-0000-000000000001';
let seq = 0;
const claimId = () => `claim_uow_${process.pid}_${++seq}`;

async function count(sql, params) {
  const { rows } = await getPool().query(sql, params);
  return rows[0].n;
}

async function insertClaim(tx, id) {
  return tx.insert('claims', { id, claim_number: `UOW-${id}`, status: 'new_claim', date_of_injury: '2026-05-01' });
}

afterAll(closePool);

test('runs in transactional mode when DATABASE_URL is set', () => {
  expect(isTransactional()).toBe(true);
});

test('commits every write in the unit together', async () => {
  const id = claimId();
  await runInTransaction({ tenantId: TENANT }, async (tx) => {
    expect(tx.mode).toBe('pg');
    await insertClaim(tx, id);
    await tx.insert('claim_events', { claim_id: id, type: 'claim_created', data: { by: 'test' } });
  });
  expect(await count('SELECT count(*)::int AS n FROM claim_events WHERE claim_id = $1', [id])).toBe(1);
});

test('rolls back every write when the unit throws', async () => {
  const id = claimId();
  await expect(runInTransaction({ tenantId: TENANT }, async (tx) => {
    await insertClaim(tx, id);
    await tx.insert('claim_events', { claim_id: id, type: 'claim_created', data: {} });
    throw new Error('business rule failed');
  })).rejects.toThrow('business rule failed');
  expect(await count('SELECT count(*)::int AS n FROM claims WHERE id = $1', [id])).toBe(0);
  expect(await count('SELECT count(*)::int AS n FROM claim_events WHERE claim_id = $1', [id])).toBe(0);
});

test('a failed statement rolls back the whole unit (no partial commit)', async () => {
  const id = claimId();
  await expect(runInTransaction({ tenantId: TENANT }, async (tx) => {
    await insertClaim(tx, id);
    await tx.insert('claim_events', { claim_id: 'claim_that_does_not_exist', type: 'x', data: {} }); // FK violation
  })).rejects.toMatchObject({ code: '23503' });
  expect(await count('SELECT count(*)::int AS n FROM claims WHERE id = $1', [id])).toBe(0);
});

test('carries app.tenant_id / app.actor_id for the transaction only', async () => {
  const seen = await runInTransaction({ tenantId: TENANT, actorId: 'adj@tpa.test' }, (tx) =>
    tx.query(`SELECT current_setting('app.tenant_id', true) AS tenant, current_setting('app.actor_id', true) AS actor`));
  expect(seen[0]).toEqual({ tenant: TENANT, actor: 'adj@tpa.test' });

  const after = await getPool().query(`SELECT coalesce(current_setting('app.tenant_id', true), '') AS tenant`);
  expect(after.rows[0].tenant).toBe('');
});

test('afterCommit hooks run after commit, never after rollback, and never throw into the caller', async () => {
  const ran = [];
  const id = claimId();
  const out = await runInTransaction({ tenantId: TENANT }, async (tx) => {
    tx.afterCommit(async () => {
      // The hook sees the committed row from a different connection.
      ran.push(await count('SELECT count(*)::int AS n FROM claims WHERE id = $1', [id]));
    });
    tx.afterCommit(() => { throw new Error('hook failure is logged, not raised'); });
    await insertClaim(tx, id);
    return 'done';
  });
  expect(out).toBe('done');
  expect(ran).toEqual([1]);

  const skipped = [];
  await expect(runInTransaction({ tenantId: TENANT }, async (tx) => {
    tx.afterCommit(() => skipped.push('ran'));
    throw new Error('rollback');
  })).rejects.toThrow('rollback');
  expect(skipped).toEqual([]);
});

test('a real deadlock is retried: both units eventually commit', async () => {
  const a = claimId();
  const b = claimId();
  await runInTransaction({ tenantId: TENANT }, async (tx) => { await insertClaim(tx, a); await insertClaim(tx, b); });

  let attemptsA = 0;
  let attemptsB = 0;
  let release;
  const bothLockedFirst = new Promise(r => { release = r; });
  let locked = 0;
  const lockedOne = () => { if (++locked === 2) release(); };

  const unit = (first, second, bump) => runInTransaction({ tenantId: TENANT, label: 'deadlock-test' }, async (tx) => {
    bump();
    await tx.update('claims', { injury_description: `locked by ${first}` }, { id: first });
    lockedOne();
    await Promise.race([bothLockedFirst, new Promise(r => setTimeout(r, 200))]);
    await tx.update('claims', { injury_description: `then ${second}` }, { id: second });
  });

  await Promise.all([
    unit(a, b, () => { attemptsA += 1; }),
    unit(b, a, () => { attemptsB += 1; }),
  ]);
  // Postgres aborted one of them with 40P01; the unit of work re-ran it.
  expect(attemptsA + attemptsB).toBeGreaterThanOrEqual(3);
  expect(attemptsA + attemptsB).toBeLessThanOrEqual(2 * MAX_ATTEMPTS);
});

test('a non-retryable error is not retried', async () => {
  let attempts = 0;
  await expect(runInTransaction({ tenantId: TENANT }, async () => {
    attempts += 1;
    const e = new Error('unique violation');
    e.code = '23505';
    throw e;
  })).rejects.toThrow('unique violation');
  expect(attempts).toBe(1);
});

test('serialization failures are retried at most MAX_ATTEMPTS times', async () => {
  let attempts = 0;
  await expect(runInTransaction({ tenantId: TENANT }, async () => {
    attempts += 1;
    const e = new Error('could not serialize access');
    e.code = '40001';
    throw e;
  })).rejects.toThrow('could not serialize access');
  expect(attempts).toBe(MAX_ATTEMPTS);
});
