'use strict';

/**
 * Transaction adapters (ADR-0006). Business code written against this one
 * small interface runs in either mode:
 *
 *   tx.mode                         'pg' | 'compat'
 *   tx.tenantId
 *   tx.insert(table, row | rows)    → row | rows (mirrors the input shape)
 *   tx.update(table, patch, where)  → rows[]   (where is required)
 *   tx.upsert(table, row, { onConflict: 'col' | ['col', ...] }) → row
 *                                   (insert, or update every supplied column on conflict)
 *   tx.select(table, where, opts)   → rows[]   opts: { orderBy: [col, 'asc'|'desc'], limit, forUpdate }
 *   tx.selectOne(table, where, opts)→ row | null
 *   tx.query(sql, params)           → rows[]   (pg mode only)
 *   tx.afterCommit(fn)              run fn only after a successful commit
 *
 * where: { col: value } equality · { col: null } IS NULL · { col: { in: [...] } }
 *
 * 'pg'     — one real Postgres transaction (production).
 * 'compat' — supabase-js, NOT atomic. Exists so the in-memory test suite
 *            and the DB-less demo keep running the same business logic;
 *            production refuses this mode (config requires DATABASE_URL).
 *
 * Deliberately no delete(): consequential paths append and transition,
 * they do not erase.
 */

const IDENT = /^[a-z_][a-z0-9_]*$/;

function _ident(name) {
  if (!IDENT.test(name)) throw new Error(`invalid SQL identifier: ${name}`);
  return `"${name}"`;
}

function _assertWhere(where, op) {
  if (!where || typeof where !== 'object' || !Object.keys(where).length) {
    throw new Error(`${op} requires a non-empty where clause`);
  }
}

function _isInClause(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.in);
}

// ── pg adapter ───────────────────────────────────────────────────────────────

// Column type cache: jsonb/json values are JSON-encoded; Postgres arrays are
// passed as JS arrays (node-postgres renders array literals).
const _columnCache = new Map();

