'use strict';

/**
 * Unit tests — Inbound Document Ingestion & Classification.
 *
 * The Anthropic SDK is mocked so each test scripts the classifier's
 * output; everything downstream (guardrails, triage routing, claim
 * matching, deterministic action translation, audit logging) is the
 * real pipeline against the in-memory store.
 */

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({ messages: { create: mockMessagesCreate } }))
);

const { supabase } = require('../../src/services/supabase');
const ingestion = require('../../src/services/documentIngestionService');

const CLAIM = 'claim_ingest_test';

function mockClassification(body) {
  mockMessagesCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify(body) }],
    usage: { input_tokens: 500, output_tokens: 200 },
  });
}

beforeEach(async () => {
  mockMessagesCreate.mockReset();
  supabase._resetStore();
  await supabase.from('claims').insert({
    id: CLAIM, claim_number: 'HHW-2026-D08', status: 'active_medical',
    date_of_injury: '2026-04-01', employer_id: 'emp-1', wcis_enabled: true,
  });
});

const baseInput = {
  title: 'PR-2 progress report',
  filename: 'pr2.pdf',
  content_text: 'PROGRESS REPORT PR-2. Claim: HHW-2026-D08. Patient improving with PT. Remains TTD.',
  source: 'upload',
};

describe('confident classification → filed + prepared decision', () => {
  it('files the document and queues the category-mapped diary', async () => {
    mockClassification({
      category: 'medical', confidence: 92, claim_number: 'HHW-2026-D08',
      summary: 'PR-2 progress report; improving with PT; remains TTD.',
      key_fields: { report_date: '2026-06-01', work_status: 'off_work', restrictions: null, signals: [] },
    });

    const result = await ingestion.ingestDocument({ ...baseInput, claim_id: CLAIM }, 'adj@test');
    expect(result.routed).toBe('filed');
    expect(result.document.status).toBe('filed');
    expect(result.document.ai_summary).toContain('PR-2');
    expect(result.document.classification_confidence).toBe(92);

    expect(result.diary.diary_type).toBe('MED_REPORT_REVIEW');
    expect(result.diary.priority).toBe('MEDIUM');
    expect(result.diary.source_document_id).toBe(result.document.id);

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    expect(events.some(e => e.type === 'document_ingested')).toBe(true);
  });

  it('matches the claim from the verbatim-extracted claim number when the channel does not know it', async () => {
    mockClassification({
      category: 'work_status', confidence: 88, claim_number: 'HHW-2026-D08',
      summary: 'Off-work order extended 21 days.',
      key_fields: { work_status: 'off_work', signals: [] },
    });

    const result = await ingestion.ingestDocument(baseInput, 'adj@test');
    expect(result.routed).toBe('filed');
    expect(result.document.claim_id).toBe(CLAIM);
    expect(result.diary.diary_type).toBe('TD_PAYMENT_REVIEW');
    expect(result.diary.priority).toBe('HIGH');
  });

  it('RFA receipt queues the CRITICAL one-day UR-clock diary', async () => {
    mockClassification({
      category: 'rfa', confidence: 95, claim_number: 'HHW-2026-D08',
      summary: 'RFA for 12 PT visits.', key_fields: { signals: ['treatment_request'] },
    });
    const result = await ingestion.ingestDocument(baseInput, 'adj@test');
    expect(result.diary.diary_type).toBe('RFA_INTAKE_REVIEW');
    expect(result.diary.priority).toBe('CRITICAL');
  });

  it('signal overrides refine the action: P&S report → PR4_RECEIVED_REVIEW', async () => {
    mockClassification({
      category: 'medical', confidence: 90, claim_number: 'HHW-2026-D08',
      summary: 'PR-4: patient permanent and stationary, WPI 8%.',
      key_fields: { signals: ['p_and_s'] },
    });
    const result = await ingestion.ingestDocument(baseInput, 'adj@test');
    expect(result.diary.diary_type).toBe('PR4_RECEIVED_REVIEW');
  });
});

