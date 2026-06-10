'use strict';

/**
 * supabaseClient.js — In-memory Supabase mock for Jest tests.
 *
 * Drop-in replacement for backend/src/services/supabase.js.
 * Usage in test files:
 *
 *   jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));
 *
 * Supports:
 *   supabase.from(table).select(cols).eq(col,val).[single()|await]
 *   supabase.from(table).insert(data).[select().[single()]|await]
 *   supabase.from(table).update(data).eq(col,val).[select().[single()]|await]
 *   supabase.from(table).upsert(data, {onConflict}).[select().[single()]|await]
 *   supabase.from(table).delete().eq(col,val).[await]
 *   supabase.rpc('next_claim_number')
 *   supabaseAuth.auth.signInWithPassword({ email, password })
 *
 * Mock users for signInWithPassword:
 *   hr@brightcarehh.com  / test1234  → BrightCare Home Health
 *   hr@carewellservices.com / test1234 → CareWell Services
 */

// ── Shared in-memory store ────────────────────────────────────────────────────
const tables = {};
let _claimSeq = 42;

const MOCK_AUTH_USERS = [
  {
    email:        'hr@brightcarehh.com',
    password:     'test1234',
    id:           'user-employer-1',
    role:         'employer',
    employer_id:  'employer-brightcare-001',
    employer_name:'BrightCare Home Health',
  },
  {
    email:        'hr@carewellservices.com',
    password:     'test1234',
    id:           'user-employer-2',
    role:         'employer',
    employer_id:  'employer-carewell-001',
    employer_name:'CareWell Services',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function uid() {
  return `mock-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function getTable(name) {
  if (!tables[name]) tables[name] = new Map();
  return tables[name];
}

/**
 * Reset named tables (or ALL tables if no argument).
 * Exposed as supabase._resetStore(tableNames?) for test cleanup.
 */
function resetStore(tableNames) {
  if (tableNames) {
    tableNames.forEach(n => { if (tables[n]) tables[n].clear(); });
  } else {
    Object.keys(tables).forEach(n => tables[n].clear());
  }
  _claimSeq = 42;
}

// ── Query builder ─────────────────────────────────────────────────────────────
class QueryBuilder {
  constructor(tableName) {
    this._table     = tableName;
    this._op        = 'select';
    this._filters   = [];   // [{ col, val }]
    this._data      = null; // insert / update / upsert payload
    this._upsertKey = null; // onConflict column
    this._wantData  = false;// .select() called after insert/upsert
    this._single    = false;
    this._orderBy   = null; // { col, desc }
    this._limitN    = null;
    this._joinRelations = false; // for claims: also attach claim_events + diaries
  }

  // ── Chain methods ───────────────────────────────────────────────────────────
  select(cols = '*') {
    if (this._op === 'insert' || this._op === 'upsert' || this._op === 'update') {
      this._wantData = true;
      return this;
    }
    // Check if cols requests nested relations
    if (typeof cols === 'string' &&
        (cols.includes('claim_events') || cols.includes('diaries') || cols.includes('reserves'))) {
      this._joinRelations = true;
    }
    return this;
  }

  insert(data) { this._op = 'insert'; this._data = data; return this; }

  update(data) { this._op = 'update'; this._data = data; return this; }

  upsert(data, opts = {}) {
    this._op        = 'upsert';
    this._data      = data;
    this._upsertKey = opts.onConflict || null;
    return this;
  }

  delete() { this._op = 'delete'; return this; }

  eq(col, val) { this._filters.push({ col, val, op: 'eq' }); return this; }
  neq(col, val) { this._filters.push({ col, val, op: 'neq' }); return this; }
  is(col, val) { this._filters.push({ col, val, op: 'is' }); return this; }

  order(col, opts = {}) {
    this._orderBy = { col, desc: opts.ascending === false };
    return this;
  }

  limit(n) { this._limitN = n; return this; }

  single() {
    this._single = true;
    return Promise.resolve(this._run());
  }

  // Thenable — `await builder` without calling .single()
  then(resolve, reject) {
    return Promise.resolve(this._run()).then(resolve, reject);
  }

  // ── Execution ───────────────────────────────────────────────────────────────
  _run() {
    try {
      return this._execute();
    } catch (err) {
      return { data: null, error: { message: err.message } };
    }
  }

  _matchRow(row) {
    return this._filters.every(f => {
      if (f.op === 'eq')  return row[f.col] === f.val;
      if (f.op === 'neq') return row[f.col] !== f.val;
      // PostgREST semantics: NULL comparisons require .is()
      if (f.op === 'is')  return f.val === null ? row[f.col] == null : row[f.col] === f.val;
      return true;
    });
  }

  _attachRelations(rows) {
    if (!this._joinRelations || this._table !== 'claims') return rows;
    const evtTbl = getTable('claim_events');
    const dirTbl = getTable('diaries');
    const resTbl = getTable('reserves');
    return rows.map(r => ({
      ...r,
      claim_events: Array.from(evtTbl.values()).filter(e => e.claim_id === r.id),
      diaries:      Array.from(dirTbl.values()).filter(d => d.claim_id === r.id),
      reserves:     Array.from(resTbl.values()).filter(rv => rv.claim_id === r.id),
    }));
  }

  _execute() {
    const tbl = getTable(this._table);

    switch (this._op) {

      case 'select': {
        let rows = Array.from(tbl.values()).filter(r => this._matchRow(r));
        rows = this._attachRelations(rows);

        if (this._orderBy) {
          const { col, desc } = this._orderBy;
          rows.sort((a, b) => {
            const av = a[col], bv = b[col];
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return desc ? -cmp : cmp;
          });
        }

        if (this._limitN !== null) rows = rows.slice(0, this._limitN);

        if (this._single) {
          const row = rows[0] || null;
          const err = row ? null : { code: 'PGRST116', message: 'Row not found' };
          return { data: row, error: err };
        }
        return { data: rows, error: null };
      }

      case 'insert': {
        const items = Array.isArray(this._data) ? this._data : [this._data];
        const created = items.map(item => {
          const row = { id: item.id || uid(), created_at: new Date().toISOString(), ...item };
          tbl.set(row.id, row);
          return row;
        });

        const payload = Array.isArray(this._data) ? created : created[0];
        if (this._single) return { data: created[0] || null, error: null };
        if (this._wantData) return { data: payload, error: null };
        return { data: created, error: null };
      }

      case 'update': {
        const updated = [];
        for (const [id, row] of tbl.entries()) {
          if (this._matchRow(row)) {
            const newRow = { ...row, ...this._data, updated_at: new Date().toISOString() };
            tbl.set(id, newRow);
            updated.push(newRow);
          }
        }
        if (this._single) return { data: updated[0] || null, error: null };
        if (this._wantData) return { data: updated, error: null };
        return { data: updated, error: null };
      }

      case 'upsert': {
        const items = Array.isArray(this._data) ? this._data : [this._data];
        const result = items.map(item => {
          let existing = null;

          if (this._upsertKey && item[this._upsertKey] != null) {
            for (const r of tbl.values()) {
              if (r[this._upsertKey] === item[this._upsertKey]) { existing = r; break; }
            }
          } else if (item.id) {
            existing = tbl.get(item.id) || null;
          }

          if (existing) {
            const updated = { ...existing, ...item, updated_at: new Date().toISOString() };
            tbl.set(existing.id, updated);
            return updated;
          }
          const row = { id: item.id || uid(), created_at: new Date().toISOString(), ...item };
          tbl.set(row.id, row);
          return row;
        });

        const payload = Array.isArray(this._data) ? result : result[0];
        if (this._single) return { data: result[0] || null, error: null };
        if (this._wantData) return { data: payload, error: null };
        return { data: result, error: null };
      }

      case 'delete': {
        const deleted = [];
        for (const [id, row] of tbl.entries()) {
          if (this._matchRow(row)) {
            tbl.delete(id);
            deleted.push(row);
          }
        }
        return { data: deleted, error: null };
      }

      default:
        return { data: null, error: { message: `Unknown op: ${this._op}` } };
    }
  }
}

// ── Mock Supabase service-role client ─────────────────────────────────────────
const supabase = {
  from(tableName) {
    return new QueryBuilder(tableName);
  },

  rpc(funcName) {
    if (funcName === 'next_claim_number') {
      const num  = String(_claimSeq++).padStart(3, '0');
      const year = new Date().getFullYear();
      return Promise.resolve({ data: `HHW-${year}-${num}`, error: null });
    }
    return Promise.resolve({ data: null, error: { message: `Unknown RPC: ${funcName}` } });
  },

  /** Special helper exposed for test cleanup. Not part of the real Supabase API. */
  _resetStore(tableNames) {
    resetStore(tableNames);
  },
};

// ── Mock Supabase anon-key auth client ────────────────────────────────────────
const supabaseAuth = {
  from(tableName) {
    return new QueryBuilder(tableName);
  },

  auth: {
    async signInWithPassword({ email, password }) {
      const user = MOCK_AUTH_USERS.find(u => u.email === email && u.password === password);
      if (!user) {
        return { data: null, error: { message: 'Invalid login credentials' } };
      }
      return {
        data: {
          user: {
            id:    user.id,
            email: user.email,
            user_metadata: {
              role:          user.role,
              employer_id:   user.employer_id,
              employer_name: user.employer_name,
            },
          },
          session: { access_token: `mock-access-token-${user.id}` },
        },
        error: null,
      };
    },
  },

  /** Mirror the _resetStore helper on the auth client too. */
  _resetStore(tableNames) {
    resetStore(tableNames);
  },
};

// ── verifyConnection (always succeeds in tests) ───────────────────────────────
async function verifyConnection() {
  return true;
}

module.exports = { supabase, supabaseAuth, verifyConnection, _resetStore: resetStore };
