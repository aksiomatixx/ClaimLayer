'use strict';

/**
 * pg adapter conformance + type normalization (ADR-0006). Business code
 * written against the in-memory double must see the same shapes here.
 */

jest.mock('../../src/services/supabase', () => require('./pgSupabase'));

const { runInTransaction } = require('../../src/db/unitOfWork');
const { closePool, _sslOption } = require('../../src/db/pool');

const TENANT = '00000000-0000-0000-0000-000000000001';
let n = 0;
const uid = (p) => `${p}_${process.pid}_${++n}`;
const tx = (fn) => runInTransaction({ tenantId: TENANT }, fn);

afterAll(closePool);

async function claim(t, overrides = {}) {
  return t.insert('claims', {
    id: uid('claim_ad'), claim_number: uid('AD'), status: 'new_claim', date_of_injury: '2026-05-01', ...overrides,
  });
}

describe('insert', () => {
  test('returns the stored row with database defaults applied', () => tx(async (t) => {
    const row = await claim(t);
    expect(row.status).toBe('new_claim');
    expect(row.tenant_id).toBe(TENANT);
    expect(row.metadata).toEqual({});              // jsonb default, parsed
  }));

  test('mirrors the input shape: one row → row, array → array (missing keys use DEFAULT)', () => tx(async (t) => {
    const c = await claim(t);
    const rows = await t.insert('claim_events', [
      { claim_id: c.id, type: 'a', data: { x: 1 } },
      { claim_id: c.id, type: 'b' },               // no data key → column default
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].data).toEqual({ x: 1 });
  }));

  test('encodes jsonb objects AND arrays (not as Postgres arrays)', () => tx(async (t) => {
    const c = await claim(t, { metadata: { tags: ['a', 'b'], nested: { ok: true } } });
    expect(c.metadata).toEqual({ tags: ['a', 'b'], nested: { ok: true } });
    const ar = await t.insert('action_requests', {
      id: uid('ar_ad'), tenant_id: TENANT, claim_id: c.id, action_type: 'reserve.change',
      proposed_by_type: 'human', proposed_by: 'a@t', proposal: { medical_cents: 1 },
      evidence: [{ type: 'doc', id: 'd1' }], policy_version: 'p@1',
    });
    expect(ar.evidence).toEqual([{ type: 'doc', id: 'd1' }]);
  }));

  test('rejects unknown columns and unsafe identifiers before reaching SQL', () => tx(async (t) => {
    await expect(t.insert('claims', { id: 'x', nope: 1 })).rejects.toThrow(/unknown column: claims.nope/);
    await expect(t.insert('claims; drop table claims', { id: 'x' })).rejects.toThrow(/invalid SQL identifier/);
    await expect(t.insert('no_such_table', { id: 'x' })).rejects.toThrow(/unknown table/);
    // All three were refused in JS, so the transaction is still usable.
    expect(await t.query('SELECT 1 AS ok')).toEqual([{ ok: 1 }]);
  }));
});

describe('select / update', () => {
  test('where supports equality, IS NULL and IN; orderBy and limit', () => tx(async (t) => {
    const a = await claim(t, { body_part: 'knee' });
    const b = await claim(t, { body_part: null });
    const c = await claim(t, { body_part: 'back' });
    expect((await t.select('claims', { id: a.id }))[0].body_part).toBe('knee');
    expect((await t.select('claims', { id: { in: [a.id, b.id, c.id] }, body_part: null })).map(r => r.id)).toEqual([b.id]);
    const ordered = await t.select('claims', { id: { in: [a.id, c.id] } }, { orderBy: ['body_part', 'asc'] });
    expect(ordered.map(r => r.body_part)).toEqual(['back', 'knee']);
    expect(await t.select('claims', { id: { in: [a.id, c.id] } }, { limit: 1 })).toHaveLength(1);
    expect(await t.selectOne('claims', { id: 'claim_missing' })).toBeNull();
  }));

  test('update requires a where clause and returns the changed rows', () => tx(async (t) => {
    const c = await claim(t);
    await expect(t.update('claims', { status: 'denied' }, {})).rejects.toThrow(/non-empty where/);
    const rows = await t.update('claims', { status: 'denied', body_part: undefined }, { id: c.id, status: 'new_claim' });
    expect(rows.map(r => r.status)).toEqual(['denied']);
    expect(await t.update('claims', { status: 'closed' }, { id: c.id, status: 'new_claim' })).toEqual([]); // conditional miss
  }));

  test('selectOne with forUpdate locks the row for the rest of the unit', async () => {
    const id = await tx(async (t) => (await claim(t)).id);
    const order = [];
    await Promise.all([
      tx(async (t) => {
        await t.selectOne('claims', { id }, { forUpdate: true });
        order.push('A locked');
        await new Promise(r => setTimeout(r, 150));
        await t.update('claims', { body_part: 'A' }, { id });
        order.push('A done');
      }),
      new Promise(r => setTimeout(r, 30)).then(() => tx(async (t) => {
        await t.selectOne('claims', { id }, { forUpdate: true });  // waits for A
        order.push('B locked');
      })),
    ]);
    expect(order).toEqual(['A locked', 'A done', 'B locked']);
  });

  test('the adapter has no delete()', () => tx(async (t) => {
    expect(t.delete).toBeUndefined();
  }));
});

describe('type normalization (PostgREST shapes)', () => {
  test('timestamptz → ISO string, date → YYYY-MM-DD, numeric → number, bigint → number', () => tx(async (t) => {
    const c = await claim(t, { aww: '1234.56', date_of_injury: '2026-02-28' });
    expect(typeof c.created_at).toBe('string');
    expect(c.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(c.date_of_injury).toBe('2026-02-28');   // no timezone shift
    expect(c.aww).toBe(1234.56);
    const [{ big }] = await t.query(`SELECT 9007199254740991::bigint AS big`);
    expect(big).toBe(9007199254740991);
    const [{ huge }] = await t.query(`SELECT 9007199254740993::bigint AS huge`);
    expect(huge).toBe('9007199254740993');         // unsafe integers stay exact strings
  }));
});

describe('TLS options', () => {
  test('localhost defaults to no TLS, remote hosts require TLS, verify checks the CA', () => {
    expect(_sslOption('postgres://u@localhost:5432/db', null)).toBe(false);
    expect(_sslOption('postgres://u@db.example.com:5432/db', null)).toEqual({ rejectUnauthorized: false });
    expect(_sslOption('postgres://u@db.example.com/db', 'verify', '-----BEGIN\\nX')).toEqual({ rejectUnauthorized: true, ca: '-----BEGIN\nX' });
    expect(() => _sslOption('postgres://u@h/db', 'bogus')).toThrow(/disable \| require \| verify/);
  });
});
