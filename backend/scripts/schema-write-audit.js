#!/usr/bin/env node
'use strict';

/**
 * schema-write-audit.js — every column the backend WRITES must exist in the
 * migrated schema.
 *
 * The in-memory Supabase double accepts any column, so a write the real
 * database rejects can pass the whole mock suite — and most supabase-js
 * writes do not check their error, so in production the write fails
 * silently. (Sprint 2 found five such columns, including the one that kept
 * the statutory RFA response-due diary from ever being created.)
 *
 * Statically scans backend/src for supabase-js writes —
 *   .from('<table>').insert|update|upsert({ ...literal })
 *   .from('<table>').insert|update|upsert(row)   with `const row = { ... }`
 *   tx.insert|update('<table>', { ...literal })  (unit-of-work adapter)
 * — and checks each top-level key against information_schema. Rows built
 * dynamically (spreads, keys added later) are outside its reach; the
 * real-PostgreSQL suite (npm run test:pg) covers the transactional paths.
 *
 * Run after the migrations are applied:
 *   DATABASE_URL=postgres://… node backend/scripts/schema-write-audit.js
 */

const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

const SRC = path.join(__dirname, '..', 'src');

function jsFiles(dir) {
  return fs.readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return fs.statSync(p).isDirectory() ? jsFiles(p) : (p.endsWith('.js') ? [p] : []);
  });
}

/** Top-level keys of the object literal whose '{' is at `open`. */
function literalKeys(src, open) {
  let depth = 0;
  let end = open;
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}' && --depth === 0) break;
  }
  const body = src.slice(open + 1, end);
  const parts = [];
  let d = 0;
  let cur = '';
  for (const ch of body) {
    if ('{[('.includes(ch)) d++;
    else if ('}])'.includes(ch)) d--;
    if (d === 0 && ch === ',') { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts
    .map(p => p.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim())
    .filter(p => p && !p.startsWith('...'))
    .map(p => (p.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?::|$)/) || [])[1])
    .filter(Boolean);
}

function writesIn(file) {
  const src = fs.readFileSync(file, 'utf8');
  const line = (i) => src.slice(0, i).split('\n').length;
  const out = [];

  const literal = /from\(\s*'([a-z_]+)'\s*\)\s*\.(insert|update|upsert)\(\s*\{/g;
  const viaVar  = /from\(\s*'([a-z_]+)'\s*\)\s*\.(insert|update|upsert)\(\s*([A-Za-z_]\w*)\s*[,)]/g;
  const viaTx   = /\btx\.(insert|update)\(\s*'([a-z_]+)'\s*,\s*\{/g;
  let m;
  while ((m = literal.exec(src))) {
    out.push({ table: m[1], op: m[2], keys: literalKeys(src, m.index + m[0].length - 1), at: line(m.index) });
  }
  while ((m = viaTx.exec(src))) {
    out.push({ table: m[2], op: m[1], keys: literalKeys(src, m.index + m[0].length - 1), at: line(m.index) });
  }
  while ((m = viaVar.exec(src))) {
    const def = new RegExp(`(?:const|let)\\s+${m[3]}\\s*=\\s*\\{`, 'g');
    let d;
    let last = null;
    while ((d = def.exec(src)) && d.index < m.index) last = d;
    if (last) out.push({ table: m[1], op: m[2], keys: literalKeys(src, last.index + last[0].length - 1), at: line(m.index) });
  }
  return out.map(w => ({ ...w, file: path.relative(path.join(__dirname, '..', '..'), file) }));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (a database with every migration applied)');
    process.exit(1);
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
  await client.end();

  const schema = new Map();
  for (const r of rows) {
    if (!schema.has(r.table_name)) schema.set(r.table_name, new Set());
    schema.get(r.table_name).add(r.column_name);
  }

  const writes = jsFiles(SRC).flatMap(writesIn);
  const problems = [];
  for (const w of writes) {
    const cols = schema.get(w.table);
    if (!cols) { problems.push(`${w.file}:${w.at} ${w.op} ${w.table} — table does not exist`); continue; }
    const missing = w.keys.filter(k => !cols.has(k));
    if (missing.length) problems.push(`${w.file}:${w.at} ${w.op} ${w.table} — no column: ${missing.join(', ')}`);
  }

  console.log(`── Schema write audit: ${writes.length} write sites checked`);
  for (const p of problems) console.error(`  ✕ ${p}`);
  console.log(problems.length ? `\n${problems.length} write(s) the schema would reject` : '  ✓ every audited write matches the schema');
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
