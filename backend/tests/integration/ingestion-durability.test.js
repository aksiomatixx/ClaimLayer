'use strict';

/**
 * Ingestion durability + receipt-anchored dates (Finding 9 of the
 * production-hardening pass).
 *
 * - the channel's authoritative received_at drives every deadline:
 *   a document delayed in a fax queue gets no extra statutory clock
 * - explicit claim ids are validated before anything is written
 * - document + action diary + event are one unit; a partial failure
 *   compensates instead of leaving a silently-filed orphan
 * - triage resolution is atomic (pending → resolving claim) and
 *   rejections record reason, actor, and an audit event
 */

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({ messages: { create: mockMessagesCreate } }))
);

const { supabase } = require('../../src/services/supabase');
const ingestion = require('../../src/services/documentIngestionService');

const CLAIM = 'claim_durability';

function iso(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString();
}
const day = (ts) => ts.split('T')[0];

function mockClassification(body) {
  mockMessagesCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify(body) }],
    usage: { input_tokens: 500, output_tokens: 200 },
  });
}

const CONFIDENT_WSR = {
  category: 'work_status', confidence: 92, claim_number: 'HHW-DUR-1',
  summary: 'Off work 14 days.', key_fields: { signals: [] },
};

beforeEach(async () => {
  mockMessagesCreate.mockReset();
  supabase._resetStore();
  await supabase.from('claims').insert({
    id: CLAIM, claim_number: 'HHW-DUR-1', status: 'active_medical',
    date_of_injury: '2026-04-01', employer_id: 'emp-1', wcis_enabled: false,
  });
});

describe('receipt-anchored deadlines', () => {
  it('a document received 3 days ago gets its deadline from receipt, not processing time', async () => {
    mockClassification(CONFIDENT_WSR);
    const receivedAt = iso(-3);

    const result = await ingestion.ingestDocument({
      title: 'Delayed WSR', content_text: 'work status report …', source: 'fax',
      received_at: receivedAt,
    }, 'adj@test');

    expect(result.document.received_at).toBe(new Date(receivedAt).toISOString());
    // work_status → TD_PAYMENT_REVIEW, due 3 calendar days from RECEIPT:
    // receipt was 3 days ago, so the action is due TODAY.
    expect(result.diary.due_date).toBe(day(iso(0)));

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    const ev = events.find(e => e.type === 'document_ingested');
    expect(ev.data.received_at).toBe(new Date(receivedAt).toISOString());
  });

  it('without a channel timestamp, receipt defaults to processing time', async () => {
    mockClassification(CONFIDENT_WSR);
    const result = await ingestion.ingestDocument({
      title: 'WSR', content_text: 'work status …', source: 'upload',
    }, 'adj@test');
    expect(result.diary.due_date).toBe(day(iso(3)));
  });

  it('rejects malformed and future received_at values', async () => {
    mockClassification(CONFIDENT_WSR);
    await expect(ingestion.ingestDocument({
      title: 'x', content_text: 'y', received_at: 'not-a-date',
    }, 'a')).rejects.toThrow('valid ISO-8601');
    await expect(ingestion.ingestDocument({
      title: 'x', content_text: 'y', received_at: iso(+3),
    }, 'a')).rejects.toThrow('cannot be in the future');

    const { data: docs } = await supabase.from('claim_documents').select('*');
    expect(docs).toHaveLength(0); // nothing was written
  });

  it('triage latency never extends the statutory clock: filing from triage anchors to original receipt', async () => {
    mockClassification({
      category: 'medical', confidence: 30, claim_number: null,
      summary: 'Illegible.', key_fields: { signals: [] },
    });
    const ingest = await ingestion.ingestDocument({
      title: 'Old fax', content_text: 'blurry', source: 'fax', received_at: iso(-5),
    }, 'a');
    expect(ingest.routed).toBe('triage');

    const resolved = await ingestion.resolveTriage(ingest.document.id, {
      action: 'file', claim_id: CLAIM, category: 'work_status',
    }, 'adj@test');
    // 3 days from a receipt 5 days ago: due 2 days AGO — overdue and visible.
    expect(resolved.diary.due_date).toBe(day(iso(-2)));
  });
});