describe('triage guardrails — never silently file', () => {
  it('low confidence routes to triage with no diary', async () => {
    mockClassification({
      category: 'medical', confidence: 45, claim_number: 'HHW-2026-D08',
      summary: 'Fragmentary note.', key_fields: { signals: [] },
    });
    const result = await ingestion.ingestDocument(baseInput, 'adj@test');
    expect(result.routed).toBe('triage');
    expect(result.diary).toBeNull();
    expect(result.document.triage_status).toBe('pending');
    expect(result.document.triage_reason).toContain('confidence_below_threshold');

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', CLAIM);
    expect(diaries).toHaveLength(0);
  });

  it('no claim match routes to triage even at high confidence', async () => {
    mockClassification({
      category: 'medical', confidence: 93, claim_number: null,
      summary: 'Clear PR-2 but no claim number in text.', key_fields: { signals: [] },
    });
    const result = await ingestion.ingestDocument(baseInput, 'adj@test'); // no claim_id from channel
    expect(result.routed).toBe('triage');
    expect(result.document.claim_id).toBeNull();
    expect(result.document.triage_reason).toBe('no_claim_match');
  });

  it('hallucinated claim numbers do not file: unverifiable number → triage', async () => {
    mockClassification({
      category: 'medical', confidence: 91, claim_number: 'HHW-9999-FAKE',
      summary: 'Report referencing an unknown claim.', key_fields: { signals: [] },
    });
    const result = await ingestion.ingestDocument(baseInput, 'adj@test');
    expect(result.routed).toBe('triage');
    expect(result.document.claim_id).toBeNull();
  });

  it('category outside the controlled list trips the guardrail and goes to triage', async () => {
    mockClassification({
      category: 'super_secret_new_type', confidence: 96, claim_number: 'HHW-2026-D08',
      summary: 'Whatever this is.', key_fields: { signals: [] },
    });
    const result = await ingestion.ingestDocument({ ...baseInput, claim_id: CLAIM }, 'adj@test');
    expect(result.routed).toBe('triage');
    expect(result.document.category).toBe('other');
    expect(result.document.triage_reason).toBe('category_guardrail');

    const { data: decisions } = await supabase.from('ai_decisions').select('*');
    const g = decisions[0].guardrail_actions.find(x => x.rule === 'controlled_category_list');
    expect(g.triggered).toBe(true);
    expect(g.original).toBe('super_secret_new_type');
  });

  it('rejects ingestion with no content text', async () => {
    await expect(ingestion.ingestDocument({ title: 'x', content_text: '' }, 'adj@test'))
      .rejects.toThrow('content_text is required');
  });
});

describe('audit trail', () => {
  it('every classification lands in ai_decisions with tokens + confidence', async () => {
    mockClassification({
      category: 'legal', confidence: 85, claim_number: 'HHW-2026-D08',
      summary: 'Attorney letter.', key_fields: { signals: [] },
    });
    await ingestion.ingestDocument({ ...baseInput, claim_id: CLAIM }, 'adj@test');

    const { data: decisions } = await supabase.from('ai_decisions').select('*');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision_type).toBe('doc_classification');
    expect(decisions[0].prompt_name).toBe('document_classification');
    expect(decisions[0].confidence).toBe(85);
    expect(decisions[0].input_tokens).toBe(500);
  });
});

describe('human triage resolution', () => {
  async function triagedDoc() {
    mockClassification({
      category: 'medical', confidence: 40, claim_number: null,
      summary: 'Illegible fax.', key_fields: { signals: [] },
    });
    const r = await ingestion.ingestDocument(baseInput, 'adj@test');
    return r.document;
  }

  it('filing through triage runs the same action translation', async () => {
    const doc = await triagedDoc();
    const result = await ingestion.resolveTriage(doc.id, {
      action: 'file', claim_id: CLAIM, category: 'work_status',
    }, 'adj@test');

    expect(result.document.status).toBe('filed');
    expect(result.document.claim_id).toBe(CLAIM);
    expect(result.document.triage_status).toBe('resolved');
    expect(result.diary.diary_type).toBe('TD_PAYMENT_REVIEW');
  });

  it('rejecting marks the document rejected with no diary', async () => {
    const doc = await triagedDoc();
    const result = await ingestion.resolveTriage(doc.id, { action: 'reject' }, 'adj@test');
    expect(result.document.status).toBe('rejected');
    expect(result.diary).toBeNull();
  });

  it('validates claim, category, and pending state', async () => {
    const doc = await triagedDoc();
    await expect(ingestion.resolveTriage(doc.id, { action: 'file', claim_id: 'nope' }, 'a'))
      .rejects.toThrow('Claim not found');
    await expect(ingestion.resolveTriage(doc.id, { action: 'file', claim_id: CLAIM, category: 'bogus' }, 'a'))
      .rejects.toThrow('controlled list');
    await ingestion.resolveTriage(doc.id, { action: 'reject' }, 'a');
    await expect(ingestion.resolveTriage(doc.id, { action: 'reject' }, 'a'))
      .rejects.toThrow('not pending triage');
  });

  it('listTriage returns only pending documents, oldest first', async () => {
    await triagedDoc();
    await triagedDoc();
    const list = await ingestion.listTriage();
    expect(list).toHaveLength(2);
    await ingestion.resolveTriage(list[0].id, { action: 'reject' }, 'a');
    expect(await ingestion.listTriage()).toHaveLength(1);
  });
});
