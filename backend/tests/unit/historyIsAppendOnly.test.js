'use strict';

/**
 * Static guard: claim_events is append-only in the database (migration
 * 20261003000001), so no code path may update or delete it — a correction
 * is a new event. The in-memory test double does not enforce this; this
 * scan does. The demo reset (scripts/seedDemo.js) is the one exemption and
 * runs under the database's narrow demo-purge rule.
 */

const fs   = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');
const EXEMPT = new Set([path.join(SRC, 'scripts', 'seedDemo.js')]);

function jsFiles(dir) {
  return fs.readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return fs.statSync(p).isDirectory() ? jsFiles(p) : (p.endsWith('.js') ? [p] : []);
  });
}

test('no source file updates or deletes claim_events (or audit_ledger)', () => {
  const offenders = [];
  const patterns = [
    /from\(\s*'(claim_events|audit_ledger)'\s*\)\s*\.\s*(update|delete|upsert)\s*\(/g,
    /tx\.update\(\s*'(claim_events|audit_ledger)'/g,
    /(UPDATE|DELETE\s+FROM|TRUNCATE)\s+"?(claim_events|audit_ledger)\b/gi,
  ];
  for (const file of jsFiles(SRC)) {
    if (EXEMPT.has(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        offenders.push(`${path.relative(SRC, file)}:${src.slice(0, m.index).split('\n').length} ${m[0]}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