describe('explicit claim validation', () => {
  it('an explicit claim_id that matches no claim fails before anything is written', async () => {
    mockClassification(CONFIDENT_WSR);
    await expect(ingestion.ingestDocument({
      title: 'x', content_text: 'y', claim_id: 'claim_ghost',
    }, 'a')).rejects.toThrow('does not match a known claim');

    expect(mockMessagesCreate).not.toHaveBeenCalled(); // fails before the model call
    const { data: docs } = await supabase.from('claim_documents').select('*');
    expect(docs).toHaveLength(0);
  });
});

describe('partial-failure compensation', () => {
  it('a diary insert failure removes the orphan document and surfaces the error', async () => {
    mockClassification(CONFIDENT_WSR);

    // Inject a one-shot diaries failure under the real query path.
    const realFrom = supabase.from.bind(supabase);
    let failNext = true;
    const spy = jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'diaries' && failNext) {
        failNext = false;
        return { insert: () => Promise.resolve({ data: null, error: { message: 'injected diaries outage' } }) };
      }
      return realFrom(table);
    });

    try {
      await expect(ingestion.ingestDocument({
        title: 'WSR', content_text: 'work status …', source: 'upload',
      }, 'a')).rejects.toThrow(/rolled back.*injected diaries outage/);

      const { data: docs } = await supabase.from('claim_documents').select('*');
      expect(docs).toHaveLength(0); // no silently-filed orphan
      const { data: diaries } = await supabase.from('diaries').select('*');
      expect(diaries).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('an event insert failure compensates both the diary and the document', async () => {
    mockClassification(CONFIDENT_WSR);

    const realFrom = supabase.from.bind(supabase);
    let failNext = true;
    const spy = jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'claim_events' && failNext) {
        failNext = false;
        return { insert: () => Promise.resolve({ data: null, error: { message: 'injected events outage' } }) };
      }
      return realFrom(table);
    });

    try {
      await expect(ingestion.ingestDocument({
        title: 'WSR', content_text: 'work status …', source: 'upload',
      }, 'a')).rejects.toThrow(/rolled back/);

      const { data: docs } = await supabase.from('claim_documents').select('*');
      expect(docs).toHaveLength(0);
      const { data: diaries } = await supabase.from('diaries').select('*');
      expect(diaries).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('atomic triage resolution', () => {
  async function triagedDoc() {
    mockClassification({
      category: 'medical', confidence: 25, claim_number: null,
      summary: 'Unreadable.', key_fields: { signals: [] },
    });
    const r = await ingestion.ingestDocument({ title: 'Fax', content_text: 'x', source: 'fax' }, 'a');
    return r.document;
  }

  it('two concurrent resolutions: exactly one wins', async () => {
    const doc = await triagedDoc();

    const results = await Promise.allSettled([
      ingestion.resolveTriage(doc.id, { action: 'file', claim_id: CLAIM, category: 'work_status' }, 'adj-a@test'),
      ingestion.resolveTriage(doc.id, { action: 'reject', reason: 'duplicate' }, 'adj-b@test'),
    ]);

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);

    // Exactly one terminal state, and at most one diary.
    const { data: after } = await supabase.from('claim_documents').select('*').eq('id', doc.id).single();
    expect(['filed', 'rejected']).toContain(after.status);
    expect(after.triage_status).toBe('resolved');
    const { data: diaries } = await supabase.from('diaries').select('*');
    expect(diaries.length).toBeLessThanOrEqual(1);
  });

  it('a failure inside filing reverts the document to pending triage', async () => {
    const doc = await triagedDoc();

    const realFrom = supabase.from.bind(supabase);
    let failNext = true;
    const spy = jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'diaries' && failNext) {
        failNext = false;
        return { insert: () => Promise.resolve({ data: null, error: { message: 'injected' } }) };
      }
      return realFrom(table);
    });

    try {
      await expect(ingestion.resolveTriage(doc.id, {
        action: 'file', claim_id: CLAIM, category: 'work_status',
      }, 'a')).rejects.toThrow('injected');

      const { data: after } = await supabase.from('claim_documents').select('*').eq('id', doc.id).single();
      expect(after.triage_status).toBe('pending'); // not stranded in 'resolving'
      expect(after.status).toBe('triage');

      // And it can be resolved normally afterwards.
      const retry = await ingestion.resolveTriage(doc.id, {
        action: 'file', claim_id: CLAIM, category: 'work_status',
      }, 'a');
      expect(retry.document.status).toBe('filed');
      expect(retry.diary.diary_type).toBe('TD_PAYMENT_REVIEW');
    } finally {
      spy.mockRestore();
    }
  });
});
