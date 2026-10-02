'use strict';

/**
 * Schema guards against the real migrated database: the demo reset's
 * delete order, and audit-ledger writes inside a unit of work.
 */

jest.mock('../../src/services/supabase', () => require('./pgSupabase'));

const { DEMO_CHILD_TABLES, DEMO_RFA_DEPENDENTS } = require('../../src/scripts/seedDemo');
const auditLedger = require('../../src/services/auditLedgerService');
const { runInTransaction } = require('../../src/db/unitOfWork');
const { getPool, closePool } = require('../../src/db/pool');

const TENANT = '00000000-0000-0000-0000-000000000001';
const OTHER  = '00000000-0000-0000-0000-0000000000b2';
const ADJ = { type: 'human', id: 'adj@tpa.test', role: 'adjuster', tenantId: TENANT };
const db = (sql, params) => getPool().query(sql, params).then(r => r.rows);

afterAll(closePool);

describe('demo reset covers the schema (claims no longer cascade)', () => {
  test('every table with a foreign key into claims is wiped', async () => {
    const rows = await db(`SELECT DISTINCT conrelid::regclass::text AS t FROM pg_constraint
                            WHERE contype = 'f' AND confrelid = 'public.claims'::regclass`);
    const handled = new Set([...DEMO_CHILD_TABLES, 'claim_links']); // claim_links is wiped by both columns
    expect(rows.map(r => r.t).filter(t => !handled.has(t))).toEqual([]);
  });

  test('every listed table really has a claim_id column (the wipe deletes by it)', async () => {
    const rows = await db(`SELECT table_name FROM information_schema.columns
                            WHERE table_schema = 'public' AND column_name = 'claim_id'`);
    const withClaimId = new Set(rows.map(r => r.table_name));
    expect(DEMO_CHILD_TABLES.filter(t => !withClaimId.has(t))).toEqual([]);
  });

  test('tables hanging off a child table without their own claim_id are wiped through it first', async () => {
    const rows = await db(`
      SELECT c.conrelid::regclass::text AS dependent, c.confrelid::regclass::text AS parent
        FROM pg_constraint c
       WHERE c.contype = 'f' AND c.conrelid <> c.confrelid
         AND c.confrelid::regclass::text = ANY($1)
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_schema = 'public' AND table_name = c.conrelid::regclass::text
                            AND column_name = 'claim_id')`, [DEMO_CHILD_TABLES]);
    const handled = new Set(DEMO_RFA_DEPENDENTS.map(([t, , parent]) => `${t}->${parent}`));
    expect(rows.map(r => `${r.dependent}->${r.parent}`).filter(k => !handled.has(k))).toEqual([]);
  });

  test('each child table is emptied before any child table it references', async () => {
    const fks = await db(`SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
                            FROM pg_constraint WHERE contype = 'f' AND conrelid <> confrelid`);
    const pos = new Map(DEMO_CHILD_TABLES.map((t, i) => [t, i]));
    const violations = fks.filter(({ child, parent }) =>
      pos.has(child) && pos.has(parent) && pos.get(child) > pos.get(parent));
    expect(violations).toEqual([]);
  });
});

describe('audit ledger inside a unit of work', () => {
  test('an entry commits with its unit and rolls back with it; the chain stays verifiable', async () => {
    const before = (await db(`SELECT count(*)::int AS n FROM audit_ledger WHERE tenant_id = $1`, [TENANT]))[0].n;
    await expect(runInTransaction({ tenantId: TENANT }, async (tx) => {
      await auditLedger.append({ actor: ADJ, action: 'claim.status_changed', claimId: 'c_rb' }, { tx });
      throw new Error('the change failed');
    })).rejects.toThrow('the change failed');
    const row = await runInTransaction({ tenantId: TENANT }, (tx) =>
      auditLedger.append({ actor: ADJ, action: 'claim.status_changed', claimId: 'c_ok' }, { tx }));
    expect(row).toMatchObject({ actor_id: 'adj@tpa.test', claim_id: 'c_ok', seq: before + 1 });   // no gap
    const [verify] = await db(`SELECT * FROM app.audit_ledger_verify($1)`, [TENANT]);
    expect(verify.ok).toBe(true);
  });

  test('an entry for another tenant is refused inside a tenant\'s unit', async () => {
    await expect(runInTransaction({ tenantId: TENANT }, (tx) =>
      auditLedger.append({ actor: { ...ADJ, tenantId: OTHER }, action: 'claim.status_changed' }, { tx })))
      .rejects.toThrow(/does not match the transaction tenant/);
  });

  test('the ledger stays append-only on the transactional path too', async () => {
    await expect(runInTransaction({ tenantId: TENANT }, (tx) =>
      tx.update('audit_ledger', { action: 'claim.deleted' }, { tenant_id: TENANT })))
      .rejects.toThrow(/append-only|not permitted|immutable/i);
  });
});
