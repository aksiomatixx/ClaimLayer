'use strict';

/**
 * Codex review hardening sweep — regression coverage.
 *
 *   A1  supervisor-alert ack is compensated when the audit insert fails
 *   A3  supervisor scope queries paginate past the PostgREST page cap
 *   A4  acknowledgement is recipient-bound (404 for another supervisor)
 *   B5  reserve approval is version-bound (stale rollup → 409, no writes)
 *   B6  worksheet operands quantize to DB precision before arithmetic
 *   C7  compensability delay is rejected past the 14-day deadline
 *   D9  unauthenticated email multipart is rejected before ingestion
 *   D10 a message completes only after its attachments succeed (retry-safe)
 *   D11 document list responses exclude pdf_buffer_b64
 *   E12 Lob events are marked processed only after updates apply
 *   E13 mail submission is idempotent across a crash/retry
 *   E14 outbox replays carry the stable idempotency key
 *   E15 a failed triage finalize compensates its event/audit rows
 *   H20 legacy claim ids stay bounded for long external ids
 *   H21 migrated claim numbers survive suffix collisions
 *   H22 legacy migration counts insert failures truthfully
 *   J27 concurrent claim-link creation converges on one row
 *   K28 TRUST_PROXY configures Express before the rate limiters
 */

process.env.TRUST_PROXY = '2'; // K28 — must be set before the app loads

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

jest.mock('../../src/services/filehandler', () => ({
  setReserves:    jest.fn().mockResolvedValue({ status: 'ok' }),
  createClaim:    jest.fn().mockResolvedValue({ claimId: 'fh_mock', status: 'created' }),
  createDiary:    jest.fn().mockResolvedValue({ diaryId: 'diy_mock', status: 'created' }),
  completeDiary:  jest.fn().mockResolvedValue({ status: 'completed' }),
  addNote:        jest.fn().mockResolvedValue({ noteId: 'note_mock' }),
  attachDocument: jest.fn().mockResolvedValue({ documentId: 'doc_mock' }),
  getLedger:      jest.fn().mockResolvedValue({ entries: [] }),
  recordPayment:  jest.fn().mockResolvedValue({ paymentId: 'pay_mock' }),
}));

jest.mock('../../src/services/legacy/adapterRegistry', () => {
  const drafts = { current: [] };
  return {
    SYSTEMS: ['mock_legacy'],
    getAdapter: () => ({ system: 'mock_legacy', ingestClaims: async () => drafts.current }),
    _setDrafts: (d) => { drafts.current = d; },
  };
});

const request = require('supertest');
const app     = require('../../src/index');
const { supabase } = require('../../src/services/supabase');
const { generateAdminToken, generateSupervisorToken } = require('../../src/middleware/auth');

const ADMIN = `Bearer ${generateAdminToken({ sub: 'adm', email: 'admin@test' })}`;

beforeEach(() => {
  supabase._resetStore();
  jest.restoreAllMocks();
});

afterAll(() => { delete process.env.TRUST_PROXY; }); // keep the env clean for --runInBand siblings

async function seedClaim(id, extra = {}) {
  await supabase.from('claims').insert({
    id, claim_number: `HHW-SWEEP-${id.slice(-2)}`, status: 'active_medical',
    date_of_injury: '2026-04-01', employer_id: 'emp-1', td_rate: 500,
    filehandler_id: `fh_${id}`,
    employee: { firstName: 'Sweep', lastName: 'Test' },
    ...extra,
  });
}

// ── A3 — pagination past the PostgREST cap ───────────────────────────────────

