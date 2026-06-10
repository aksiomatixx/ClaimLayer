'use strict';

/**
 * END-TO-END — the core commercial demo path: document → action → decision.
 *
 * Walks every step of the required flow in order:
 *    1. ingest a document
 *    2. classify into a controlled category
 *    3. match to a claim (or human triage on low confidence)
 *    4. extract key fields for the document type
 *    5. AI summary + ai_decisions logging
 *    6. deterministic action translation via the rules table
 *    7. action surfaced in the decision brief with source-document links
 *    8. licensed human approves / edits / declines
 *    9. approval → claim note to the system of record, diary completed,
 *       successor diary set, notice generated where applicable
 *   10. full audit trail end to end
 */

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({ messages: { create: mockMessagesCreate } }))
);

const mockFhAddNote = jest.fn().mockResolvedValue({ noteId: 'nte-1' });
const mockFhCompleteDiary = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../src/services/filehandler', () => ({
  addNote: (...a) => mockFhAddNote(...a),
  completeDiary: (...a) => mockFhCompleteDiary(...a),
}));

const { supabase }   = require('../../src/services/supabase');
const ingestion      = require('../../src/services/documentIngestionService');
const diaryActions   = require('../../src/services/diaryActionService');
const decisionBrief  = require('../../src/services/decisionBriefService');

const CLAIM = 'claim_e2e';

function scriptClassifier(body) {
  mockMessagesCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify(body) }],
    usage: { input_tokens: 700, output_tokens: 220 },
  });
}

beforeEach(async () => {
  mockMessagesCreate.mockReset();
  mockFhAddNote.mockClear();
  mockFhCompleteDiary.mockClear();
  supabase._resetStore();
  await supabase.from('claims').insert({
    id: CLAIM, claim_number: 'HHW-2026-E2E', status: 'active_medical',
    date_of_injury: '2026-04-01', employer_id: 'emp-1', wcis_enabled: true,
    filehandler_id: 'FH-E2E', td_rate: 500, aww: 750,
    employee: { firstName: 'Endto', lastName: 'End' },
  });
});

const WORK_STATUS_TEXT =
  'WORK STATUS REPORT. Claim: HHW-2026-E2E. Patient: Endto End. ' +
  'Off work extended 21 days from 06/01/2026. Restrictions on return: no lifting over 10 lbs.';

