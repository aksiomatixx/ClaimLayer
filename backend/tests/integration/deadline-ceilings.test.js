'use strict';

/**
 * Statutory deadline ceilings (Finding 6 of the production-hardening
 * pass).
 *
 * A compensability "delay" reschedules the review — never the statute.
 * The LC §5402 deadline (DOI + 90 calendar days) is immutable: it is
 * stored on the diary at creation (statutory_deadline) or derived from
 * DOI, successors are capped to it, a deadline already in the past
 * produces a CRITICAL escalation instead of a successor, and edits can
 * never move a diary beyond its ceiling.
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

async function seedClaim(doiOffsetDays) {
  await supabase.from('claims').insert({
    id: CLAIM, claim_number: 'HHW-CL-1', status: 'under_investigation',
    date_of_injury: iso(doiOffsetDays), employer_id: 'emp-1', wcis_enabled: false,
    employee: { firstName: 'Ceil', lastName: 'Ing' },
  });
}

async function seedCompDiary(extra = {}) {
  const id = 'diy_comp_ceiling';
  await supabase.from('diaries').insert({
    id, claim_id: CLAIM, diary_type: 'COMPENSABILITY_DECISION_DUE',
    due_date: iso(0), priority: 'CRITICAL', status: 'open',
    assigned_to: 'adjuster@test', notes: 'seeded', ...extra,
  });
  return id;
}

beforeEach(() => supabase._resetStore());

describe('delay successors are capped at the original statutory deadline', () => {
  it('day 85: the +30-day delay is capped to DOI+90, not DOI+115', async () => {
    await seedClaim(-85); // ceiling = today + 5
    const diaryId = await seedCompDiary({ statutory_deadline: iso(5) });

    const result = await svc.completeAction(diaryId, { action: 'delay' }, 'a@test');

    expect(result.successor_diaries).toHaveLength(1);
    const succ = result.successor_diaries[0];
    expect(succ.diary_type).toBe('COMPENSABILITY_DECISION_DUE');
    expect(succ.due_date).toBe(iso(5));            // capped — NOT today+30
    expect(succ.statutory_deadline).toBe(iso(5));  // the ceiling rides along

    const { data: row } = await supabase.from('diaries').select('*').eq('id', succ.id).single();
    expect(row.no_snooze).toBe(true);
  });

  it('day 50: a delay within the window keeps its natural +30-day due date', async () => {
    await seedClaim(-50); // ceiling = today + 40
    const diaryId = await seedCompDiary({ statutory_deadline: iso(40) });

    const result = await svc.completeAction(diaryId, { action: 'delay' }, 'a@test');
    expect(result.successor_diaries[0].due_date).toBe(iso(30)); // uncapped
    expect(result.successor_diaries[0].statutory_deadline).toBe(iso(40));
  });

  it('boundary — deadline is exactly today: the successor lands on today, not past it', async () => {
    await seedClaim(-90); // ceiling = today
    const diaryId = await seedCompDiary({ statutory_deadline: iso(0) });

    const result = await svc.completeAction(diaryId, { action: 'delay' }, 'a@test');
    expect(result.successor_diaries).toHaveLength(1);
    expect(result.successor_diaries[0].due_date).toBe(iso(0));
    expect(result.escalations).toHaveLength(0);
  });

  it('legacy diaries without a stored deadline derive the ceiling from DOI+90', async () => {
    await seedClaim(-85); // derived ceiling = today + 5
    const diaryId = await seedCompDiary(); // no statutory_deadline column value

    const result = await svc.completeAction(diaryId, { action: 'delay' }, 'a@test');
    expect(result.successor_diaries[0].due_date).toBe(iso(5));
    expect(result.successor_diaries[0].statutory_deadline).toBe(iso(5));
  });
});

describe('a passed deadline escalates instead of rescheduling', () => {
  it('day 91: no successor — an immediate CRITICAL escalation is created', async () => {
    await seedClaim(-91); // ceiling = yesterday
    const diaryId = await seedCompDiary({ statutory_deadline: iso(-1) });

    const result = await svc.completeAction(diaryId, { action: 'delay', note: 'still investigating' }, 'a@test');

    expect(result.successor_diaries).toHaveLength(0);
    expect(result.escalations).toHaveLength(1);
    const esc = result.escalations[0];
    expect(esc.diary_type).toBe('STATUTORY_DEADLINE_ESCALATION');
    expect(esc.due_date).toBe(iso(0)); // due immediately

    const { data: escRow } = await supabase.from('diaries').select('*').eq('id', esc.id).single();
    expect(escRow.priority).toBe('CRITICAL');
    expect(escRow.no_snooze).toBe(true);
    expect(escRow.notes).toContain('LC §5402');
    expect(escRow.notes).toContain('PASSED');

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', CLAIM);
    const breach = events.find(e => e.type === 'statutory_deadline_breached');
    expect(breach).toBeTruthy();
    expect(breach.data.statutory_deadline).toBe(iso(-1));

    // No COMPENSABILITY successor was created anywhere.
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', CLAIM);
    const compOpen = diaries.filter(d => d.diary_type === 'COMPENSABILITY_DECISION_DUE' && d.status === 'open');
    expect(compOpen).toHaveLength(0);
  });
});

describe('edits respect the ceiling', () => {
  it('a diary cannot be rescheduled beyond its statutory deadline', async () => {
    await seedClaim(-50);
    const diaryId = await seedCompDiary({ statutory_deadline: iso(40), no_snooze: false });

    await expect(svc.editAction(diaryId, { due_date: iso(45) }, 'a@test'))
      .rejects.toThrow('STATUTORY_DEADLINE_CEILING');

    // Within the ceiling is fine.
    const ok = await svc.editAction(diaryId, { due_date: iso(20) }, 'a@test');
    expect(ok.due_date).toBe(iso(20));
  });
});

describe('claim creation stores the immutable deadline', () => {
  it('the seeded COMPENSABILITY diary carries statutory_deadline = DOI + 90', async () => {
    // Drive _seedInitialDiaries through createClaim with mocked externals.
    const adp = require('../../src/services/adp');
    const filehandler = require('../../src/services/filehandler');
    jest.spyOn(adp, 'getEmployeeWithFinancials').mockResolvedValue({
      associateOID: 'oid-1', firstName: 'Seed', lastName: 'Test', dob: '1990-01-01',
      address: { line1: 'x', state: 'CA', zip: '90057' }, phone: '555',
      jobTitle: 'HHA', hireDate: '2024-01-01', aww: 900, tdRate: 600, weeksCalculated: 52,
    });
    filehandler.createClaim = jest.fn().mockResolvedValue({ claimId: 'FH-SEED', status: 'open' });

    const claimService = require('../../src/services/claimService');
    const doi = iso(-10);
    const claim = await claimService.createClaim({
      adpEmployeeId: 'ADP-SEED', employerName: 'Test Co', dateOfInjury: doi,
      injuryDescription: 'Test injury description for diary seeding.',
    }, 'emp-1');

    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', claim.id);
    const comp = diaries.find(d => d.diary_type === 'COMPENSABILITY_DECISION_DUE');
    expect(comp).toBeTruthy();
    expect(comp.statutory_deadline).toBe(iso(80)); // DOI(-10) + 90
    expect(comp.no_snooze).toBe(true);

    // Flush createClaim's fire-and-forget hooks before teardown.
    await new Promise(r => setImmediate(() => setImmediate(() => setImmediate(r))));
  });
});