describe('A3 — supervisor scope queries paginate', () => {
  const svc = require('../../src/services/supervisorAlertService');
  afterEach(() => svc._setPageSizeForTests(null));

  it('retrieves every overdue diary across multiple pages', async () => {
    await seedClaim('claim_swp_a');
    for (let i = 0; i < 7; i++) {
      await supabase.from('diaries').insert({
        id: `d_page_${i}`, claim_id: 'claim_swp_a', diary_type: 'PR2_FOLLOW_UP',
        due_date: '2026-06-01', priority: 'LOW', status: 'open', assigned_to: 'a@test',
      });
    }
    svc._setPageSizeForTests(3); // 7 rows → pages of 3, 3, 1
    const od = await svc.overdue('2026-06-10');
    expect(od).toHaveLength(7);
    expect(new Set(od.map(d => d.id)).size).toBe(7);
  });

  it('retrieves every due-today important diary across multiple pages', async () => {
    await seedClaim('claim_swp_a');
    for (let i = 0; i < 5; i++) {
      await supabase.from('diaries').insert({
        id: `d_due_${i}`, claim_id: 'claim_swp_a', diary_type: 'TD_PAYMENT_REVIEW',
        due_date: '2026-06-10', priority: i % 2 ? 'CRITICAL' : 'MEDIUM',
        no_snooze: i % 2 === 0, status: 'open', assigned_to: 'a@test',
      });
    }
    // A MEDIUM diary without no_snooze must still be excluded server-side.
    await supabase.from('diaries').insert({
      id: 'd_due_excluded', claim_id: 'claim_swp_a', diary_type: 'PR2_FOLLOW_UP',
      due_date: '2026-06-10', priority: 'MEDIUM', no_snooze: false, status: 'open', assigned_to: 'a@test',
    });
    svc._setPageSizeForTests(2);
    const due = await svc.dueTodayImportant('2026-06-10');
    expect(due.map(d => d.id).sort()).toEqual(['d_due_0', 'd_due_1', 'd_due_2', 'd_due_3', 'd_due_4']);
  });
});

// ── A4 + A1 — recipient-bound, audit-compensated acknowledgement ─────────────

describe('A4/A1 — supervisor acknowledgement', () => {
  const svc = require('../../src/services/supervisorAlertService');

  async function seedAlertFor(recipient) {
    await supabase.from('users').insert({ id: `u_${recipient}`, email: recipient, role: 'supervisor' });
    await seedClaim('claim_swp_b');
    await supabase.from('diaries').insert({
      id: 'd_ack', claim_id: 'claim_swp_b', diary_type: 'PR2_FOLLOW_UP',
      due_date: '2020-01-01', priority: 'LOW', status: 'open', assigned_to: 'a@test',
    });
    const { alerts } = await svc.generate('2026-06-10');
    return alerts.find(a => a.recipient_user_id === recipient);
  }

  it('another supervisor with the alert id gets 404, the recipient succeeds', async () => {
    const alert = await seedAlertFor('owner@test');
    await supabase.from('users').insert({ id: 'u_other', email: 'other@test', role: 'supervisor' });

    const OTHER = `Bearer ${generateSupervisorToken({ sub: 'o', email: 'other@test' })}`;
    const OWNER = `Bearer ${generateSupervisorToken({ sub: 'w', email: 'owner@test' })}`;

    const denied = await request(app)
      .post(`/api/v1/supervisor/alerts/${alert.id}/acknowledge`).set('Authorization', OTHER);
    expect(denied.status).toBe(404); // no existence leak

    const { data: afterDenied } = await supabase.from('supervisor_alerts').select('*').eq('id', alert.id);
    expect(afterDenied[0].acknowledged_at).toBeNull();

    const ok = await request(app)
      .post(`/api/v1/supervisor/alerts/${alert.id}/acknowledge`).set('Authorization', OWNER);
    expect(ok.status).toBe(200);
    expect(ok.body.alert.acknowledged_by).toBe('owner@test');
  });

  it('a failed audit insert reverts the acknowledgement (never acked without a trail)', async () => {
    const alert = await seedAlertFor('owner@test');

    const realFrom = supabase.from.bind(supabase);
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'audit_log') {
        return { insert: () => Promise.resolve({ error: { message: 'injected audit failure' } }) };
      }
      return realFrom(table);
    });

    await expect(svc.acknowledge(alert.id, 'owner@test'))
      .rejects.toThrow(/audit failed/);

    jest.restoreAllMocks();
    const { data: rows } = await supabase.from('supervisor_alerts').select('*').eq('id', alert.id);
    expect(rows[0].acknowledged_at).toBeNull(); // compensated
    expect(rows[0].acknowledged_by).toBeNull();
  });
});

// ── B5/B6 — reserve worksheet hardening ──────────────────────────────────────

