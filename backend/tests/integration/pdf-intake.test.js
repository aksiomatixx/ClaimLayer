'use strict';

/**
 * PDF Intake (Tier 1.5 #1) — real document files enter the pipeline.
 *
 * - text-layer PDFs extract locally and classify through the text path
 * - scanned/image PDFs (no usable text layer) fall back to classifying
 *   the document itself as a Claude document block
 * - both paths share the guardrails, triage routing, receipt-anchored
 *   deadlines, and required audit logging
 * - the original PDF is stored and served back byte-identical
 * - the email-in webhook ingests PDF attachments with token auth
 *   (fail-closed in production) and Message-ID idempotency
 */

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
process.env.EMAIL_INBOUND_TOKEN = 'email-test-token';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({ messages: { create: mockMessagesCreate } }))
);

const request = require('supertest');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const app = require('../../src/index');
const { generateAdminToken } = require('../../src/middleware/auth');
const { supabase } = require('../../src/services/supabase');
const ingestion = require('../../src/services/documentIngestionService');

const ADMIN = `Bearer ${generateAdminToken({ sub: 'adm', email: 'adjuster@test' })}`;
const CLAIM = 'claim_pdf_intake';

function scriptClassifier(body) {
  mockMessagesCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify(body) }],
    usage: { input_tokens: 700, output_tokens: 220 },
  });
}

const WSR_CLASSIFICATION = {
  category: 'work_status', confidence: 91, claim_number: 'HHW-2026-PDF',
  summary: 'Off-work order extended 14 days.',
  key_fields: { report_date: '2026-06-01', work_status: 'off_work', restrictions: null, signals: [] },
};

async function textPdf(lines) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let y = 720;
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 11, font });
    y -= 18;
  }
  return Buffer.from(await pdf.save());
}

async function scannedPdf() {
  // A page with no text layer at all — the shape of a scanned fax.
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  return Buffer.from(await pdf.save());
}

const WSR_LINES = [
  'WORK STATUS REPORT',
  'Claim: HHW-2026-PDF   Patient: Pia Dee-Eff',
  'The patient remains off work for 14 days from 06/01/2026.',
  'Restrictions on return: no lifting over 10 pounds, no prolonged standing.',
  'Treating physician: R. Chen, M.D.  NPI 1234567890.',
];

beforeEach(async () => {
  mockMessagesCreate.mockReset();
  supabase._resetStore();
  await supabase.from('claims').insert({
    id: CLAIM, claim_number: 'HHW-2026-PDF', status: 'active_medical',
    date_of_injury: '2026-04-01', employer_id: 'emp-1', wcis_enabled: false,
    employee: { firstName: 'Pia', lastName: 'Dee-Eff' },
  });
});

