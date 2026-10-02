'use strict';

/**
 * pgSupabase — a test-only stand-in for the supabase-js service client,
 * executed against the SAME real PostgreSQL database as the unit of work.
 *
 *   jest.mock('../../src/services/supabase', () => require('./pgSupabase'));
 *
 * Each query autocommits through the shared pool, exactly as PostgREST
 * would: it sees committed data only, never a caller's open transaction.
 * That is the point — code that reads through supabase-js while holding
 * uncommitted writes is caught here, where the in-memory double would hide
 * it.
 *
 * Supports the subset the transactional paths use: select (flat columns,
 * plus one-to-many embeds of claim_id children on claims, e.g.
 * '*, claim_events(*), diaries(*)' — any other nested select throws, so an
 * unsupported read is loud), insert, upsert, update, delete, filters eq / neq / is
 * / in / lt, order, limit, single. Results use the pool's PostgREST-shaped
 * type parsers.
 */

const { getPool } = require('../../src/db/pool');

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (n) => {
  if (!IDENT.test(n)) throw new Error(`pgSupabase: invalid identifier ${n}`);
  return `"${n}"`;
};

const _types = new Map();
async function _columnTypes(table) {
  if (_types.has(table)) return _types.get(table);
  const { rows } = await getPool().query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`, [table]);
  const map = new Map(rows.map(r => [r.column_name, r.data_type]));
  _types.set(table, map);
  return map;
}

function _encode(types, col, v) {
  if (v === undefined || v === null) return null;
  const t = types.get(col);
  return t === 'jsonb' || t === 'json' ? JSON.stringify(v) : v;
}

class Query {
  constructor(table) {
    this.table = table;
    this.op = 'select';
    this.filters = [];
    this.returning = false;
    this.isSingle = false;
  }

  select(cols = '*') {
    if (this.op === 'select') {
      if (typeof cols === 'string' && cols.includes('(')) {
        const parts = cols.split(',').map(c => c.trim());
        this.embeds = parts.filter(c => c.includes('(')).map((c) => {
          const m = c.match(/^([a-z_]+)\(\*\)$/);
          if (this.table !== 'claims' || !m) {
            throw new Error(`pgSupabase: unsupported nested select (${this.table}: ${cols})`);
          }
          return m[1];
        });
        cols = parts.filter(c => !c.includes('(')).join(', ') || '*';
      }
      this.cols = cols;
    } else {
      this.returning = true;
    }
    return this;
  }
  insert(data) { this.op = 'insert'; this.data = data; return this; }
  upsert(data, { onConflict = 'id' } = {}) {
    this.op = 'insert'; this.data = data; this.onConflict = String(onConflict).split(',').map(c => c.trim());
    return this;
  }
  update(data) { this.op = 'update'; this.data = data; return this; }
  delete()     { this.op = 'delete'; return this; }
  eq(c, v)  { this.filters.push(['=', c, v]); return this; }
  neq(c, v) { this.filters.push(['<>', c, v]); return this; }
  lt(c, v)  { this.filters.push(['<', c, v]); return this; }
  is(c, v)  { this.filters.push([v === null ? 'IS NULL' : 'IS', c, v]); return this; }
  in(c, v)  { this.filters.push(['IN', c, v]); return this; }
  order(c, { ascending = true } = {}) { this.orderBy = [c, ascending]; return this; }
  limit(n)  { this.limitN = n; return this; }
  single()  { this.isSingle = true; return this._run(); }
  then(resolve, reject) { return this._run().then(resolve, reject); }

  _where(types, params) {
    if (!this.filters.length) return '';
    return ' WHERE ' + this.filters.map(([op, c, v]) => {
      if (op === 'IS NULL') return `${ident(c)} IS NULL`;
      if (op === 'IS') { params.push(v); return `${ident(c)} IS NOT DISTINCT FROM $${params.length}`; }
      if (op === 'IN') { params.push(v); return `${ident(c)} = ANY($${params.length})`; }
      params.push(_encode(types, c, v));
      return `${ident(c)} ${op} $${params.length}`;
    }).join(' AND ');
  }

  async _sql() {
    const types = await _columnTypes(this.table);
    const t = ident(this.table);
    const params = [];
    if (this.op === 'select') {
      const cols = !this.cols || this.cols.trim() === '*'
        ? '*' : this.cols.split(',').map(c => ident(c.trim())).join(', ');
      let sql = `SELECT ${cols} FROM ${t}${this._where(types, params)}`;
      if (this.orderBy) sql += ` ORDER BY ${ident(this.orderBy[0])} ${this.orderBy[1] ? 'ASC' : 'DESC'}`;
      if (this.limitN != null) sql += ` LIMIT ${Number(this.limitN)}`;
      return [sql, params];
    }
    if (this.op === 'insert') {
      const rows = Array.isArray(this.data) ? this.data : [this.data];
      const keys = [...new Set(rows.flatMap(Object.keys))];
      const values = rows.map(r => `(${keys.map(k => {
        if (r[k] === undefined) return 'DEFAULT';
        params.push(_encode(types, k, r[k]));
        return `$${params.length}`;
      }).join(', ')})`).join(', ');
      let conflict = '';
      if (this.onConflict) {
        const updates = keys.filter(k => !this.onConflict.includes(k));
        conflict = ` ON CONFLICT (${this.onConflict.map(ident).join(', ')}) ` + (updates.length
          ? `DO UPDATE SET ${updates.map(k => `${ident(k)} = EXCLUDED.${ident(k)}`).join(', ')}`
          : 'DO NOTHING');
      }
      return [`INSERT INTO ${t} (${keys.map(ident).join(', ')}) VALUES ${values}${conflict} RETURNING *`, params];
    }
    if (this.op === 'update') {
      const sets = Object.entries(this.data).filter(([, v]) => v !== undefined).map(([k, v]) => {
        params.push(_encode(types, k, v));
        return `${ident(k)} = $${params.length}`;
      });
      return [`UPDATE ${t} SET ${sets.join(', ')}${this._where(types, params)} RETURNING *`, params];
    }
    return [`DELETE FROM ${t}${this._where(types, params)} RETURNING *`, params];
  }

  async _run() {
    try {
      const [sql, params] = await this._sql();
      const { rows } = await getPool().query(sql, params);
      for (const rel of this.embeds || []) {
        const ids = rows.map(r => r.id);
        const children = ids.length
          ? (await getPool().query(`SELECT * FROM ${ident(rel)} WHERE claim_id = ANY($1)`, [ids])).rows
          : [];
        for (const r of rows) r[rel] = children.filter(c => c.claim_id === r.id);
      }
      if (this.isSingle) {
        return rows.length
          ? { data: rows[0], error: null }
          : { data: null, error: { code: 'PGRST116', message: 'Row not found' } };
      }
      return { data: rows, error: null };
    } catch (e) {
      // Recorded, because most supabase-js callers never check `error`:
      // a test can assert that a flow produced no rejected statements.
      errors.push({ table: this.table, op: this.op, code: e.code, message: e.message });
      return { data: null, error: { code: e.code, message: e.message } };
    }
  }
}

const errors = [];

const supabase = {
  from: (table) => new Query(table),
  rpc: async (fn) => ({ data: null, error: { message: `pgSupabase: rpc ${fn} not supported` } }),
};

module.exports = {
  errors,
  supabase,
  supabaseAuth: supabase,
  verifyConnection: async () => true,
};