describe('B5/B6 — reserve worksheets', () => {
  const worksheet = require('../../src/services/reserveWorksheetService');
  const filehandler = require('../../src/services/filehandler');

  it('B6: operands quantize to 2 decimals BEFORE multiplication (1.004 × $100 → $100.00)', async () => {
    await seedClaim('claim_swp_c');
    const item = await worksheet.addLineItem('claim_swp_c', {
      category: 'medical', label: 'PTP visits', shape: 'quantity',
      quantity: 1.004, unit_amount: 100,
    }, 'adm@test');
    expect(item.quantity).toBe(1);          // what NUMERIC(10,2) stores
    expect(item.total).toBe(100);           // formula and total agree
  });

  it('B6: unit amounts quantize too, and the stored formula reproduces the total', async () => {
    await seedClaim('claim_swp_c');
    const item = await worksheet.addLineItem('claim_swp_c', {
      category: 'expense', label: 'Investigation', shape: 'quantity',
      quantity: 5, unit_amount: 250.555,
    }, 'adm@test');
    expect(item.unit_amount).toBe(250.56);
    expect(item.total).toBe(Math.round(item.quantity * item.unit_amount * 100) / 100);
  });

  it('B5: a stale approval is rejected with 409 and writes nothing', async () => {
    await seedClaim('claim_swp_d');
    await worksheet.addLineItem('claim_swp_d', {
      category: 'medical', label: 'Initial', shape: 'flat', flat_amount: 1000,
    }, 'adm@test');

    const reviewed = (await worksheet.getWorksheet('claim_swp_d')).subtotals;

    // Another admin edits the worksheet after it was reviewed.
    await worksheet.addLineItem('claim_swp_d', {
      category: 'medical', label: 'Surgery authorization', shape: 'flat', flat_amount: 25000,
    }, 'other-admin@test');

    const res = await request(app)
      .post('/api/v1/claims/claim_swp_d/reserve-worksheet/approve')
      .set('Authorization', ADMIN)
      .send({ expected: reviewed });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/WORKSHEET_CHANGED/);
    expect(filehandler.setReserves).not.toHaveBeenCalled();
    const { data: reserves } = await supabase.from('reserves').select('*').eq('claim_id', 'claim_swp_d');
    expect(reserves).toHaveLength(0); // nothing written

    // Approving the CURRENT totals succeeds with server-computed numbers.
    const fresh = (await worksheet.getWorksheet('claim_swp_d')).subtotals;
    const ok = await request(app)
      .post('/api/v1/claims/claim_swp_d/reserve-worksheet/approve')
      .set('Authorization', ADMIN)
      .send({ expected: fresh });
    expect(ok.status).toBe(200);
    expect(ok.body.approved.medical).toBe(26000);
    expect(filehandler.setReserves).toHaveBeenCalledTimes(1);
    const { data: after } = await supabase.from('reserves').select('*').eq('claim_id', 'claim_swp_d');
    expect(after).toHaveLength(1);
    expect(Number(after[0].medical)).toBe(26000);
  });
});

// ── C7 — delay gated by the 14-day statutory deadline ────────────────────────

describe('C7 — compensability delay window', () => {
  const diaryActions = require('../../src/services/diaryActionService');
  const iso = (offsetDays) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return d.toISOString().split('T')[0];
  };

  async function seedNoticeDiary(deadline) {
    await seedClaim('claim_swp_e', { filed_at: '2026-05-01T00:00:00Z' });
    await supabase.from('diaries').insert({
      id: 'd_comp', claim_id: 'claim_swp_e', diary_type: 'COMPENSABILITY_NOTICE_DUE',
      due_date: deadline, statutory_deadline: deadline, no_snooze: true,
      priority: 'CRITICAL', status: 'open', assigned_to: 'a@test',
    });
  }

  it('on the deadline day (day 14) delay is still offered', async () => {
    await seedNoticeDiary(iso(0));
    const preview = await diaryActions.previewAftermath('d_comp');
    expect(preview.actions.map(a => a.action).sort()).toEqual(['accept', 'delay', 'deny']);
    expect(preview.window_closed).toBeUndefined();
  });

  it('past the deadline (day 15+) delay is neither previewed nor accepted', async () => {
    await seedNoticeDiary(iso(-1));
    const preview = await diaryActions.previewAftermath('d_comp');
    expect(preview.actions.map(a => a.action).sort()).toEqual(['accept', 'deny']);
    expect(preview.window_closed).toEqual([
      { action: 'delay', reason: expect.stringMatching(/statutory deadline has passed/) },
    ]);

    await expect(diaryActions.completeAction('d_comp', { action: 'delay', note: 'too late' }, 'adm@test'))
      .rejects.toThrow(/no longer available .* Valid: accept, deny/s);

    // The rejection happened before the diary was claimed.
    const { data: rows } = await supabase.from('diaries').select('*').eq('id', 'd_comp');
    expect(rows[0].status).toBe('open');
  });
});