describe('the complete document-to-action workflow', () => {
  it('steps 1–10: work status report → TD review → approval → aftermath', async () => {
    // ── steps 1–6: ingest ────────────────────────────────────────────────────
    scriptClassifier({
      category: 'work_status', confidence: 91, claim_number: 'HHW-2026-E2E',
      summary: 'Off-work order extended 21 days; restrictions: no lifting over 10 lbs.',
      key_fields: {
        report_date: '2026-06-01', work_status: 'off_work',
        restrictions: 'no lifting over 10 lbs', signals: [],
      },
    });

    const ingestResult = await ingestion.ingestDocument({
      title: 'Work status report', filename: 'wsr.pdf',
      content_text: WORK_STATUS_TEXT, source: 'upload',
    }, 'adjuster@test');

    // 2. controlled category
    expect(ingestResult.document.category).toBe('work_status');
    // 3. matched via the verbatim-extracted, table-verified claim number
    expect(ingestResult.document.claim_id).toBe(CLAIM);
    expect(ingestResult.routed).toBe('filed');
    // 4. key fields extracted and stored
    expect(ingestResult.document.key_fields.work_status).toBe('off_work');
    expect(ingestResult.document.key_fields.restrictions).toBe('no lifting over 10 lbs');
    // 5. AI summary + ai_decisions log
    expect(ingestResult.document.ai_summary).toContain('Off-work order');
    const { data: aiRows } = await supabase.from('ai_decisions').select('*');
    expect(aiRows).toHaveLength(1);
    expect(aiRows[0].decision_type).toBe('doc_classification');
    expect(aiRows[0].input_tokens).toBe(700);
    // 6. deterministic rules-table translation
    expect(ingestResult.diary.diary_type).toBe('TD_PAYMENT_REVIEW');
    expect(ingestResult.diary.priority).toBe('HIGH');
    expect(ingestResult.diary.source_document_id).toBe(ingestResult.document.id);

    // ── step 7: surfaced in the decision brief with the source doc linked ───
    const { data: claim } = await supabase.from('claims').select('*').eq('id', CLAIM).single();
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', CLAIM);
    const { data: documents } = await supabase.from('claim_documents').select('*').eq('claim_id', CLAIM);
    const brief = decisionBrief.buildBrief({ claim, diaries, documents });
    const briefAction = brief.actions.find(a => a.diary_id === ingestResult.diary.id);
    expect(briefAction).toBeTruthy();
    expect(briefAction.action).toContain('temporary disability');
    expect(briefAction.document_ids).toContain(ingestResult.document.id);

    // ── step 8: preview, then the licensed human approves ───────────────────
    const preview = await diaryActions.previewAftermath(ingestResult.diary.id);
    const cont = preview.actions.find(a => a.action === 'continue');
    expect(cont.will.join(' ')).toContain('TD_PAYMENT_REVIEW');

    const approval = await diaryActions.completeAction(
      ingestResult.diary.id, { action: 'continue', note: 'work status reviewed — remains TTD' }, 'adjuster@test');

    // ── step 9: aftermath ────────────────────────────────────────────────────
    //   claim note written to the system of record
    expect(mockFhAddNote).toHaveBeenCalledTimes(1);
    expect(mockFhAddNote.mock.calls[0][0]).toBe('FH-E2E');
    expect(mockFhAddNote.mock.calls[0][1]).toContain('work status reviewed');
    //   diary completed with the decision on it
    const { data: done } = await supabase.from('diaries').select('*').eq('id', ingestResult.diary.id).single();
    expect(done.status).toBe('completed');
    expect(done.decision_action).toBe('continue');
    //   successor diary set (the biweekly LC §4650 cycle)
    expect(approval.successor_diaries.map(s => s.diary_type)).toEqual(['TD_PAYMENT_REVIEW']);

    // ── step 10: the full audit trail exists ─────────────────────────────────
    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    const types = events.map(e => e.type);
    expect(types).toContain('document_ingested');
    expect(types).toContain('action_completed');
    const { data: audit } = await supabase.from('audit_log').select('*');
    expect(audit.some(a => a.action === 'action_completed')).toBe(true);
  });

  it('the suspend branch generates the statutory notice in the same flow', async () => {
    scriptClassifier({
      category: 'work_status', confidence: 90, claim_number: 'HHW-2026-E2E',
      summary: 'Full-duty release effective immediately.',
      key_fields: { work_status: 'full_duty', signals: ['rtw_release'] },
    });
    const ingest = await ingestion.ingestDocument({
      title: 'RTW release', content_text: WORK_STATUS_TEXT, source: 'upload',
    }, 'adjuster@test');

    const approval = await diaryActions.completeAction(
      ingest.diary.id, { action: 'suspend', note: 'released to full duty' }, 'adjuster@test');

    expect(approval.notices_generated.some(n => n.type === 'td_suspension')).toBe(true);
    const { data: notices } = await supabase.from('benefit_notices').select('*').eq('claim_id', CLAIM);
    expect(notices.some(n => n.notice_type === 'td_suspension' && n.status === 'queued')).toBe(true);
  });

  it('low confidence routes to human triage, and human resolution joins the same pipeline', async () => {
    scriptClassifier({
      category: 'medical', confidence: 38, claim_number: null,
      summary: 'Illegible fax fragment.', key_fields: { signals: [] },
    });
    const ingest = await ingestion.ingestDocument({
      title: 'Fax', content_text: 'blurry', source: 'fax',
    }, 'adjuster@test');
    expect(ingest.routed).toBe('triage');
    expect(ingest.diary).toBeNull();

    const resolved = await ingestion.resolveTriage(ingest.document.id, {
      action: 'file', claim_id: CLAIM, category: 'work_status',
    }, 'adjuster@test');
    expect(resolved.diary.diary_type).toBe('TD_PAYMENT_REVIEW');
    expect(resolved.diary.source_document_id).toBe(ingest.document.id);
  });

  it('the decline branch documents the human disagreement with no aftermath', async () => {
    scriptClassifier({
      category: 'work_status', confidence: 92, claim_number: 'HHW-2026-E2E',
      summary: 'Duplicate of prior report.', key_fields: { signals: [] },
    });
    const ingest = await ingestion.ingestDocument({
      title: 'Duplicate WSR', content_text: WORK_STATUS_TEXT, source: 'upload',
    }, 'adjuster@test');

    const declined = await diaryActions.declineAction(
      ingest.diary.id, { reason: 'duplicate of report received 6/1' }, 'adjuster@test');
    expect(declined.status).toBe('cancelled');
    expect(mockFhAddNote).toHaveBeenCalled(); // documented in the ledger too

    const { data: notices } = await supabase.from('benefit_notices').select('*').eq('claim_id', CLAIM);
    expect(notices).toHaveLength(0);
  });
});
