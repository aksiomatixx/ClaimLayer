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

// KNOWN GAP (readiness doc, D-10): the demo dataset keys some rows with
// readable string ids ('rfa_demo_4', 'employer-brightcare-001') where the
// real schema has UUID primary keys, so those inserts are rejected on a real
// database (the in-memory double accepts them). Re-keying the demo dataset
// is tracked separately; this ratchet fails on any OTHER rejected statement.
const KNOWN_UUID_KEYED = new Set(['policies', 'employers', 'rfas', 'td_periods', 'pd_evaluations', 'settlement_offers']);

test('the demo dataset seeds against the real schema — no rejected statement beyond the known D-10 gap', async () => {
  const { errors } = require('./pgSupabase');
  errors.length = 0;
  const out = await seedDemo();
  const unexpected = errors.filter(e => !(e.code === '22P02' && KNOWN_UUID_KEYED.has(e.table)));
  expect(unexpected).toEqual([]);
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