// ── D9/D10 — email inbound webhook ───────────────────────────────────────────

describe('D9/D10 — email inbound webhook', () => {
  const ingestion = require('../../src/services/documentIngestionService');
  const config = require('../../src/config');
  let savedToken;

  beforeEach(() => { savedToken = config.webhooks.emailInboundToken; config.webhooks.emailInboundToken = 'sweep-token'; });
  afterEach(() => { config.webhooks.emailInboundToken = savedToken; });

  const PDF = Buffer.from('%PDF-1.4 sweep test pdf body');

  function postEmail({ token = 'sweep-token', messageId = 'mid_sweep@x', files = [] } = {}) {
    let req = request(app)
      .post(`/webhooks/email/inbound${token != null ? `?token=${token}` : ''}`)
      .field('from', 'records@clinic.example')
      .field('subject', 'sweep')
      .field('headers', `Message-Id: <${messageId}>`);
    for (const f of files) req = req.attach('attachment1', f.buffer, { filename: f.name, contentType: 'application/pdf' });
    return req;
  }

  it('D9: an unauthenticated multipart post is rejected before any ingestion', async () => {
    const spy = jest.spyOn(ingestion, 'ingestPdf');
    const res = await postEmail({ token: 'wrong', files: [{ buffer: PDF, name: 'a.pdf' }] });
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    const { data: events } = await supabase.from('webhook_events').select('*');
    expect(events).toHaveLength(0); // nothing recorded for the rejected request
  });

  it('D10: the message completes only after every attachment succeeds; retries skip prior successes', async () => {
    const spy = jest.spyOn(ingestion, 'ingestPdf')
      .mockImplementation(async ({ filename }) => {
        if (filename === 'bad.pdf' && spy.mock.calls.length <= 2) {
          throw new Error('classifier timeout'); // transient on the first delivery
        }
        return { routed: 'filed', document: { id: `doc_${filename}` } };
      });

    // First delivery: good.pdf ingests, bad.pdf fails transiently → 5xx (vendor will retry).
    const first = await postEmail({ messageId: 'mid_partial@x', files: [
      { buffer: PDF, name: 'good.pdf' }, { buffer: PDF, name: 'bad.pdf' },
    ] });
    expect(first.status).toBe(500);
    expect(first.body.retryable).toBe(true);

    const { data: afterFirst } = await supabase.from('webhook_events').select('*');
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].processed_at).toBeFalsy(); // NOT complete
    expect(afterFirst[0].payload.outcomes_by_file['good.pdf'].done).toBe(true);

    // Vendor retry: only bad.pdf is reprocessed; the message completes.
    const callsBefore = spy.mock.calls.length;
    const retry = await postEmail({ messageId: 'mid_partial@x', files: [
      { buffer: PDF, name: 'good.pdf' }, { buffer: PDF, name: 'bad.pdf' },
    ] });
    expect(retry.status).toBe(200);
    expect(spy.mock.calls.length - callsBefore).toBe(1); // good.pdf NOT re-ingested
    expect(spy.mock.calls[spy.mock.calls.length - 1][0].filename).toBe('bad.pdf');

    const { data: afterRetry } = await supabase.from('webhook_events').select('*');
    expect(afterRetry[0].processed_at).toBeTruthy(); // complete only now

    // A third delivery is a pure duplicate.
    const dup = await postEmail({ messageId: 'mid_partial@x', files: [{ buffer: PDF, name: 'good.pdf' }] });
    expect(dup.body.duplicate).toBe(true);
    expect(spy.mock.calls.length - callsBefore).toBe(1); // nothing more ingested
  });
});

// ── D11 — document list responses carry metadata only ────────────────────────

describe('D11 — document list excludes raw file data', () => {
  it('GET /claims/:id/documents never returns pdf_buffer_b64', async () => {
    await seedClaim('claim_swp_f');
    await supabase.from('claim_documents').insert({
      id: 'doc_swp_1', claim_id: 'claim_swp_f', title: 'PR-2', category: 'medical_report',
      status: 'filed', triage_status: null, received_at: new Date().toISOString(),
      pdf_buffer_b64: Buffer.from('%PDF-1.4 big file').toString('base64'),
    });

    const res = await request(app)
      .get('/api/v1/claims/claim_swp_f/documents').set('Authorization', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.documents[0]).not.toHaveProperty('pdf_buffer_b64');
    expect(res.body.documents[0].has_file).toBe(true); // download route still serves it
  });
});

