'use strict';

/**
 * CL-DEC1 — the corrected compensability decision flow.
 *
 *   COMPENSABILITY_NOTICE_DUE (receipt + 14 cal days, CRITICAL,
 *   no_snooze) → ACCEPT | DENY | DELAY, each with a REQUIRED rationale
 *   validated server-side. Accept/deny resolve compensability and the
 *   90-day diary never exists. Delay issues the claim_delay notice and
 *   sets COMPENSABILITY_DECISION_DUE exactly ON the LC §5402
 *   presumption date (90 cal days from claim form receipt); that diary
 *   offers accept/deny only. Decision + rationale land on the diary,
 *   in the audit trail, and on the ai_decisions human-decision link.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const mockFhAddNote = jest.fn().mockResolvedValue({});
jest.mock('../../src/services/filehandler', () => ({
  addNote: (...a) => mockFhAddNote(...a),
  completeDiary: jest.fn().mockResolvedValue({}),
}));
// updateStatus fires a WCIS enqueue on a setImmediate — mock it so the
// lazy require can never resolve after the Jest environment tears down.
jest.mock('../../src/services/wcisTriggerService', () => ({
  enqueueIfReportable: jest.fn().mockResolvedValue({}),
}));

const tick = () => new Promise(r => setImmediate(() => setImmediate(r)));
afterEach(tick);

const { supabase } = require('../../src/services/supabase');
const svc = require('../../src/services/diaryActionService');
const { buildBrief, PLAYBOOK } = require('../../src/services/decisionBriefService');

const CLAIM = 'claim_comp_flow';

function iso(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().split('T')[0];
}
function isoTs(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString();
}

beforeEach(async () => {
  supabase._resetStore();
  mockFhAddNote.mockClear();
  await supabase.from('claims').insert({
    id: CLAIM, claim_number: 'HHW-FLOW-1', status: 'under_investigation',
    date_of_injury: iso(-9), filed_at: isoTs(-8),
    employer_id: 'emp-1', wcis_enabled: false, filehandler_id: 'FH-FLOW',
    employee: { firstName: 'Flow', lastName: 'Test' },
  });
});

async function seedNoticeDiary(id = 'diy_flow_notice') {
  await supabase.from('diaries').insert({
    id, claim_id: CLAIM, diary_type: 'COMPENSABILITY_NOTICE_DUE',
    due_date: iso(6), statutory_deadline: iso(6), no_snooze: true,
    priority: 'CRITICAL', status: 'open', assigned_to: 'adjuster@test',
  });
  return id;
}

describe('rationale is required, server-side, for every consequential decision', () => {
  it.each(['accept', 'deny', 'delay'])('%s without a rationale is rejected and nothing happens', async (action) => {
    const diaryId = await seedNoticeDiary();
    await expect(svc.completeAction(diaryId, { action }, 'a@test'))
      .rejects.toThrow(/rationale is required/i);

    // The diary was never even claimed; no aftermath leaked.
    const { data: diary } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
    expect(diary.status).toBe('open');
    const { data: notices } = await supabase.from('benefit_notices').select('*');
    expect(notices).toHaveLength(0);
    const { data: claim } = await supabase.from('claims').select('*').eq('id', CLAIM).single();
    expect(claim.status).toBe('under_investigation');
  });

  it('a whitespace-only rationale does not pass', async () => {
    const diaryId = await seedNoticeDiary();
    await expect(svc.completeAction(diaryId, { action: 'accept', note: '   ' }, 'a@test'))
      .rejects.toThrow(/rationale is required/i);
  });

  it('the preview tells the adjuster the rationale is required for all three', async () => {
    const diaryId = await seedNoticeDiary();
    const preview = await svc.previewAftermath(diaryId);
    expect(preview.actions.map(a => a.action).sort()).toEqual(['accept', 'delay', 'deny']);
    for (const a of preview.actions) {
      expect(a.requires_note).toBe(true);
      expect(a.will.join(' ')).toMatch(/rationale \(required/i);
    }
  });
});

describe('accept within the 14-day window', () => {
  it('accepts, notices, transitions — and the 90-day diary NEVER exists', async () => {
    const diaryId = await seedNoticeDiary();
    const result = await svc.completeAction(
      diaryId, { action: 'accept', note: 'mechanism and PR-1 causation are consistent; employer does not contest' }, 'adjuster@test');

    expect(result.status_transition).toBe('accepted');
    expect(result.notices_generated.some(n => n.type === 'claim_accepted')).toBe(true);

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', CLAIM);
    expect(diaries.some(d => d.diary_type === 'COMPENSABILITY_DECISION_DUE')).toBe(false);
    expect(diaries.some(d => d.diary_type === 'TD_PAYMENT_SETUP' && d.status === 'open')).toBe(true);

    // Decision + rationale documented on the diary and in the audit trail.
    const { data: done } = await supabase.from('diaries').select('*').eq('id', diaryId).single();
    expect(done.decision_action).toBe('accept');
    expect(done.decision_note).toContain('employer does not contest');
    const { data: audit } = await supabase.from('audit_log').select('*');
    const row = audit.find(a => a.resource_id === diaryId && a.action === 'action_completed');
    expect(row.description).toContain('employer does not contest');
  });
});

describe('deny within the 14-day window (human-only, with rationale)', () => {
  it('denies with the rationale riding the ai_decisions human-decision link', async () => {
    await supabase.from('ai_decisions').insert({
      id: 'aid-flow-1', claim_id: CLAIM, decision_type: 'compensability',
      prompt_name: 'compensability_analysis', model: 'claude-sonnet-4-6',
      output_parsed: { compensability: 'Questionable' },
      created_at: new Date().toISOString(),
    });
    const diaryId = await seedNoticeDiary();
    const result = await svc.completeAction(
      diaryId, { action: 'deny', note: 'investigation shows the injury predates employment' }, 'adjuster@test');

    expect(result.status_transition).toBe('denied');
    expect(result.notices_generated.some(n => n.type === 'claim_denied')).toBe(true);

    const { data: ai } = await supabase.from('ai_decisions').select('*').eq('id', 'aid-flow-1').single();
    expect(ai.human_decision).toContain('deny');
    expect(ai.human_decision).toContain('predates employment'); // rationale linked
  });
});

describe('delay within the 14-day window', () => {
  it('issues the delay notice and sets the final diary ON the presumption date', async () => {
    const diaryId = await seedNoticeDiary();
    const result = await svc.completeAction(
      diaryId, { action: 'delay', note: 'awaiting prior treatment records and supervisor statement' }, 'adjuster@test');

    // No status change on delay.
    expect(result.status_transition).toBeNull();
    const { data: claim } = await supabase.from('claims').select('*').eq('id', CLAIM).single();
    expect(claim.status).toBe('under_investigation');

    // The delay notice generated and queued.
    expect(result.notices_generated.some(n => n.type === 'claim_delay')).toBe(true);
    const { data: notices } = await supabase.from('benefit_notices').select('*').eq('claim_id', CLAIM);
    expect(notices.some(n => n.notice_type === 'claim_delay' && n.status === 'queued')).toBe(true);

    // Successor exactly at filed_at + 90.
    expect(result.successor_diaries).toHaveLength(1);
    const succ = result.successor_diaries[0];
    expect(succ.diary_type).toBe('COMPENSABILITY_DECISION_DUE');
    expect(succ.due_date).toBe(iso(82)); // filed(-8) + 90
    expect(succ.statutory_deadline).toBe(iso(82));
  });

  it('the post-delay diary is a two-way decision: delay is gone', async () => {
    const diaryId = await seedNoticeDiary();
    await svc.completeAction(diaryId, { action: 'delay', note: 'records pending' }, 'a@test');

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', CLAIM);
    const final = diaries.find(d => d.diary_type === 'COMPENSABILITY_DECISION_DUE');
    const preview = await svc.previewAftermath(final.id);
    expect(preview.actions.map(a => a.action).sort()).toEqual(['accept', 'deny']);

    // And accepting it still requires the rationale.
    await expect(svc.completeAction(final.id, { action: 'accept' }, 'a@test'))
      .rejects.toThrow(/rationale is required/i);
    const done = await svc.completeAction(final.id, { action: 'accept', note: 'records resolved causation in favor' }, 'a@test');
    expect(done.status_transition).toBe('accepted');
  });
});

describe('decision brief copy states the corrected timeline', () => {
  it('COMPENSABILITY_NOTICE_DUE: 14 calendar days from receipt, delay → presumption date', () => {
    const why = PLAYBOOK.COMPENSABILITY_NOTICE_DUE.why({ ai: null });
    expect(why).toContain('14 calendar days');
    expect(why).toContain('claim form receipt');
    expect(why).toContain('LC §5402');
  });

  it('COMPENSABILITY_DECISION_DUE: the presumption date cannot move', () => {
    const why = PLAYBOOK.COMPENSABILITY_DECISION_DUE.why({ ai: null });
    expect(why).toContain('90 calendar days from claim form receipt');
    expect(why).toContain('cannot move');
    expect(why).not.toContain('window is running');
  });

  it('the status narrative no longer claims a running 90-day window', () => {
    const brief = buildBrief({
      claim: { status: 'under_investigation', employee: { firstName: 'A' } },
      diaries: [], documents: [],
    });
    expect(brief.summary).not.toContain('90-day decision window');
    expect(brief.summary).toContain('14 calendar days');
  });
});
