'use strict';

/**
 * Demo seed + reset on real PostgreSQL: the whole synthetic dataset seeds
 * against the real schema, and the reset purges it in one transaction —
 * the only path through claim_events' append-only rule — while a real
 * claim's history stays untouchable.
 */

jest.mock('../../src/services/supabase', () => require('./pgSupabase'));
jest.mock('../../src/services/filehandler', () => ({
  setReserves: jest.fn(), createClaim: jest.fn(), createDiary: jest.fn(), completeDiary: jest.fn(),
  addNote: jest.fn(), attachDocument: jest.fn(),
}));

const config = require('../../src/config');
const { seedDemo, wipeDemo } = require('../../src/scripts/seedDemo');
const { getPool, closePool } = require('../../src/db/pool');

const db = (sql, params) => getPool().query(sql, params).then(r => r.rows);
const demoClaims = () => db(`SELECT id FROM claims WHERE metadata ->> 'demo' = 'true' ORDER BY id`);

beforeAll(() => { config.jobs.kick = false; });
afterAll(closePool);

// D-10 fixed: the demo dataset keys rows with deterministic UUIDs matching the schema types.
test('the demo dataset seeds against the real schema with zero rejected statements', async () => {
  const { errors } = require('./pgSupabase');
  errors.length = 0;
  const out = await seedDemo();
  expect(errors).toEqual([]);
  expect(out.count).toBe(12);
  expect((await demoClaims()).length).toBeGreaterThanOrEqual(12);
  expect((await db(`SELECT count(*)::int AS n FROM claim_events e JOIN claims c ON c.id = e.claim_id
                     WHERE c.metadata ->> 'demo' = 'true'`))[0].n).toBeGreaterThan(0);
});

test('reset purges every demo claim and its history in one transaction, and re-seeds cleanly', async () => {
  await wipeDemo();
  expect(await demoClaims()).toEqual([]);
  const again = await seedDemo();   // seedDemo wipes first, then seeds
  expect(again.count).toBe(12);
});

test('a real claim mixed into the demo ids is refused, and nothing is purged', async () => {
  await db(`UPDATE claims SET metadata = '{}' WHERE id = 'claim_demo_001'`);   // looks real now
  await expect(wipeDemo()).rejects.toThrow(/refusing to wipe claims not flagged as demo data: claim_demo_001/);
  expect((await demoClaims()).length).toBeGreaterThanOrEqual(11);              // rolled back — nothing purged
  await expect(db(`DELETE FROM claim_events WHERE claim_id = 'claim_demo_001'`))
    .rejects.toThrow(/claim_events is append-only/);
});