async function _columns(client, table) {
  _ident(table); // refuse unsafe names before any query
  if (_columnCache.has(table)) return _columnCache.get(table);
  const { rows } = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`, [table]);
  if (!rows.length) throw new Error(`unknown table: ${table}`);
  const map = new Map(rows.map(r => [r.column_name, r.data_type]));
  _columnCache.set(table, map);
  return map;
}

function _encode(cols, column, value) {
  if (value === undefined || value === null) return null;
  const type = cols.get(column);
  if (type === undefined) throw new Error(`unknown column: ${column}`);
  if (type === 'jsonb' || type === 'json') return JSON.stringify(value);
  return value;
}

function _where(cols, where, params) {
  return Object.entries(where).map(([col, val]) => {
    const c = _ident(col);
    if (!cols.has(col)) throw new Error(`unknown column: ${col}`);
    if (val === null) return `${c} IS NULL`;
    if (_isInClause(val)) {
      params.push(val.in);
      return `${c} = ANY($${params.length})`;
    }
    params.push(_encode(cols, col, val));
    return `${c} = $${params.length}`;
  }).join(' AND ');
}

function pgAdapter(client, { tenantId }) {
  const hooks = [];
  return {
    mode: 'pg',
    tenantId,
    _hooks: hooks,

    async query(sql, params = []) {
      const { rows } = await client.query(sql, params);
      return rows;
    },

    async insert(table, rowOrRows) {
      const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
      if (!rows.length) return [];
      const cols = await _columns(client, table);
      const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
      keys.forEach(k => { if (!cols.has(k)) throw new Error(`unknown column: ${table}.${k}`); });
      const params = [];
      const values = rows.map(r => `(${keys.map(k => {
        if (!(k in r) || r[k] === undefined) return 'DEFAULT';
        params.push(_encode(cols, k, r[k]));
        return `$${params.length}`;
      }).join(', ')})`).join(', ');
      const out = (await client.query(
        `INSERT INTO ${_ident(table)} (${keys.map(_ident).join(', ')}) VALUES ${values} RETURNING *`,
        params)).rows;
      return Array.isArray(rowOrRows) ? out : out[0];
    },

    async update(table, patch, where) {
      _assertWhere(where, 'update');
      const cols = await _columns(client, table);
      const params = [];
      const sets = Object.entries(patch).filter(([, v]) => v !== undefined).map(([k, v]) => {
        if (!cols.has(k)) throw new Error(`unknown column: ${table}.${k}`);
        params.push(_encode(cols, k, v));
        return `${_ident(k)} = $${params.length}`;
      });
      if (!sets.length) throw new Error('update requires at least one column');
      const cond = _where(cols, where, params);
      return (await client.query(
        `UPDATE ${_ident(table)} SET ${sets.join(', ')} WHERE ${cond} RETURNING *`, params)).rows;
    },

    async upsert(table, row, { onConflict } = {}) {
      const conflict = [].concat(onConflict || []);
      if (!conflict.length) throw new Error('upsert requires onConflict');
      const cols = await _columns(client, table);
      const keys = Object.keys(row).filter(k => row[k] !== undefined);
      [...keys, ...conflict].forEach(k => { if (!cols.has(k)) throw new Error(`unknown column: ${table}.${k}`); });
      const params = keys.map(k => _encode(cols, k, row[k]));
      const updates = keys.filter(k => !conflict.includes(k));
      const action = updates.length
        ? `DO UPDATE SET ${updates.map(k => `${_ident(k)} = EXCLUDED.${_ident(k)}`).join(', ')}`
        : 'DO NOTHING';
      const { rows } = await client.query(
        `INSERT INTO ${_ident(table)} (${keys.map(_ident).join(', ')})
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT (${conflict.map(_ident).join(', ')}) ${action} RETURNING *`, params);
      if (rows[0]) return rows[0];
      return this.selectOne(table, Object.fromEntries(conflict.map(k => [k, row[k]])));
    },

    async select(table, where = {}, { orderBy, limit, forUpdate } = {}) {
      const cols = await _columns(client, table);
      const params = [];
      let sql = `SELECT * FROM ${_ident(table)}`;
      if (Object.keys(where).length) sql += ` WHERE ${_where(cols, where, params)}`;
      if (orderBy) {
        const [col, dir] = orderBy;
        if (!cols.has(col)) throw new Error(`unknown column: ${col}`);
        sql += ` ORDER BY ${_ident(col)} ${dir === 'desc' ? 'DESC' : 'ASC'}`;
      }
      if (limit != null) { params.push(limit); sql += ` LIMIT $${params.length}`; }
      if (forUpdate) sql += ' FOR UPDATE';
      return (await client.query(sql, params)).rows;
    },

    async selectOne(table, where, opts = {}) {
      const rows = await this.select(table, where, { ...opts, limit: 1 });
      return rows[0] || null;
    },

    afterCommit(fn) { hooks.push(fn); },
  };
}

// ── compat adapter (supabase-js) ─────────────────────────────────────────────

function _applyWhere(q, where) {
  for (const [col, val] of Object.entries(where)) {
    if (val === null) q = q.is(col, null);
    else if (_isInClause(val)) q = q.in(col, val.in);
    else q = q.eq(col, val);
  }
  return q;
}

function _raise(error, op, table) {
  const e = new Error(`${op} ${table}: ${error.message}`);
  if (error.code) e.code = error.code;
  throw e;
}

function compatAdapter(supabase, { tenantId }) {
  const hooks = [];
  return {
    mode: 'compat',
    tenantId,
    _hooks: hooks,

    async query() {
      throw new Error('raw SQL requires DATABASE_URL (transactional mode)');
    },

    async insert(table, rowOrRows) {
      const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
      if (!rows.length) return [];
      const { data, error } = await supabase.from(table).insert(rows).select();
      if (error) _raise(error, 'insert', table);
      const out = Array.isArray(data) ? data : [data];
      return Array.isArray(rowOrRows) ? out : out[0];
    },

    async update(table, patch, where) {
      _assertWhere(where, 'update');
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const { data, error } = await _applyWhere(supabase.from(table).update(clean), where).select();
      if (error) _raise(error, 'update', table);
      return Array.isArray(data) ? data : (data ? [data] : []);
    },

    async upsert(table, row, { onConflict } = {}) {
      const conflict = [].concat(onConflict || []);
      if (!conflict.length) throw new Error('upsert requires onConflict');
      const clean = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
      const { data, error } = await supabase.from(table)
        .upsert([clean], { onConflict: conflict.join(',') }).select();
      if (error) _raise(error, 'upsert', table);
      return Array.isArray(data) ? data[0] : data;
    },

    async select(table, where = {}, { orderBy, limit } = {}) {
      let q = _applyWhere(supabase.from(table).select('*'), where);
      if (orderBy) q = q.order(orderBy[0], { ascending: orderBy[1] !== 'desc' });
      if (limit != null) q = q.limit(limit);
      const { data, error } = await q;
      if (error) _raise(error, 'select', table);
      return data || [];
    },

    async selectOne(table, where, opts = {}) {
      const rows = await this.select(table, where, { ...opts, limit: 1 });
      return rows[0] || null;
    },

    afterCommit(fn) { hooks.push(fn); },
  };
}

module.exports = { pgAdapter, compatAdapter, _columnCache };