describe('text-layer path', () => {
  it('extracts the text locally and classifies through the text path', async () => {
    scriptClassifier(WSR_CLASSIFICATION);
    const buf = await textPdf(WSR_LINES);

    const res = await request(app)
      .post('/api/v1/documents/ingest-file')
      .set('Authorization', ADMIN)
      .attach('file', buf, { filename: 'wsr.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.routed).toBe('filed');
    expect(res.body.document.claim_id).toBe(CLAIM); // matched via extracted claim number
    expect(res.body.document.extraction_method).toBe('text_layer');
    expect(res.body.document.content_text).toContain('no lifting over 10 pounds');
    expect(res.body.document.pages).toBe(1);
    expect(res.body.diary.diary_type).toBe('TD_PAYMENT_REVIEW');

    // The classifier received TEXT (a plain string), not a document block.
    const params = mockMessagesCreate.mock.calls[0][0];
    expect(typeof params.messages[0].content).toBe('string');
    expect(params.messages[0].content).toContain('WORK STATUS REPORT');

    // Required audit row records the text mode.
    const { data: audits } = await supabase.from('ai_decisions').select('*');
    expect(audits).toHaveLength(1);
    expect(audits[0].input_snapshot.mode).toBe('text');
  });

  it('stores the original PDF and serves it back byte-identical', async () => {
    scriptClassifier(WSR_CLASSIFICATION);
    const buf = await textPdf(WSR_LINES);

    const ingest = await request(app)
      .post(`/api/v1/claims/${CLAIM}/documents/ingest-file`)
      .set('Authorization', ADMIN)
      .attach('file', buf, { filename: 'wsr.pdf', contentType: 'application/pdf' });
    expect(ingest.status).toBe(201);

    const file = await request(app)
      .get(`/api/v1/claims/${CLAIM}/documents/${ingest.body.document.id}/file`)
      .set('Authorization', ADMIN);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(Buffer.compare(file.body, buf)).toBe(0); // the ORIGINAL, not a rendition
  });
});

describe('scanned-document fallback', () => {
  it('a PDF without a text layer is classified via a Claude document block', async () => {
    scriptClassifier(WSR_CLASSIFICATION);
    const buf = await scannedPdf();

    const res = await request(app)
      .post('/api/v1/documents/ingest-file')
      .set('Authorization', ADMIN)
      .attach('file', buf, { filename: 'scan.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.routed).toBe('filed');
    expect(res.body.document.extraction_method).toBe('document_vision');

    // The classifier received the PDF itself as a document content block.
    const params = mockMessagesCreate.mock.calls[0][0];
    expect(Array.isArray(params.messages[0].content)).toBe(true);
    const docBlock = params.messages[0].content.find(b => b.type === 'document');
    expect(docBlock).toBeTruthy();
    expect(docBlock.source.media_type).toBe('application/pdf');
    expect(docBlock.source.data).toBe(buf.toString('base64'));

    const { data: audits } = await supabase.from('ai_decisions').select('*');
    expect(audits[0].input_snapshot.mode).toBe('pdf_document_block');
  });

  it('guardrails are identical on the fallback path: low confidence routes to triage', async () => {
    scriptClassifier({ ...WSR_CLASSIFICATION, confidence: 35, claim_number: null });
    const res = await request(app)
      .post('/api/v1/documents/ingest-file')
      .set('Authorization', ADMIN)
      .attach('file', await scannedPdf(), { filename: 'blurry.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.routed).toBe('triage');
    expect(res.body.diary).toBeNull();
  });
});

describe('validation', () => {
  it('rejects files without a PDF header', async () => {
    const res = await request(app)
      .post('/api/v1/documents/ingest-file')
      .set('Authorization', ADMIN)
      .attach('file', Buffer.from('plain text pretending'), { filename: 'fake.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('%PDF');
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it('requires the file part', async () => {
    const res = await request(app)
      .post('/api/v1/documents/ingest-file')
      .set('Authorization', ADMIN)
      .field('title', 'no file attached');
    expect(res.status).toBe(400);
  });

  it('anchors deadlines to a provided channel receipt time', async () => {
    scriptClassifier(WSR_CLASSIFICATION);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const res = await request(app)
      .post('/api/v1/documents/ingest-file')
      .set('Authorization', ADMIN)
      .field('received_at', threeDaysAgo)
      .attach('file', await textPdf(WSR_LINES), { filename: 'wsr.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    // work_status due 3 calendar days from RECEIPT → due today.
    expect(res.body.diary.due_date).toBe(new Date().toISOString().split('T')[0]);
  });

  it('is admin-only', async () => {
    const { generateMagicToken } = require('../../src/middleware/auth');
    const emp = `Bearer ${generateMagicToken({ sub: 'e', claimId: CLAIM })}`;
    const res = await request(app)
      .post('/api/v1/documents/ingest-file')
      .set('Authorization', emp)
      .attach('file', await scannedPdf(), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(403);
  });
});

describe('email-in channel (/webhooks/email/inbound)', () => {
  function postEmail({ token = 'email-test-token', messageId = `mid_${Math.random().toString(36).slice(2)}@clinic.example`, attachments = [] } = {}) {
    let req = request(app)
      .post(`/webhooks/email/inbound${token != null ? `?token=${token}` : ''}`)
      .field('from', 'records@clinic.example')
      .field('subject', 'Work status report — HHW-2026-PDF')
      .field('headers', `Message-Id: <${messageId}>\nDate: Mon, 8 Jun 2026 10:00:00 -0700`);
    for (const a of attachments) {
      req = req.attach('attachment1', a.buffer, { filename: a.filename, contentType: a.contentType || 'application/pdf' });
    }
    return req;
  }

  it('rejects a wrong token', async () => {
    const res = await postEmail({ token: 'wrong', attachments: [] });
    expect(res.status).toBe(401);
  });

  it('fails closed in production when no token is configured', async () => {
    const config = require('../../src/config');
    const saved = config.webhooks.emailInboundToken;
    config.webhooks.emailInboundToken = undefined;
    process.env.NODE_ENV = 'production';
    try {
      const res = await postEmail({ token: null });
      expect(res.status).toBe(401);
    } finally {
      config.webhooks.emailInboundToken = saved;
      process.env.NODE_ENV = 'test';
    }
  });

  it('ingests PDF attachments through the standard pipeline with the email envelope recorded', async () => {
    scriptClassifier(WSR_CLASSIFICATION);
    const buf = await textPdf(WSR_LINES);

    const res = await postEmail({ attachments: [{ buffer: buf, filename: 'wsr.pdf' }] });
    expect(res.status).toBe(200);
    expect(res.body.outcomes).toHaveLength(1);
    expect(res.body.outcomes[0].routed).toBe('filed');

    const { data: docs } = await supabase.from('claim_documents').select('*');
    expect(docs).toHaveLength(1);
    expect(docs[0].source).toBe('email');
    expect(docs[0].claim_id).toBe(CLAIM);
    expect(docs[0].channel_metadata.from).toBe('records@clinic.example');
    expect(docs[0].channel_metadata.subject).toContain('Work status report');
  });

  it('vendor redeliveries of the same Message-ID are acknowledged without re-ingesting', async () => {
    scriptClassifier(WSR_CLASSIFICATION);
    const buf = await textPdf(WSR_LINES);
    const messageId = 'mid_dup_1@clinic.example';

    const first = await postEmail({ messageId, attachments: [{ buffer: buf, filename: 'wsr.pdf' }] });
    expect(first.body.outcomes).toHaveLength(1);

    const again = await postEmail({ messageId, attachments: [{ buffer: buf, filename: 'wsr.pdf' }] });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);

    const { data: docs } = await supabase.from('claim_documents').select('*');
    expect(docs).toHaveLength(1);
  });

  it('non-PDF attachments are skipped, not silently filed', async () => {
    scriptClassifier(WSR_CLASSIFICATION);
    const res = await postEmail({
      attachments: [
        { buffer: Buffer.from('GIF89a not a pdf'), filename: 'logo.gif', contentType: 'image/gif' },
        { buffer: await textPdf(WSR_LINES), filename: 'wsr.pdf' },
      ],
    });
    expect(res.status).toBe(200);
    const skipped = res.body.outcomes.find(o => o.filename === 'logo.gif');
    expect(skipped.skipped).toBe('not_a_pdf');
    const filed = res.body.outcomes.find(o => o.filename === 'wsr.pdf');
    expect(filed.routed).toBe('filed');
  });
});

describe('extractPdfText', () => {
  it('returns the text layer with the page count', async () => {
    const { text, pages } = await ingestion.extractPdfText(await textPdf(['Hello extraction world']));
    expect(pages).toBe(1);
    expect(text).toContain('Hello extraction world');
  });

  it('returns empty text (not an error) for unreadable input', async () => {
    const { text } = await ingestion.extractPdfText(Buffer.from('%PDF-1.4 garbage'));
    expect(text).toBe('');
  });
});