// ── E12 — Lob events processed only after application ────────────────────────

describe('E12 — Lob webhook processing state', () => {
  const delivery = require('../../src/services/noticeDeliveryService');

  it('a failed application stays retryable; the retry applies and only then dedupes', async () => {
    await seedClaim('claim_swp_g');
    // Channel exists, but its notice row is missing → application fails.
    await supabase.from('benefit_notice_channels').insert({
      id: 'bnc_swp_1', notice_id: 'ntc_swp_1', claim_id: 'claim_swp_g',
      channel: 'mail', status: 'submitted', provider_ref: 'ltr_swp_1', attempts: 1,
    });

    const event = { id: 'evt_swp_1', event_type: 'letter.delivered', body: { id: 'ltr_swp_1' } };
    await expect(delivery.recordLobEvent(event)).rejects.toThrow(/not found/);

    const { data: afterFail } = await supabase.from('webhook_events').select('*').eq('provider_event_id', 'evt_swp_1');
    expect(afterFail).toHaveLength(1);
    expect(afterFail[0].processed_at).toBeFalsy(); // retryable, not skipped

    // The notice lands (e.g. the submission record catches up); Lob retries.
    await supabase.from('benefit_notices').insert({
      id: 'ntc_swp_1', claim_id: 'claim_swp_g', notice_type: 'claim_accepted',
      audience: 'worker', status: 'submitted', delivery_attempts: 1,
    });
    const result = await delivery.recordLobEvent(event);
    expect(result.recorded).toBe(true);
    expect(result.notice_status).toBe('delivered');

    const { data: afterApply } = await supabase.from('webhook_events').select('*').eq('provider_event_id', 'evt_swp_1');
    expect(afterApply[0].processed_at).toBeTruthy();

    // Only NOW are further retries pure duplicates.
    expect(await delivery.recordLobEvent(event)).toEqual({ duplicate: true });
  });

  it('an event for a letter with no channel yet (early webhook) is left retryable', async () => {
    const event = { id: 'evt_swp_2', event_type: 'letter.delivered', body: { id: 'ltr_unknown' } };
    await expect(delivery.recordLobEvent(event)).rejects.toThrow(/left retryable/);
    const { data } = await supabase.from('webhook_events').select('*').eq('provider_event_id', 'evt_swp_2');
    expect(data[0].processed_at).toBeFalsy();
  });
});

// ── E13 — mail submission idempotency across crash/retry ─────────────────────

describe('E13 — Lob submission idempotency', () => {
  const lobService = require('../../src/services/lobService');
  const delivery = require('../../src/services/noticeDeliveryService');

  beforeEach(() => lobService._resetIdempotencyLedger());

  it('the same idempotency key always returns the same letter', async () => {
    const a = await lobService.sendLetter('benefit_notice', 'c1', 'worker', {}, { idempotencyKey: 'bnc_k1' });
    const b = await lobService.sendLetter('benefit_notice', 'c1', 'worker', {}, { idempotencyKey: 'bnc_k1' });
    expect(b.letterId).toBe(a.letterId);
    const c = await lobService.sendLetter('benefit_notice', 'c1', 'worker', {}, { idempotencyKey: 'bnc_k2' });
    expect(c.letterId).not.toBe(a.letterId);
  });

  it('a crash between provider accept and the local save cannot mail a second letter', async () => {
    await seedClaim('claim_swp_h');
    await supabase.from('benefit_notices').insert({
      id: 'ntc_swp_2', claim_id: 'claim_swp_h', notice_type: 'claim_accepted',
      audience: 'attorney', status: 'queued', delivery_attempts: 0,
    });

    const first = await delivery.deliverNotice('ntc_swp_2');
    expect(first.status).toBe('submitted');
    const { data: ch1 } = await supabase.from('benefit_notice_channels').select('*').eq('notice_id', 'ntc_swp_2');
    const originalRef = ch1[0].provider_ref;
    expect(originalRef).toBeTruthy();

    // Simulate the crash: the provider accepted, but the local
    // provider_ref write was lost and the stale-lock reclaim re-queued.
    await supabase.from('benefit_notice_channels')
      .update({ status: 'pending', provider_ref: null, submitted_at: null })
      .eq('id', ch1[0].id);
    await supabase.from('benefit_notices')
      .update({ status: 'queued', locked_by: null, locked_at: null })
      .eq('id', 'ntc_swp_2');

    const retry = await delivery.deliverNotice('ntc_swp_2');
    expect(retry.status).toBe('submitted');
    const { data: ch2 } = await supabase.from('benefit_notice_channels').select('*').eq('notice_id', 'ntc_swp_2');
    // Same channel id → same idempotency key → the ORIGINAL letter, not a duplicate.
    expect(ch2[0].provider_ref).toBe(originalRef);
  });
});

