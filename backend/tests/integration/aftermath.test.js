'use strict';

/**
 * Integration — Action-Queue Aftermath Automation: completing a queued
 * decision documents it, generates + queues the statutory notices, sets
 * the successor diaries, transitions status (firing the wired WCIS
 * triggers), and links the human decision to the AI recommendation.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

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

  it('delay sets the next decision diary and leaves status unchanged', async () => {
    const diaryId = await seedDiary('COMPENSABILITY_DECISION_DUE');
    const result = await svc.completeAction(diaryId, { action: 'delay' }, 'adjuster@test');
    expect(result.status_transition).toBeNull();
    expect(result.successor_diaries[0].diary_type).toBe('COMPENSABILITY_DECISION_DUE');
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
    const diaryId = await seedDiary('COMPENSABILITY_DECISION_DUE');
    await expect(svc.completeAction(diaryId, { action: 'nuke' }, 'a'))
      .rejects.toThrow(/Valid: accept, deny, delay/);
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
