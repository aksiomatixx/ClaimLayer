'use strict';

/**
 * Integration — Action-Queue Aftermath Automation: completing a queued
 * decision documents it, generates + queues the statutory notices, sets
 * the successor diaries, transitions status (firing the wired WCIS
 * triggers), and links the human decision to the AI recommendation.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const mockFhAddNote = jest.fn().mockResolvedValue({ noteId: 'nte-1' });
const mockFhCompleteDiary = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../src/services/filehandler', () => ({
  addNote: (...a) => mockFhAddNote(...a),
  completeDiary: (...a) => mockFhCompleteDiary(...a),
}));

const request                = require('supertest');
const app                    = require('../../src/index');
const { supabase }           = require('../../src/services/supabase');
const svc                    = require('../../src/services/diaryActionService');
const { generateAdminToken } = require('../../src/middleware/auth');

const adminToken = generateAdminToken({ sub: 'admin-001', email: 'adjuster@test' });
const auth = (r) => r.set('Cookie', `token=${adminToken}`);

const CLAIM = 'claim_aftermath_test';
const tick = () => new Promise(r => setImmediate(() => setImmediate(r)));

beforeEach(async () => {
  supabase._resetStore();
  await supabase.from('claims').insert({
    id: CLAIM, claim_number: 'HHW-AM-1', status: 'under_investigation',
    date_of_injury: '2026-04-01', employer_id: 'emp-1', wcis_enabled: true,
    td_rate: 500, attorney_represented: false,
    employee: { firstName: 'After', lastName: 'Math' },
  });
});

async function seedDiary(type, id = `diy_${type}`) {
  await supabase.from('diaries').insert({
    id, claim_id: CLAIM, diary_type: type, due_date: '2026-06-20',
    assigned_to: 'adjuster@test', priority: 'CRITICAL', status: 'open',
    notes: 'seeded',
  });
  return id;
}

describe('accept compensability — the full aftermath', () => {
  it('documents, notices, successors, status, AI link — in one decision', async () => {
    await supabase.from('ai_decisions').insert({
      id: 'aid-1', claim_id: CLAIM, decision_type: 'compensability',
      prompt_name: 'compensability_analysis', model: 'claude-sonnet-4-6',
      output_parsed: { compensability: 'Likely Compensable' },
      created_at: new Date().toISOString(),
    });
    const diaryId = await seedDiary('COMPENSABILITY_DECISION_DUE');

    const result = await svc.completeAction(diaryId, { action: 'accept', note: 'mechanism consistent' }, 'adjuster@test');
    await tick();

    // diary completed with the decision recorded
    const { data: diary } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
    expect(diary.status).toBe('completed');
    expect(diary.decision_action).toBe('accept');
    expect(diary.completed_by).toBe('adjuster@test');

    // notice generated AND queued for delivery
    expect(result.notices_generated.length).toBeGreaterThanOrEqual(1);
    const { data: notices } = await supabase.from('benefit_notices').select('*').eq('claim_id', CLAIM);
    expect(notices.some(n => n.notice_type === 'claim_accepted' && n.status === 'queued')).toBe(true);

    // successor diary set
    expect(result.successor_diaries.map(s => s.diary_type)).toContain('TD_PAYMENT_SETUP');

    // status transitioned
    const { data: claim } = await supabase.from('claims').select('*').eq('id', CLAIM).single();
    expect(claim.status).toBe('accepted');
    expect(result.status_transition).toBe('accepted');

    // human decision linked to the AI recommendation (the diary link is
    // then refined by updateStatus's own compensability linkage)
    const { data: ai } = await supabase.from('ai_decisions').select('*').eq('id', 'aid-1').single();
    expect(ai.human_decision).toBeTruthy();
    expect(ai.human_decision).toContain('accept');

    // decision documented
    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    expect(events.some(e => e.type === 'action_completed')).toBe(true);
  });

  it('deny fires the denial notice, denied status, and the WCIS denial trigger', async () => {
    const diaryId = await seedDiary('COMPENSABILITY_DECISION_DUE');
    const result = await svc.completeAction(diaryId, { action: 'deny', note: 'not AOE/COE' }, 'adjuster@test');
    await tick();

    expect(result.status_transition).toBe('denied');
    const { data: notices } = await supabase.from('benefit_notices').select('*').eq('claim_id', CLAIM);
    expect(notices.some(n => n.notice_type === 'claim_denied')).toBe(true);

    const { data: queue } = await supabase.from('wcis_trigger_queue').select('*').eq('claim_id', CLAIM);
    expect(queue.some(q => q.mtc_code === '04')).toBe(true);
  });

  it('delay (initial 14-day window) sets the 90-day decision diary on the presumption date', async () => {
    // The corrected model: delay lives on the INITIAL diary
    // (COMPENSABILITY_NOTICE_DUE); its successor lands exactly on
    // filed_at + 90 (the LC §5402 presumption date).
    const filedAt = new Date().toISOString();
    await supabase.from('claims').update({ filed_at: filedAt }).eq('id', CLAIM);
    const diaryId = await seedDiary('COMPENSABILITY_NOTICE_DUE');

    const result = await svc.completeAction(diaryId, { action: 'delay', note: 'awaiting prior treatment records' }, 'adjuster@test');
    expect(result.status_transition).toBeNull();
    expect(result.successor_diaries[0].diary_type).toBe('COMPENSABILITY_DECISION_DUE');
    const d = new Date(filedAt); d.setUTCDate(d.getUTCDate() + 90);
    expect(result.successor_diaries[0].due_date).toBe(d.toISOString().split('T')[0]);
    // The delay notice issued and queued.
    const { data: notices } = await supabase.from('benefit_notices').select('*').eq('claim_id', CLAIM);
    expect(notices.some(n => n.notice_type === 'claim_delay' && n.status === 'queued')).toBe(true);
  });
});

describe('TD biweekly cycle', () => {
  it("'continue' sets the next 14-day TD_PAYMENT_REVIEW", async () => {
    const diaryId = await seedDiary('TD_PAYMENT_REVIEW');
    const result = await svc.completeAction(diaryId, { action: 'continue' }, 'adjuster@test');
    expect(result.successor_diaries[0].diary_type).toBe('TD_PAYMENT_REVIEW');
    expect(result.notices_generated).toHaveLength(0);
  });

  it("'suspend' generates the td_suspension notice (with attorney copy when represented)", async () => {
    await supabase.from('claims').update({
      attorney_represented: true, attorney_name: 'L. Counsel',
    }).eq('id', CLAIM);
    const diaryId = await seedDiary('TD_PAYMENT_REVIEW');
    const result = await svc.completeAction(diaryId, { action: 'suspend' }, 'adjuster@test');
    const audiences = result.notices_generated.map(n => n.audience).sort();
    expect(audiences).toEqual(['attorney', 'worker']);
  });
});

describe('guard rails', () => {
  it('rejects unknown actions with the valid list', async () => {
    const diaryId = await seedDiary('COMPENSABILITY_NOTICE_DUE');
    await expect(svc.completeAction(diaryId, { action: 'nuke' }, 'a'))
      .rejects.toThrow(/Valid: accept, deny, delay/);
    // After a delay, the final decision diary has NO delay option —
    // the presumption date cannot be pushed.
    const finalId = await seedDiary('COMPENSABILITY_DECISION_DUE');
    await expect(svc.completeAction(finalId, { action: 'delay', note: 'x' }, 'a'))
      .rejects.toThrow(/Valid: accept, deny$/);
  });

  it('rejects completing a non-open diary', async () => {
    const diaryId = await seedDiary('TD_PAYMENT_REVIEW');
    await svc.completeAction(diaryId, { action: 'continue' }, 'a');
    await expect(svc.completeAction(diaryId, { action: 'continue' }, 'a'))
      .rejects.toThrow('not open');
  });

  it('diary types without rules complete generically with no aftermath', async () => {
    const diaryId = await seedDiary('SOME_LEGACY_TYPE');
    const result = await svc.completeAction(diaryId, {}, 'a');
    expect(result.notices_generated).toHaveLength(0);
    expect(result.successor_diaries).toHaveLength(0);
  });
});

describe('preview = execution (the drawer promise)', () => {
  it('preview lists exactly what accept will do', async () => {
    const diaryId = await seedDiary('COMPENSABILITY_DECISION_DUE');
    const preview = await svc.previewAftermath(diaryId);
    const accept = preview.actions.find(a => a.action === 'accept');
    expect(accept.will.join(' ')).toContain('claim_accepted');
    expect(accept.will.join(' ')).toContain('TD_PAYMENT_SETUP');
    expect(accept.will.join(' ')).toContain('"accepted"');
  });

  it('routes: GET aftermath-preview + POST complete', async () => {
    const diaryId = await seedDiary('CNR_OFFER_FOLLOWUP');
    const prev = await auth(request(app).get(`/api/v1/diaries/${diaryId}/aftermath-preview`));
    expect(prev.status).toBe(200);
    expect(prev.body.actions[0].action).toBe('followed_up');

    const done = await auth(request(app).post(`/api/v1/diaries/${diaryId}/complete`))
      .send({ action: 'followed_up', note: 'spoke with counsel' });
    expect(done.status).toBe(200);
    expect(done.body.successor_diaries[0].diary_type).toBe('CNR_OFFER_FOLLOWUP');
  });
});


describe('step 9 — system-of-record write-back on approval', () => {
  beforeEach(() => { mockFhAddNote.mockClear(); mockFhCompleteDiary.mockClear(); });

  it('writes the claim note to FileHandler and completes the mirrored diary', async () => {
    await supabase.from('claims').update({ filehandler_id: 'FH-100' }).eq('id', CLAIM);
    await supabase.from('diaries').insert({
      id: 'diy_fh', claim_id: CLAIM, diary_type: 'TD_PAYMENT_REVIEW',
      due_date: '2026-06-20', priority: 'HIGH', status: 'open', fh_diary_id: 'fhd-9',
    });

    await svc.completeAction('diy_fh', { action: 'continue', note: 'worker still TTD' }, 'adjuster@test');

    expect(mockFhAddNote).toHaveBeenCalledTimes(1);
    const [fhId, noteText, author] = mockFhAddNote.mock.calls[0];
    expect(fhId).toBe('FH-100');
    expect(noteText).toContain('TD_PAYMENT_REVIEW');
    expect(noteText).toContain('worker still TTD');
    expect(author).toBe('adjuster@test');

    // The outbox row id rides along as the stable idempotency key
    // (Codex sweep E14) so stale replays cannot double-complete.
    expect(mockFhCompleteDiary).toHaveBeenCalledWith(
      'FH-100', 'fhd-9', 'worker still TTD', 'adjuster@test',
      { idempotencyKey: expect.stringMatching(/^obx_/) });
  });

  it('write-back failure never blocks the decision', async () => {
    await supabase.from('claims').update({ filehandler_id: 'FH-100' }).eq('id', CLAIM);
    mockFhAddNote.mockRejectedValueOnce(new Error('ledger down'));
    const diaryId = await seedDiary('TD_PAYMENT_REVIEW', 'diy_fh2');
    const result = await svc.completeAction(diaryId, { action: 'continue' }, 'adjuster@test');
    expect(result.successor_diaries).toHaveLength(1);
  });

  it('claims with no FileHandler id skip write-back silently', async () => {
    const diaryId = await seedDiary('TD_PAYMENT_REVIEW', 'diy_nofh');
    await svc.completeAction(diaryId, { action: 'continue' }, 'adjuster@test');
    expect(mockFhAddNote).not.toHaveBeenCalled();
  });
});

describe('step 8 — decline and edit', () => {
  it('decline requires a documented reason, cancels with no aftermath, and writes the SOR note', async () => {
    await supabase.from('claims').update({ filehandler_id: 'FH-100' }).eq('id', CLAIM);
    const diaryId = await seedDiary('TD_PAYMENT_REVIEW', 'diy_decl');

    await expect(svc.declineAction(diaryId, {}, 'a')).rejects.toThrow('reason is required');

    const result = await svc.declineAction(diaryId, { reason: 'duplicate of existing review' }, 'adjuster@test');
    expect(result.status).toBe('cancelled');

    const { data: diary } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
    expect(diary.status).toBe('cancelled');
    expect(diary.decision_action).toBe('declined');
    expect(diary.decision_note).toBe('duplicate of existing review');

    // no aftermath: no successor diaries, no notices
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', CLAIM);
    expect(diaries.filter(d => d.status === 'open')).toHaveLength(0);
    const { data: notices } = await supabase.from('benefit_notices').select('*').eq('claim_id', CLAIM);
    expect(notices).toHaveLength(0);

    // documented + written back
    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    expect(events.some(e => e.type === 'action_declined')).toBe(true);
    expect(mockFhAddNote).toHaveBeenCalled();

    // a cancelled diary cannot be completed afterwards
    await expect(svc.completeAction(diaryId, { action: 'continue' }, 'a')).rejects.toThrow('not open');
  });

  it('edit changes due date/priority with a full audit trail', async () => {
    const diaryId = await seedDiary('TD_PAYMENT_REVIEW', 'diy_edit');
    const updated = await svc.editAction(diaryId, { due_date: '2026-07-01', priority: 'MEDIUM' }, 'adjuster@test');
    expect(updated.due_date).toBe('2026-07-01');
    expect(updated.priority).toBe('MEDIUM');

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    const edit = events.find(e => e.type === 'action_edited');
    expect(edit.data.changes.due_date).toEqual({ from: '2026-06-20', to: '2026-07-01' });
  });

  it('no-snooze diaries refuse a later due date', async () => {
    await supabase.from('diaries').insert({
      id: 'diy_ns', claim_id: CLAIM, diary_type: 'PD_ADVANCE_DUE',
      due_date: '2026-06-20', priority: 'CRITICAL', status: 'open', no_snooze: true,
    });
    await expect(svc.editAction('diy_ns', { due_date: '2026-08-01' }, 'a'))
      .rejects.toThrow('NO_SNOOZE_DIARY');
    // pulling it EARLIER is fine
    const earlier = await svc.editAction('diy_ns', { due_date: '2026-06-15' }, 'a');
    expect(earlier.due_date).toBe('2026-06-15');
  });

  it('routes: POST /diaries/:id/decline and PATCH /diaries/:id', async () => {
    const d1 = await seedDiary('TD_PAYMENT_REVIEW', 'diy_r1');
    const declined = await auth(request(app).post(`/api/v1/diaries/${d1}/decline`))
      .send({ reason: 'handled by phone' });
    expect(declined.status).toBe(200);
    expect(declined.body.status).toBe('cancelled');

    const d2 = await seedDiary('TD_PAYMENT_REVIEW', 'diy_r2');
    const edited = await auth(request(app).patch(`/api/v1/diaries/${d2}`))
      .send({ priority: 'LOW' });
    expect(edited.status).toBe(200);
    expect(edited.body.diary.priority).toBe('LOW');
  });
});