// ── E14 — outbox replays carry the stable key ────────────────────────────────

describe('E14 — outbox idempotency keys', () => {
  const outbox = require('../../src/services/outboxService');
  const filehandler = require('../../src/services/filehandler');

  it('dispatch and stale-retry both send the outbox row id as the idempotency key', async () => {
    await seedClaim('claim_swp_i');
    const [row] = await outbox.enqueue([{
      target: 'filehandler', operation: 'add_note', claim_id: 'claim_swp_i',
      payload: { fh_claim_id: 'fh_claim_swp_i', note_text: 'decision note', added_by: 'ADJUSTER' },
    }]);

    expect(await outbox.dispatchOne(row.id, 'w1')).toBe('succeeded');
    expect(filehandler.addNote).toHaveBeenLastCalledWith(
      'fh_claim_swp_i', 'decision note', 'ADJUSTER', 'diary', { idempotencyKey: row.id });

    // Stale replay (external call succeeded, local success-write lost):
    // the SAME key goes out, so the ledger can dedupe.
    await supabase.from('integration_outbox')
      .update({ status: 'pending', locked_by: null, locked_at: null })
      .eq('id', row.id);
    expect(await outbox.dispatchOne(row.id, 'w2')).toBe('succeeded');
    expect(filehandler.addNote).toHaveBeenLastCalledWith(
      'fh_claim_swp_i', 'decision note', 'ADJUSTER', 'diary', { idempotencyKey: row.id });
  });
});

// ── E15 — triage finalize failure compensates event/audit rows ───────────────

describe('E15 — triage finalize compensation', () => {
  const ingestion = require('../../src/services/documentIngestionService');

  it('a failed finalize removes the filed event and reverses the audit entry', async () => {
    await seedClaim('claim_swp_j');
    await supabase.from('claim_documents').insert({
      id: 'doc_swp_tri', claim_id: null, title: 'Faxed work status', category: 'work_status',
      status: 'triage', triage_status: 'pending', triage_reason: 'low_confidence',
      received_at: new Date().toISOString(), key_fields: { signals: [] },
    });

    // Inject a failure into the FINALIZE update (triage_status → resolved)
    // only; every other claim_documents operation runs for real.
    const realFrom = supabase.from.bind(supabase);
    let injected = false;
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      const b = realFrom(table);
      if (table === 'claim_documents' && !injected) {
        const realUpdate = b.update.bind(b);
        b.update = (patch) => {
          if (patch && patch.triage_status === 'resolved') {
            injected = true;
            const fail = {
              eq: () => fail, select: () => fail,
              single: async () => ({ data: null, error: { message: 'injected finalize failure' } }),
            };
            return fail;
          }
          return realUpdate(patch);
        };
      }
      return b;
    });

    await expect(ingestion.resolveTriage('doc_swp_tri',
      { action: 'file', claim_id: 'claim_swp_j', category: 'work_status' }, 'adm@test'))
      .rejects.toThrow(/injected finalize failure/);

    jest.restoreAllMocks();

    // Document reverted to pending triage…
    const { data: docs } = await supabase.from('claim_documents').select('*').eq('id', 'doc_swp_tri');
    expect(docs[0].triage_status).toBe('pending');
    expect(docs[0].status).toBe('triage');

    // …with no surviving record claiming it was filed.
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', 'claim_swp_j');
    expect(diaries).toHaveLength(0);
    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', 'claim_swp_j');
    expect(events.filter(e => e.type === 'document_ingested')).toHaveLength(0);

    const { data: audit } = await supabase.from('audit_log').select('*');
    const filed = audit.find(a => a.action === 'document_triage_filed' && a.resource_id === 'doc_swp_tri');
    const reverted = audit.find(a => a.action === 'document_triage_filed_reverted' && a.resource_id === 'doc_swp_tri');
    expect(filed).toBeTruthy();    // append-only trail keeps the attempt…
    expect(reverted).toBeTruthy(); // …and its reversal
  });
});

