'use strict';

/** Integration — document ingestion routes (incl. mount-order guard). */

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({ messages: { create: mockMessagesCreate } }))
);

const request                = require('supertest');
const app                    = require('../../src/index');
const { supabase }           = require('../../src/services/supabase');
const { generateAdminToken } = require('../../src/middleware/auth');

const adminToken = generateAdminToken({ sub: 'admin-001', email: 'admin@test' });
const auth = (r) => r.set('Cookie', `token=${adminToken}`);

const CLAIM = 'claim_ingest_route';

function mockClassification(body) {
  mockMessagesCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify(body) }],
    usage: { input_tokens: 400, output_tokens: 150 },
  });
}

beforeEach(async () => {
  mockMessagesCreate.mockReset();
  supabase._resetStore();
  await supabase.from('claims').insert({
    id: CLAIM, claim_number: 'HHW-2026-R01', status: 'active_medical',
    date_of_injury: '2026-04-01', employer_id: 'emp-1', wcis_enabled: true,
  });
});

describe('POST /claims/:id/documents/ingest', () => {
  it('files a confident document and returns the queued diary', async () => {
    mockClassification({
      category: 'medical', confidence: 90, claim_number: null,
      summary: 'PR-2.', key_fields: { signals: [] },
    });
    const res = await auth(request(app).post(`/api/v1/claims/${CLAIM}/documents/ingest`))
      .send({ title: 'PR-2', content_text: 'progress report text' });
    expect(res.status).toBe(201);
    expect(res.body.routed).toBe('filed');
    expect(res.body.diary.diary_type).toBe('MED_REPORT_REVIEW');
  });

  it('requires content_text (400) and admin role', async () => {
    const bad = await auth(request(app).post(`/api/v1/claims/${CLAIM}/documents/ingest`)).send({});
    expect(bad.status).toBe(400);
    const denied = await request(app).post(`/api/v1/claims/${CLAIM}/documents/ingest`)
      .send({ content_text: 'x' });
    expect([401, 403]).toContain(denied.status);
  });
});

describe('signal overrides are scoped to their categories', () => {
  const ingest = (title) =>
    auth(request(app).post(`/api/v1/claims/${CLAIM}/documents/ingest`))
      .send({ title, content_text: `${title} text` });

  it('p_and_s on a medical report routes to PR4_RECEIVED_REVIEW', async () => {
    mockClassification({
      category: 'medical', confidence: 95, claim_number: null,
      summary: 'PR-4 declaring P&S.', key_fields: { signals: ['p_and_s'] },
    });
    const res = await ingest('PR-4');
    expect(res.body.diary.diary_type).toBe('PR4_RECEIVED_REVIEW');
  });

  it('p_and_s on a settlement document does NOT override — stays SETTLEMENT_DOC_REVIEW', async () => {
    // Live-classifier finding: a C&R counter that cites the PR-4 rating
    // gets the p_and_s signal; the override must not hijack its routing.
    mockClassification({
      category: 'settlement', confidence: 95, claim_number: null,
      summary: 'C&R counter citing the PR-4 rating.', key_fields: { signals: ['p_and_s'] },
    });
    const res = await ingest('C&R counter');
    expect(res.body.diary.diary_type).toBe('SETTLEMENT_DOC_REVIEW');
  });

  it('p_and_s on a QME scheduling notice does NOT override — stays QME_REPORT_REVIEW', async () => {
    mockClassification({
      category: 'qme', confidence: 95, claim_number: null,
      summary: 'QME appointment notice mentioning impairment.', key_fields: { signals: ['p_and_s'] },
    });
    const res = await ingest('QME notice');
    expect(res.body.diary.diary_type).toBe('QME_REPORT_REVIEW');
  });

  it('representation_change on a legal document still overrides to REPRESENTATION_REVIEW', async () => {
    mockClassification({
      category: 'legal', confidence: 95, claim_number: null,
      summary: 'Notice of representation.', key_fields: { signals: ['representation_change'] },
    });
    const res = await ingest('Rep letter');
    expect(res.body.diary.diary_type).toBe('REPRESENTATION_REVIEW');
  });
});

describe('triage queue routes', () => {
  it('GET /documents/triage is not swallowed by the documents/:id route', async () => {
    mockClassification({
      category: 'medical', confidence: 30, claim_number: null,
      summary: 'Illegible.', key_fields: { signals: [] },
    });
    await auth(request(app).post('/api/v1/documents/ingest'))
      .send({ title: 'Fax', content_text: 'blurry text' });

    const res = await auth(request(app).get('/api/v1/documents/triage'));
    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.documents[0].triage_status).toBe('pending');
  });

  it('POST /documents/:docId/triage-resolve files through the same pipeline', async () => {
    mockClassification({
      category: 'medical', confidence: 30, claim_number: null,
      summary: 'Illegible.', key_fields: { signals: [] },
    });
    const ingest = await auth(request(app).post('/api/v1/documents/ingest'))
      .send({ title: 'Fax', content_text: 'blurry text' });
    const docId = ingest.body.document.id;

    const res = await auth(request(app).post(`/api/v1/documents/${docId}/triage-resolve`))
      .send({ action: 'file', claim_id: CLAIM, category: 'work_status' });
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('filed');
    expect(res.body.diary.diary_type).toBe('TD_PAYMENT_REVIEW');
  });
});
