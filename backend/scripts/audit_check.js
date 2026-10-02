const fs = require('fs');
const path = require('path');
const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase', 'migrations');
const SRC = path.join(process.cwd(), 'backend', 'src');

const schema = new Map();
const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

for (const file of files) {
  const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)\s*\(([\s\S]*?)\);/gi;
  let match;
  while ((match = createTableRegex.exec(content)) !== null) {
    const table = match[1].toLowerCase();
    if (!schema.has(table)) schema.set(table, new Set());
    const body = match[2];
    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('CONSTRAINT') || trimmed.startsWith('PRIMARY') || trimmed.startsWith('FOREIGN') || trimmed.startsWith('CHECK') || trimmed.startsWith('UNIQUE')) continue;
      const colMatch = trimmed.match(/^([a-z0-9_]+)\s+/i);
      if (colMatch) {
        schema.get(table).add(colMatch[1].toLowerCase());
      }
    }
  }

  const alterRegex = /ALTER\s+TABLE\s+(?:ONLY\s+)?([a-z0-9_]+)\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)/gi;
  while ((match = alterRegex.exec(content)) !== null) {
    const table = match[1].toLowerCase();
    const col = match[2].toLowerCase();
    if (!schema.has(table)) schema.set(table, new Set());
    schema.get(table).add(col);
  }
}

// Add standard tenant_id to all tables
for (const [t, cols] of schema.entries()) {
  cols.add('tenant_id');
}

function jsFiles(dir) {
  return fs.readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return fs.statSync(p).isDirectory() ? jsFiles(p) : (p.endsWith('.js') ? [p] : []);
  });
}

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
  const viaTx   = /\btx\.(insert|update|upsert)\(\s*'([a-z_]+)'\s*,\s*\{/g;
  const viaTxArr = /\btx\.(insert)\(\s*'([a-z_]+)'\s*,\s*\[/g;
  const viaTxVar = /\btx\.(insert|update|upsert)\(\s*'([a-z_]+)'\s*,\s*([A-Za-z_]\w*)\s*[,)]/g;
  let m;
  while ((m = literal.exec(src))) {
    out.push({ table: m[1], op: m[2], keys: literalKeys(src, m.index + m[0].length - 1), at: line(m.index) });
  }
  while ((m = viaTx.exec(src))) {
    out.push({ table: m[2], op: m[1], keys: literalKeys(src, m.index + m[0].length - 1), at: line(m.index) });
  }
  while ((m = viaTxArr.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === ']' && depth === 0) break;
      if (c === '{') {
        if (depth === 0) out.push({ table: m[2], op: m[1], keys: literalKeys(src, i), at: line(m.index) });
        depth++;
      } else if (c === '}') depth--;
    }
  }
  const resolveVar = (name, before) => {
    const def = new RegExp('(?:const|let)\\s+' + name + '\\s*=\\s*\\{', 'g');
    let d;
    let last = null;
    while ((d = def.exec(src)) && d.index < before) last = d;
    return last;
  };
  while ((m = viaTxVar.exec(src))) {
    const last = resolveVar(m[3], m.index);
    if (last) out.push({ table: m[2], op: m[1], keys: literalKeys(src, last.index + last[0].length - 1), at: line(m.index) });
  }
  while ((m = viaVar.exec(src))) {
    const def = new RegExp('(?:const|let)\\s+' + m[3] + '\\s*=\\s*\\{', 'g');
    let d;
    let last = null;
    while ((d = def.exec(src)) && d.index < m.index) last = d;
    if (last) out.push({ table: m[1], op: m[2], keys: literalKeys(src, last.index + last[0].length - 1), at: line(m.index) });
  }
  return out.map(w => ({ ...w, file: path.relative(process.cwd(), file) }));
}

const writes = jsFiles(SRC).flatMap(writesIn);
const problems = [];
for (const w of writes) {
  const cols = schema.get(w.table);
  if (!cols) { problems.push(`${w.file}:${w.at} ${w.op} ${w.table} — table does not exist`); continue; }
  const missing = w.keys.filter(k => !cols.has(k.toLowerCase()));
  if (missing.length) problems.push(`${w.file}:${w.at} ${w.op} ${w.table} — no column: ${missing.join(', ')}`);
}

console.log('Total writes:', writes.length);
console.log('Problems found count:', problems.length);
for (const p of problems) {
  console.log('Problem:', p);
}