// ── H20/H21/H22 — legacy migration ───────────────────────────────────────────

describe('H20/H21/H22 — legacy migration hardening', () => {
  const migration = require('../../src/services/legacyMigrationService');
  const registry = require('../../src/services/legacy/adapterRegistry');

  const draft = (external_claim_id) => ({
    external_claim_id, status: 'open', date_of_injury: '2024-01-01',
    body_part: 'Back', injury_type: 'Strain', injury_description: 'Legacy strain',
    employer_name: 'Legacy Employer', employee: { firstName: 'L', lastName: 'C' },
  });

  it('H20: a long external id produces a bounded deterministic claim id', async () => {
    const longId = 'X'.repeat(80);
    registry._setDrafts([draft(longId)]);
    const first = await migration.migrateFromLegacy('mock_legacy');
    expect(first.migrated).toBe(1);
    expect(first.ids[0].length).toBeLessThanOrEqual(60);
    expect(first.ids[0]).toMatch(/^claim_legacy_h[0-9a-f]{32}$/);

    // Deterministic: the same external id maps to the same claim id.
    supabase._resetStore();
    registry._setDrafts([draft(longId)]);
    const second = await migration.migrateFromLegacy('mock_legacy');
    expect(second.ids[0]).toBe(first.ids[0]);
  });

  it('H21: two external ids sharing the last-6 suffix get distinct claim numbers', async () => {
    registry._setDrafts([draft('AAA-123456'), draft('BBB-123456')]);
    const result = await migration.migrateFromLegacy('mock_legacy');
    expect(result.migrated).toBe(2);
    const { data: claims } = await supabase.from('claims').select('*');
    const numbers = claims.map(c => c.claim_number);
    expect(new Set(numbers).size).toBe(2); // no collision
    expect(numbers).toContain('LEG-123456'); // first keeps the readable form
  });

  it('H22: a failed insert is counted as a failure, never as migrated', async () => {
    registry._setDrafts([draft('OK-1'), draft('BOOM-1')]);

    const realFrom = supabase.from.bind(supabase);
    jest.spyOn(supabase, 'from').mockImplementation((table) => {
      const b = realFrom(table);
      if (table === 'claims') {
        const realInsert = b.insert.bind(b);
        b.insert = (row) => {
          if (row && row.external_claim_id === 'BOOM-1') {
            return Promise.resolve({ data: null, error: { message: 'injected constraint violation' } });
          }
          return realInsert(row);
        };
      }
      return b;
    });

    const result = await migration.migrateFromLegacy('mock_legacy');
    jest.restoreAllMocks();

    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures[0]).toMatchObject({ external_claim_id: 'BOOM-1' });
    expect(result.ids).toHaveLength(1);
    const { data: claims } = await supabase.from('claims').select('*');
    expect(claims).toHaveLength(1); // only the real success persisted
  });
});

// ── J27 — concurrent claim-link creation ─────────────────────────────────────

describe('J27 — claim link concurrency', () => {
  const links = require('../../src/services/claimLinkService');

  it('two concurrent createLink calls converge on one row (unique-violation recovery)', async () => {
    await seedClaim('claim_swp_k');
    await seedClaim('claim_swp_l');

    const [a, b] = await Promise.all([
      links.createLink('claim_swp_k', 'claim_swp_l', {}, 'adm@test'),
      links.createLink('claim_swp_l', 'claim_swp_k', {}, 'adm@test'), // reversed pair, same link
    ]);
    expect(a.id).toBe(b.id);

    const { data: rows } = await supabase.from('claim_links').select('*');
    expect(rows).toHaveLength(1);
  });
});

// ── K28 — trust proxy configured before the limiters ─────────────────────────

describe('K28 — proxy-aware client IPs', () => {
  it('TRUST_PROXY configures Express (set before this app instance loaded)', () => {
    expect(app.get('trust proxy')).toBe(2);
  });
});
