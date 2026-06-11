'use strict';

/**
 * Statutory deadline ceilings + the corrected compensability timeline
 * (Finding 6 hardening + CL-DEC1).
 *
 * Corrected model (confirmed by the licensed adjuster):
 *   - On claim form receipt the adjuster must ACCEPT, DENY, or DELAY
 *     within 14 calendar days (COMPENSABILITY_NOTICE_DUE, CRITICAL,
 *     no_snooze).
 *   - Only a DELAY creates COMPENSABILITY_DECISION_DUE — due exactly ON
 *     the LC §5402 presumption date, 90 calendar days from claim form
 *     receipt. The date is immutable.
 *   - A presumption date already in the past escalates instead of
 *     rescheduling; edits can never move a diary past its
 *     statutory_deadline.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));
jest.mock('../../src/services/filehandler', () => ({
  addNote: jest.fn().mockResolvedValue({}),
  completeDiary: jest.fn().mockResolvedValue({}),
}));
// createClaim's fire-and-forget hooks (AI analysis, DWC-7, WCIS FROI)
// must not outlive the test environment.
jest.mock('../../src/services/aiService', () => ({
  analyzeCompensability: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../src/services/noticeService', () => ({
  generateDwc7: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../src/services/wcisTriggerService', () => ({
  enqueueIfReportable: jest.fn().mockResolvedValue({}),
}));

const { supabase } = require('../../src/services/supabase');
const svc = require('../../src/services/diaryActionService');

const CLAIM = 'claim_ceiling_test';

// ISO date offset from today (UTC), matching the service's date math.
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

async function seedClaim({ filedDaysAgo }) {
  await supabase.from('claims').insert({
    id: CLAIM, claim_number: 'HHW-CL-1', status: 'under_investigation',
    date_of_injury: iso(-filedDaysAgo - 1), filed_at: isoTs(-filedDaysAgo),
    employer_id: 'emp-1', wcis_enabled: false,
    employee: { firstName: 'Ceil', lastName: 'Ing' },
  });
}

async function seedNoticeDiary(extra = {}) {
  const id = 'diy_comp_notice';
  await supabase.from('diaries').insert({
    id, claim_id: CLAIM, diary_type: 'COMPENSABILITY_NOTICE_DUE',
    due_date: iso(0), priority: 'CRITICAL', status: 'open', no_snooze: true,
    assigned_to: 'adjuster@test', notes: 'seeded', ...extra,
  });
  return id;
}

beforeEach(() => supabase._resetStore());

describe('the delay successor lands ON the LC §5402 presumption date', () => {
  it('delay on day 10: the 90-day diary is due exactly filed_at + 90 — not decision-date + anything', async () => {
    await seedClaim({ filedDaysAgo: 10 });
    const diaryId = await seedNoticeDiary({ statutory_deadline: iso(4) });

    const result = await svc.completeAction(diaryId, { action: 'delay', note: 'investigation open' }, 'a@test');

    expect(result.successor_diaries).toHaveLength(1);
    const succ = result.successor_diaries[0];
    expect(succ.diary_type).toBe('COMPENSABILITY_DECISION_DUE');
    expect(succ.due_date).toBe(iso(80));            // filed(-10) + 90
    expect(succ.statutory_deadline).toBe(iso(80));  // immutable

    const { data: row } = await supabase.from('diaries').select('*').eq('id', succ.id).single();
    expect(row.no_snooze).toBe(true);
    expect(row.priority).toBe('CRITICAL');
  });

  it('boundary — the presumption date is exactly today: the successor lands on today', async () => {
    await seedClaim({ filedDaysAgo: 90 });
    const diaryId = await seedNoticeDiary();

    const result = await svc.completeAction(diaryId, { action: 'delay', note: 'late but inside' }, 'a@test');
    expect(result.successor_diaries).toHaveLength(1);
    expect(result.successor_diaries[0].due_date).toBe(iso(0));
    expect(result.escalations).toHaveLength(0);
  });

  it('the presumption date has PASSED: no successor — an immediate CRITICAL escalation', async () => {
    await seedClaim({ filedDaysAgo: 91 }); // presumption date was yesterday
    const diaryId = await seedNoticeDiary();

    const result = await svc.completeAction(diaryId, { action: 'delay', note: 'records never arrived' }, 'a@test');

    expect(result.successor_diaries).toHaveLength(0);
    expect(result.escalations).toHaveLength(1);
    const esc = result.escalations[0];
    expect(esc.diary_type).toBe('STATUTORY_DEADLINE_ESCALATION');
    expect(esc.due_date).toBe(iso(0));

    const { data: escRow } = await supabase.from('diaries').select('*').eq('id', esc.id).single();
    expect(escRow.priority).toBe('CRITICAL');
    expect(escRow.no_snooze).toBe(true);
    expect(escRow.notes).toContain('LC §5402');
    expect(escRow.notes).toContain('PASSED');

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    const breach = events.find(e => e.type === 'statutory_deadline_breached');
    expect(breach).toBeTruthy();
    expect(breach.data.statutory_deadline).toBe(iso(-1));

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', CLAIM);
    expect(diaries.filter(d => d.diary_type === 'COMPENSABILITY_DECISION_DUE' && d.status === 'open')).toHaveLength(0);
  });

  it('a claim with no filed_at derives the anchor from created_at', async () => {
    await supabase.from('claims').insert({
      id: CLAIM, claim_number: 'HHW-CL-1', status: 'under_investigation',
      date_of_injury: iso(-12), created_at: isoTs(-10),
      employer_id: 'emp-1', employee: {},
    });
    const diaryId = await seedNoticeDiary();
    const result = await svc.completeAction(diaryId, { action: 'delay', note: 'x' }, 'a@test');
    expect(result.successor_diaries[0].due_date).toBe(iso(80)); // created(-10) + 90
  });
});

describe('edits respect the ceiling', () => {
  it('a diary cannot be rescheduled beyond its statutory deadline', async () => {
    await seedClaim({ filedDaysAgo: 5 });
    const diaryId = await seedNoticeDiary({ statutory_deadline: iso(9), no_snooze: false, due_date: iso(2) });

    await expect(svc.editAction(diaryId, { due_date: iso(15) }, 'a@test'))
      .rejects.toThrow('STATUTORY_DEADLINE_CEILING');

    // Within the ceiling is fine.
    const ok = await svc.editAction(diaryId, { due_date: iso(5) }, 'a@test');
    expect(ok.due_date).toBe(iso(5));
  });
});

describe('claim creation seeds the corrected initial diary', () => {
  it('a new claim gets COMPENSABILITY_NOTICE_DUE at receipt + 14, and NO 90-day diary', async () => {
    const adp = require('../../src/services/adp');
    const filehandler = require('../../src/services/filehandler');
    jest.spyOn(adp, 'getEmployeeWithFinancials').mockResolvedValue({
      associateOID: 'oid-1', firstName: 'Seed', lastName: 'Test', dob: '1990-01-01',
      address: { line1: 'x', state: 'CA', zip: '90057' }, phone: '555',
      jobTitle: 'HHA', hireDate: '2024-01-01', aww: 900, tdRate: 600, weeksCalculated: 52,
    });
    filehandler.createClaim = jest.fn().mockResolvedValue({ claimId: 'FH-SEED', status: 'open' });

    const claimService = require('../../src/services/claimService');
    const claim = await claimService.createClaim({
      adpEmployeeId: 'ADP-SEED', employerName: 'Test Co', dateOfInjury: iso(-3),
      injuryDescription: 'Test injury description for diary seeding.',
    }, 'emp-1');

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claim.id);
    const notice = diaries.find(d => d.diary_type === 'COMPENSABILITY_NOTICE_DUE');
    expect(notice).toBeTruthy();
    expect(notice.due_date).toBe(iso(14));            // 14 cal days from claim form receipt (today)
    expect(notice.statutory_deadline).toBe(iso(14));
    expect(notice.no_snooze).toBe(true);
    expect(notice.priority).toBe('CRITICAL');
    expect(notice.notes).toContain('14 calendar days');

    // The old shape is GONE: no 90-day diary, no separate delay-notice diary.
    expect(diaries.some(d => d.diary_type === 'COMPENSABILITY_DECISION_DUE')).toBe(false);
    expect(diaries.some(d => d.diary_type === 'DELAY_NOTICE_DUE')).toBe(false);

    // Flush createClaim's fire-and-forget hooks before teardown.
    await new Promise(r => setTimeout(r, 50));
  });
});
