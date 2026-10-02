'use strict';

/**
 * Static guard: claim_events (migration 20261003000001) and the financial
 * ledgers reserve_transactions and loss_fund_transactions (20261005000001 /
 * 20261005000003) are append-only in the database, so no code path may
 * update or delete them — a correction is a new entry. The in-memory test double does not enforce this; this
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

const LEDGERS = 'claim_events|audit_ledger|reserve_transactions|loss_fund_transactions';

test('no source file updates or deletes claim_events, audit_ledger or a financial ledger', () => {
  const offenders = [];
  const patterns = [
    new RegExp(`from\\(\\s*'(${LEDGERS})'\\s*\\)\\s*\\.\\s*(update|delete|upsert)\\s*\\(`, 'g'),
    new RegExp(`tx\\.(update|upsert)\\(\\s*'(${LEDGERS})'`, 'g'),
    new RegExp(`(UPDATE|DELETE\\s+FROM|TRUNCATE)\\s+"?(${LEDGERS})\\b`, 'gi'),
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
