'use strict';

/**
 * liveIngestionTest.js — run every generated test PDF through the REAL
 * ingestion pipeline with the REAL Claude classifier.
 *
 * Intended to run in CI (the "Live ingestion test" workflow), where
 * ANTHROPIC_API_KEY is available as a repository secret. The database
 * is the same in-memory mock the Jest suite uses, seeded with the demo
 * book, so the run is hermetic: no hosted database is touched and the
 * only external call is the Anthropic API (one classification per PDF).
 *
 * What is REAL here: PDF validation, text-layer extraction, the Claude
 * classification (category / confidence / verbatim claim number /
 * signals), claim matching against the seeded book, triage routing,
 * deterministic action translation, and the diary/event/audit writes.
 *
 * Exit code 0 only if every document classifies, matches, and routes
 * exactly as manifest.json predicts.
 */

process.env.NODE_ENV = 'test'; // bypass config's required-env exit; DB is the in-memory mock

const fs   = require('fs');
const path = require('path');

// Install the in-memory DB before any service loads.
const supaPath = require.resolve('../services/supabase');
const mockSupa = require('../../tests/__mocks__/supabaseClient');
require.cache[supaPath] = { id: supaPath, filename: supaPath, loaded: true, exports: mockSupa };

const { seedDemo } = require('./seedDemo');
const ingestion    = require('../services/documentIngestionService');
const { supabase } = mockSupa;

const DOCS = path.join(__dirname, '../../../test-documents');

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required — this harness exists to exercise the real classifier');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(DOCS, 'manifest.json'), 'utf8'));

  await seedDemo();
  const results = [];

  for (const f of manifest.files) {
    const buffer = fs.readFileSync(path.join(DOCS, f.file));
    const row = { file: f.file };
    try {
      const { document, diary, routed } = await ingestion.ingestPdf(
        { buffer, filename: f.file, source: 'upload' }, 'live-test@ci');

      row.category   = document.category;
      row.confidence = document.classification_confidence;
      row.routed     = routed;
      row.claim      = document.claim_id || '(triage)';
      row.diary      = diary ? diary.diary_type : '—';

      const expectTriage = !f.claim_number;
      if (expectTriage) {
        // The guardrail under test: no claim number → human triage,
        // never silently filed (whatever the category/confidence).
        row.pass = routed === 'triage';
        row.note = `triage_reason=${document.triage_reason}`;
      } else {
        const checks = {
          category: document.category === f.category,
          claim:    document.claim_id === f.claim_id,
          diary:    !!diary && diary.diary_type === f.routing,
          filed:    routed === 'filed',
        };
        row.pass = Object.values(checks).every(Boolean);
        if (!row.pass) {
          row.note = Object.entries(checks).filter(([, ok]) => !ok)
            .map(([k]) => `${k} mismatch (expected ${f[k === 'diary' ? 'routing' : k === 'claim' ? 'claim_id' : 'category']})`)
            .join('; ');
        }
      }
    } catch (err) {
      row.routed = 'ERROR';
      row.pass = false;
      row.note = err.message;
    }
    results.push(row);
    // eslint-disable-next-line no-console
    console.log(`${row.pass ? '✓' : '✗'} ${row.file} → ${row.category || '-'} (${row.confidence ?? '-'}%) → ${row.claim || '-'} / ${row.diary || '-'}${row.note ? `  [${row.note}]` : ''}`);
  }

  // Every classification must have left an audit row (regulated decision).
  const { data: decisions } = await supabase.from('ai_decisions').select('*');
  const classRows = (decisions || []).filter(d => d.decision_type === 'doc_classification');
  const auditOk = classRows.length === manifest.files.length;
  // eslint-disable-next-line no-console
  console.log(`\nai_decisions audit rows for doc_classification: ${classRows.length}/${manifest.files.length} ${auditOk ? '✓' : '✗ MISSING'}`);

  // Markdown summary for the Actions run page.
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      '## Live ingestion test — real Claude classifier',
      '',
      '| File | Category | Conf | Claim | Diary queued | Result |',
      '|---|---|---|---|---|---|',
      ...results.map(r =>
        `| ${r.file} | ${r.category || '-'} | ${r.confidence ?? '-'} | ${r.claim || '-'} | ${r.diary || '-'} | ${r.pass ? '✅' : `❌ ${r.note || ''}`} |`),
      '',
      `Audit trail: ${classRows.length}/${manifest.files.length} doc_classification rows in ai_decisions ${auditOk ? '✅' : '❌'}`,
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  }

  const fails = results.filter(r => !r.pass).length + (auditOk ? 0 : 1);
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - results.filter(r => !r.pass).length}/${results.length} documents passed`);
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('liveIngestionTest failed:', err);
  process.exit(1);
});
