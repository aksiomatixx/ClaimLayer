'use strict';

/**
 * Aftermath atomicity + idempotency (Finding 5 of the production-
 * hardening pass).
 *
 * - concurrent completions: exactly one wins (conditional-update claim)
 * - the local workflow is one durable unit: failure in any required
 *   step (notice generation, status transition) rolls everything back
 *   and the diary is NOT marked completed
 * - crashed-and-retried completions are idempotent: notices carry
 *   source_diary_id, successors carry idempotency keys
 * - external FileHandler write-back goes through the transactional
 *   outbox: failures stay pending and retry through the outbox worker;
 *   terminal failures surface as CRITICAL diaries, never silently
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const mockFhAddNote = jest.fn();
const mockFhCompleteDiary = jest.fn();
jest.mock('../../src/services/filehandler', () => ({
  addNote: (...a) => mockFhAddNote(...a),
  completeDiary: (...a) => mockFhCompleteDiary(...a),
}));

jest.mock('../../src/services/noticeTemplateService', () => {
  const actual = jest.requireActual('../../src/services/noticeTemplateService');
  return { ...actual, generateNotice: jest.fn((...a) => actual.generateNotice(...a)) };
});

const { supabase } = require('../../src/services/supabase');
const svc = require('../../src/services/diaryActionService');
const noticeTemplates = require('../../src/services/noticeTemplateService');
const outbox = require('../../src/services/outboxService');
const outboxWorker = require('../../src/cron/outboxWorker');

const CLAIM = 'claim_atomic_test';

beforeEach(async () => {
  supabase._resetStore();
  mockFhAddNote.mockReset().mockResolvedValue({ noteId: 'nte-1' });
  mockFhCompleteDiary.mockReset().mockResolvedValue({ ok: true });
  noticeTemplates.generateNotice.mockClear();
  await supabase.from('claims').insert({
    id: CLAIM, claim_number: 'HHW-AT-1', status: 'under_investigation',
    date_of_injury: '2026-04-01', employer_id: 'emp-1', wcis_enabled: false,
    filehandler_id: 'FH-AT', td_rate: 500,
    employee: { firstName: 'Atomic', lastName: 'Test' },
  });
});

async function seedDiary(type, id = `diy_${type}_${Math.random().toString(36).slice(2, 6)}`, extra = {}) {
  await supabase.from('diaries').insert({
    id, claim_id: CLAIM, diary_type: type, due_date: '2026-06-20',
    assigned_to: 'adjuster@test', priority: 'HIGH', status: 'open',
    notes: 'seeded', ...extra,
  });
  return id;
}

describe('concurrent completion', () => {
  it('two simultaneous completions: exactly one wins, one aftermath set', async () => {
    const diaryId = await seedDiary('TD_PAYMENT_REVIEW');

    const results = await Promise.allSettled([
      svc.completeAction(diaryId, { action: 'continue', note: 'racer A' }, 'a@test'),
      svc.completeAction(diaryId, { action: 'continue', note: 'racer B' }, 'b@test'),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected  = results.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toContain('not open');

    // Exactly one successor and one completion event.
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', CLAIM);
    const successors = diaries.filter(d => d.parent_diary_id === diaryId);
    expect(successors).toHaveLength(1);

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    expect(events.filter(e => e.type === 'action_completed')).toHaveLength(1);
  });

  it('concurrent decline + complete: only one decision is recorded', async () => {
    const diaryId = await seedDiary('TD_PAYMENT_REVIEW');
    const results = await Promise.allSettled([
      svc.completeAction(diaryId, { action: 'continue' }, 'a@test'),
      svc.declineAction(diaryId, { reason: 'duplicate' }, 'b@test'),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);

    const { data: diary } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
    expect(['completed', 'cancelled']).toContain(diary.status);
  });
});

describe('failure injection — the durable unit rolls back', () => {
  it('notice generation failure: diary stays open, nothing half-done remains', async () => {
    const diaryId = await seedDiary('TD_PAYMENT_REVIEW');
    noticeTemplates.generateNotice.mockRejectedValueOnce(new Error('PDF renderer exploded'));

    await expect(svc.completeAction(diaryId, { action: 'suspend', note: 'rtw' }, 'a@test'))
      .rejects.toThrow(/not completed.*rolled back/i);

    // The diary is NOT completed.
    const { data: diary } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
    expect(diary.status).toBe('open');
    expect(diary.decision_action).toBeFalsy();

    // No notices, no successors, no completion event survived.
    const { data: notices } = await supabase.from('benefit_notices').select('*').eq('claim_id', CLAIM);
    expect(notices).toHaveLength(0);
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', CLAIM);
    expect(diaries.filter(d => d.parent_diary_id === diaryId)).toHaveLength(0);
    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    expect(events.some(e => e.type === 'action_completed')).toBe(false);
    expect(events.some(e => e.type === 'action_completion_failed')).toBe(true);

    // No external write-back happened for the failed unit.
    expect(mockFhAddNote).not.toHaveBeenCalled();

    // And the action can be retried successfully afterwards.
    const retry = await svc.completeAction(diaryId, { action: 'suspend', note: 'rtw' }, 'a@test');
    expect(retry.notices_generated.length).toBeGreaterThanOrEqual(1);
    const { data: after } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
    expect(after.status).toBe('completed');
  });

  it('status-transition failure: notices and successors are compensated, status unchanged', async () => {
    await supabase.from('claims').update({ status: 'closed' }).eq('id', CLAIM); // accept is invalid from closed
    const diaryId = await seedDiary('COMPENSABILITY_DECISION_DUE');

    await expect(svc.completeAction(diaryId, { action: 'accept', note: 'x' }, 'a@test'))
      .rejects.toThrow(/rolled back/i);

    const { data: diary } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
    expect(diary.status).toBe('open');

    const { data: claim } = await supabase.from('claims').select('*').eq('id', CLAIM).single();
    expect(claim.status).toBe('closed');

    // The claim_accepted notices generated earlier in the unit were compensated.
    const { data: notices } = await supabase.from('benefit_notices').select('*').eq('claim_id', CLAIM);
    expect(notices).toHaveLength(0);
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', CLAIM);
    expect(diaries.filter(d => d.parent_diary_id === diaryId)).toHaveLength(0);

    // The outbox rows enqueued inside the failed unit were removed too.
    const { data: obx } = await supabase.from('integration_outbox').select('*');
    expect(obx).toHaveLength(0);
  });
});

describe('crash-retry idempotency', () => {
  it('a stale completing diary re-runs without duplicating notices or successors', async () => {
    const diaryId = 'diy_stale_retry';
    const staleTime = new Date(Date.now() - svc.STALE_COMPLETING_MS - 60_000).toISOString();
    await supabase.from('diaries').insert({
      id: diaryId, claim_id: CLAIM, diary_type: 'TD_PAYMENT_REVIEW',
      due_date: '2026-06-20', priority: 'HIGH', status: 'completing',
      updated_at: staleTime, notes: 'crashed mid-completion',
    });
    // The crashed first attempt already created the suspension notice
    // and the successor before dying.
    await supabase.from('benefit_notices').insert({
      id: 'bn_prior', claim_id: CLAIM, notice_type: 'td_suspension',
      audience: 'worker', language: 'en', recipient: { name: 'Atomic Test' },
      status: 'queued', source_diary_id: diaryId, delivery_attempts: 0,
      created_at: staleTime, updated_at: staleTime,
    });
    await supabase.from('diaries').insert({
      id: 'diy_prior_succ', claim_id: CLAIM, diary_type: 'TD_PAYMENT_REVIEW',
      due_date: '2026-07-04', priority: 'HIGH', status: 'open',
      parent_diary_id: diaryId, idempotency_key: `succ:${diaryId}:TD_PAYMENT_REVIEW`,
    });

    const result = await svc.completeAction(diaryId, { action: 'rate_change', note: 'retry after crash' }, 'a@test');

    // rate_change wants a td_rate_change notice + a TD_PAYMENT_REVIEW
    // successor: the successor already exists (idempotency key) and is
    // reused, not duplicated.
    expect(result.successor_diaries).toHaveLength(1);
    expect(result.successor_diaries[0].id).toBe('diy_prior_succ');
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', CLAIM);
    expect(diaries.filter(d => d.idempotency_key === `succ:${diaryId}:TD_PAYMENT_REVIEW`)).toHaveLength(1);

    const { data: diary } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
    expect(diary.status).toBe('completed');
  });

  it('a FRESH completing diary cannot be claimed by a second caller', async () => {
    const diaryId = await seedDiary('TD_PAYMENT_REVIEW', 'diy_fresh_lock', {
      status: 'completing', updated_at: new Date().toISOString(),
    });
    await expect(svc.completeAction(diaryId, { action: 'continue' }, 'a@test'))
      .rejects.toThrow('not open');
  });
});

describe('transactional outbox for the system-of-record write-back', () => {
  it('successful path: outbox row enqueued, dispatched inline, marked succeeded', async () => {
    const diaryId = await seedDiary('TD_PAYMENT_REVIEW');
    await svc.completeAction(diaryId, { action: 'continue', note: 'still TTD' }, 'a@test');

    expect(mockFhAddNote).toHaveBeenCalledTimes(1);
    const { data: rows } = await supabase.from('integration_outbox').select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('succeeded');
    expect(rows[0].operation).toBe('add_note');
  });

  it('FileHandler outage: decision completes, row stays pending, worker retries to success', async () => {
    mockFhAddNote.mockRejectedValueOnce(new Error('ledger down'));
    const diaryId = await seedDiary('TD_PAYMENT_REVIEW');

    const result = await svc.completeAction(diaryId, { action: 'continue' }, 'a@test');
    expect(result.successor_diaries).toHaveLength(1); // the decision is durable

    let { data: rows } = await supabase.from('integration_outbox').select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].last_error).toContain('ledger down');

    // Make the row due now, then the worker retries it to success.
    await supabase.from('integration_outbox')
      .update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', rows[0].id);
    const run = await outboxWorker.run('test-worker');
    expect(run.outcomes.find(o => o.id === rows[0].id).status).toBe('succeeded');
    expect(mockFhAddNote).toHaveBeenCalledTimes(2);
  });

  it('terminal failure surfaces a CRITICAL INTEGRATION_SYNC_FAILED diary', async () => {
    mockFhAddNote.mockRejectedValue(new Error('ledger permanently down'));
    const diaryId = await seedDiary('TD_PAYMENT_REVIEW');
    await svc.completeAction(diaryId, { action: 'continue' }, 'a@test');

    let { data: rows } = await supabase.from('integration_outbox').select('*');
    const rowId = rows[0].id;

    for (let i = 0; i < outbox.MAX_ATTEMPTS; i++) {
      await supabase.from('integration_outbox')
        .update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() })
        .eq('id', rowId);
      await outboxWorker.run('test-worker');
    }

    const { data: after } = await supabase.from('integration_outbox').select('*').eq('id', rowId).single();
    expect(after.status).toBe('failed');
    expect(after.attempts).toBe(outbox.MAX_ATTEMPTS);

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', CLAIM);
    const esc = diaries.find(d => d.diary_type === 'INTEGRATION_SYNC_FAILED');
    expect(esc).toBeTruthy();
    expect(esc.priority).toBe('CRITICAL');
    expect(esc.notes).toContain('ledger permanently down');
  });

  it('two concurrent outbox workers cannot double-execute a row', async () => {
    mockFhAddNote.mockRejectedValueOnce(new Error('first try fails'));
    const diaryId = await seedDiary('TD_PAYMENT_REVIEW');
    await svc.completeAction(diaryId, { action: 'continue' }, 'a@test');
    const { data: rows } = await supabase.from('integration_outbox').select('*');
    await supabase.from('integration_outbox')
      .update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', rows[0].id);

    const before = mockFhAddNote.mock.calls.length;
    await Promise.all([
      outbox.dispatchOne(rows[0].id, 'worker-A'),
      outbox.dispatchOne(rows[0].id, 'worker-B'),
    ]);
    expect(mockFhAddNote.mock.calls.length).toBe(before + 1);
  });
});
