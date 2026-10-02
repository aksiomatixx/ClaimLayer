'use strict';

/**
 * Document ingestion and human triage on real PostgreSQL (ADR-0006,
 * increment 2): a filed document never exists without its prepared action
 * diary and event, and a triage resolution commits whole or not at all.
 */

jest.mock('../../src/services/supabase', () => require('./pgSupabase'));
jest.mock('../../src/services/aiService', () => ({ classifyDocument: jest.fn(), classifyDocumentFromPdf: jest.fn() }));

const aiService = require('../../src/services/aiService');
const ingestion = require('../../src/services/documentIngestionService');
const { getPool, closePool } = require('../../src/db/pool');

const db = (sql, params) => getPool().query(sql, params).then(r => r.rows);
const count = async (sql, params) => (await db(sql, params))[0].n;
let n = 0;

async function blockOn(table, check, fn) {
  const name = `test_block_${table}_${++n}`;
  await db(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${check}) NOT VALID`);
  try { return await fn(); } finally { await db(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`); }
}

async function seedClaim() {
  const id = `claim_di_${process.pid}_${++n}`;
  const number = `DI-${process.pid % 100000}-${n}`;
  await db(`INSERT INTO claims (id, claim_number, status, date_of_injury) VALUES ($1, $2, 'active_medical', '2026-04-01')`, [id, number]);
  return { id, number };
}

const classify = (over) => aiService.classifyDocument.mockResolvedValueOnce({
  category: 'work_status', confidence: 92, summary: 'Off work 14 days.', key_fields: { signals: [] },
  guardrails: [], ...over,
});

afterAll(closePool);

describe('ingestDocument', () => {
  test('a confident classification files the document, its action diary and its event together', async () => {
    const claim = await seedClaim();
    classify({ claim_number: claim.number });
    const out = await ingestion.ingestDocument({ title: 'WSR', content_text: 'work status', source: 'fax' }, 'intake@tpa.test');
    expect(out.routed).toBe('filed');
    expect(await db('SELECT status FROM claim_documents WHERE id = $1', [out.document.id])).toEqual([{ status: 'filed' }]);
    expect(await db('SELECT diary_type FROM diaries WHERE source_document_id = $1', [out.document.id]))
      .toEqual([{ diary_type: 'TD_PAYMENT_REVIEW' }]);
    expect(await count(`SELECT count(*)::int AS n FROM claim_events WHERE claim_id = $1 AND type = 'document_ingested'`, [claim.id])).toBe(1);
  });

  for (const [what, table, check] of [
    ['its action diary', 'diaries', `diary_type <> 'TD_PAYMENT_REVIEW'`],
    ['its event', 'claim_events', `type <> 'document_ingested'`],
  ]) {
    test(`if ${what} cannot be written, no orphan document is filed`, async () => {
      const claim = await seedClaim();
      classify({ claim_number: claim.number });
      await blockOn(table, check, () =>
        expect(ingestion.ingestDocument({ title: 'WSR', content_text: 'work status', source: 'fax' }, 'a'))
          .rejects.toThrow(/filing failed and was rolled back/));
      expect(await count('SELECT count(*)::int AS n FROM claim_documents WHERE claim_id = $1', [claim.id])).toBe(0);
      expect(await count('SELECT count(*)::int AS n FROM diaries WHERE claim_id = $1', [claim.id])).toBe(0);
      expect(await count('SELECT count(*)::int AS n FROM claim_events WHERE claim_id = $1', [claim.id])).toBe(0);
    });
  }
});

describe('resolveTriage', () => {
  async function triaged() {
    aiService.classifyDocument.mockResolvedValueOnce({
      category: 'medical', confidence: 20, summary: 'Unreadable fax.', key_fields: { signals: [] }, guardrails: [],
    });
    const { document } = await ingestion.ingestDocument({ title: 'Fax', content_text: 'x', source: 'fax' }, 'a');
    expect(document.triage_status).toBe('pending');
    return document;
  }

  test('filing commits the document, its diary, event and audit row together', async () => {
    const claim = await seedClaim();
    const doc = await triaged();
    const out = await ingestion.resolveTriage(doc.id, { action: 'file', claim_id: claim.id, category: 'work_status' }, 'adj@tpa.test');
    expect(out.document).toMatchObject({ status: 'filed', triage_status: 'resolved', claim_id: claim.id });
    expect(out.diary.diary_type).toBe('TD_PAYMENT_REVIEW');
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE resource_id = $1 AND action = 'document_triage_filed'`, [doc.id])).toBe(1);
  });

  test('a failed finalize leaves no record claiming the document was filed', async () => {
    const claim = await seedClaim();
    const doc = await triaged();
    await blockOn('claim_documents', `triage_status <> 'resolved'`, () =>
      expect(ingestion.resolveTriage(doc.id, { action: 'file', claim_id: claim.id, category: 'work_status' }, 'adj@tpa.test'))
        .rejects.toThrow());
    expect(await db('SELECT status, triage_status, claim_id FROM claim_documents WHERE id = $1', [doc.id]))
      .toEqual([{ status: 'triage', triage_status: 'pending', claim_id: null }]);
    expect(await count('SELECT count(*)::int AS n FROM diaries WHERE claim_id = $1', [claim.id])).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM claim_events WHERE claim_id = $1', [claim.id])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE resource_id = $1`, [doc.id])).toBe(0);

    // Still resolvable afterwards.
    const retry = await ingestion.resolveTriage(doc.id, { action: 'file', claim_id: claim.id, category: 'work_status' }, 'adj@tpa.test');
    expect(retry.document.status).toBe('filed');
  });

  test('a rejection records its reason and audit row in one unit', async () => {
    const doc = await triaged();
    await blockOn('audit_log', `action <> 'document_rejected'`, () =>
      expect(ingestion.resolveTriage(doc.id, { action: 'reject', reason: 'Not ours — misdirected fax' }, 'adj@tpa.test'))
        .rejects.toThrow());
    expect(await db('SELECT status, triage_status FROM claim_documents WHERE id = $1', [doc.id]))
      .toEqual([{ status: 'triage', triage_status: 'pending' }]);

    await ingestion.resolveTriage(doc.id, { action: 'reject', reason: 'Not ours — misdirected fax' }, 'adj@tpa.test');
    expect(await db('SELECT status, rejection_reason FROM claim_documents WHERE id = $1', [doc.id]))
      .toEqual([{ status: 'rejected', rejection_reason: 'Not ours — misdirected fax' }]);
  });

  test('two concurrent resolutions: exactly one wins', async () => {
    const claim = await seedClaim();
    const doc = await triaged();
    const results = await Promise.allSettled([
      ingestion.resolveTriage(doc.id, { action: 'file', claim_id: claim.id, category: 'work_status' }, 'a@tpa.test'),
      ingestion.resolveTriage(doc.id, { action: 'reject', reason: 'duplicate of an earlier fax' }, 'b@tpa.test'),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected').reason.message).toBe('Document is not pending triage');
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE resource_id = $1`, [doc.id])).toBe(1);
  });
});
