'use strict';

/**
 * Unit tests — tdPeriodsService.
 *
 * Covers CRUD lifecycle, validation, atomic supersede, summary math,
 * and the TD_PAYMENT_SETUP diary auto-completion side-effect.
 *
 * NOTE: WCIS SROI trigger wiring (IP / CA / CB / Sx / Px / RB / RE /
 * FS) and §4650(d) penalty automation are deferred to the full
 * tdService milestone and are NOT covered here. The service file
 * marks each hook with a "WCIS HOOK" comment.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase }       = require('../../src/services/supabase');
const tdPeriodsService   = require('../../src/services/tdPeriodsService');

const TODAY = new Date().toISOString().split('T')[0];
const ACTOR = 'adjuster@homecaretpa.com';

async function seedClaim(id = 'claim_td_test') {
  await supabase.from('claims').insert({
    id,
    claim_number: 'HHW-2026-TD',
    employer_id: 'employer-brightcare-001',
    status: 'active_medical',
    employee: { firstName: 'Maria', lastName: 'Santos' },
    aww: 750.75, td_rate: 500.50,
    date_of_injury: '2025-06-15',
    body_part: 'Lumbar Spine',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return id;
}

beforeEach(() => {
  supabase._resetStore();
});

// ═════════════════════════════════════════════════════════════════════════════
// createPeriod
// ═════════════════════════════════════════════════════════════════════════════
describe('createPeriod', () => {
  it('happy path — first period sets reason_started = initial_disability', async () => {
    const claimId = await seedClaim();
    const period = await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD',
      start_date:   '2025-07-01',
      weekly_rate:  500.50,
    }, ACTOR);

    expect(period.benefit_type).toBe('TTD');
    expect(period.start_date).toBe('2025-07-01');
    expect(Number(period.weekly_rate)).toBe(500.50);
    expect(period.reason_started).toBe('initial_disability');
    expect(period.end_date).toBeNull();
    expect(period.created_by).toBe(ACTOR);

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', claimId);
    expect(events.some(e => e.type === 'td_period_started')).toBe(true);
  });

  it('with active period of same type — auto-closes with reason_ended = rate_change', async () => {
    const claimId = await seedClaim();
    const first = await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 500.50,
    }, ACTOR);

    await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-08-15', weekly_rate: 600.00,
    }, ACTOR);

    const closed = await tdPeriodsService.getById(first.id);
    expect(closed.end_date).toBe('2025-08-14');           // start - 1 day
    expect(closed.reason_ended).toBe('rate_change');

    const all = await tdPeriodsService.listForClaim(claimId);
    expect(all.length).toBe(2);
    expect(all.filter(p => p.end_date == null).length).toBe(1);
  });

  it('with active period of different type — auto-closes with benefit_type_change', async () => {
    const claimId = await seedClaim();
    await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 500.50,
    }, ACTOR);

    await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TPD', start_date: '2025-08-15', weekly_rate: 312.00,
    }, ACTOR);

    const all = await tdPeriodsService.listForClaim(claimId);
    const closed = all.find(p => p.end_date != null);
    expect(closed.reason_ended).toBe('benefit_type_change');
  });

  it('rejects when start_date is before active period start_date', async () => {
    const claimId = await seedClaim();
    await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-07-15', weekly_rate: 500,
    }, ACTOR);
    await expect(tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 500,
    }, ACTOR)).rejects.toThrow(/on or after/);
  });

  it('validates benefit_type, start_date format, and weekly_rate > 0', async () => {
    const claimId = await seedClaim();
    await expect(tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'INVALID', start_date: '2025-07-01', weekly_rate: 500,
    }, ACTOR)).rejects.toThrow(/benefit_type/);
    await expect(tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: 'not-a-date', weekly_rate: 500,
    }, ACTOR)).rejects.toThrow(/start_date/);
    await expect(tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 0,
    }, ACTOR)).rejects.toThrow(/weekly_rate/);
  });

  it('rejects when claim does not exist', async () => {
    await expect(tdPeriodsService.createPeriod('nonexistent', {
      benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 500,
    }, ACTOR)).rejects.toThrow(/Claim not found/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// closePeriod
// ═════════════════════════════════════════════════════════════════════════════
describe('closePeriod', () => {
  it('happy path', async () => {
    const claimId = await seedClaim();
    const period = await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 500,
    }, ACTOR);
    const closed = await tdPeriodsService.closePeriod(period.id, {
      end_date: '2025-09-01', reason_ended: 'rtw_full', notes: 'RTW full duty',
    }, ACTOR);
    expect(closed.end_date).toBe('2025-09-01');
    expect(closed.reason_ended).toBe('rtw_full');
    expect(closed.notes).toContain('RTW full duty');

    const { data: events } = await supabase.from('claim_events').select('*').eq('claim_id', claimId);
    expect(events.some(e => e.type === 'td_period_closed' && e.data.auto_close === false)).toBe(true);
  });

  it('rejects when already closed (PERIOD_ALREADY_CLOSED)', async () => {
    const claimId = await seedClaim();
    const period = await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 500,
    }, ACTOR);
    await tdPeriodsService.closePeriod(period.id, {
      end_date: '2025-09-01', reason_ended: 'rtw_full',
    }, ACTOR);

    await expect(tdPeriodsService.closePeriod(period.id, {
      end_date: '2025-09-15', reason_ended: 'mmi_reached',
    }, ACTOR)).rejects.toThrow('PERIOD_ALREADY_CLOSED');
  });

  it('rejects when end_date < start_date', async () => {
    const claimId = await seedClaim();
    const period = await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-07-15', weekly_rate: 500,
    }, ACTOR);
    await expect(tdPeriodsService.closePeriod(period.id, {
      end_date: '2025-07-01', reason_ended: 'rtw_full',
    }, ACTOR)).rejects.toThrow(/on or after/);
  });

  it('validates reason_ended', async () => {
    const claimId = await seedClaim();
    const period = await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 500,
    }, ACTOR);
    await expect(tdPeriodsService.closePeriod(period.id, {
      end_date: '2025-09-01', reason_ended: 'unicorn',
    }, ACTOR)).rejects.toThrow(/reason_ended/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// reinstatePeriod
// ═════════════════════════════════════════════════════════════════════════════
describe('reinstatePeriod', () => {
  it('happy path — sets reinstated_from_period_id and reason_started', async () => {
    const claimId = await seedClaim();
    const first = await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 500,
    }, ACTOR);
    await tdPeriodsService.closePeriod(first.id, {
      end_date: '2025-09-01', reason_ended: 'rtw_full',
    }, ACTOR);

    const reinstated = await tdPeriodsService.reinstatePeriod(claimId, first.id, {
      start_date: '2025-10-01', weekly_rate: 525, notes: 'Recurrence',
    }, ACTOR);

    expect(reinstated.reinstated_from_period_id).toBe(first.id);
    expect(reinstated.reason_started).toBe('reinstatement');
    expect(reinstated.benefit_type).toBe('TTD');         // inherits
    expect(reinstated.end_date).toBeNull();
  });

  it('rejects when source period is not closed', async () => {
    const claimId = await seedClaim();
    const first = await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 500,
    }, ACTOR);
    await expect(tdPeriodsService.reinstatePeriod(claimId, first.id, {
      start_date: '2025-08-01', weekly_rate: 500,
    }, ACTOR)).rejects.toThrow(/already-active/);
  });

  it('rejects when an active period exists', async () => {
    const claimId = await seedClaim();
    const first = await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 500,
    }, ACTOR);
    await tdPeriodsService.closePeriod(first.id, {
      end_date: '2025-09-01', reason_ended: 'rtw_full',
    }, ACTOR);
    await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-10-01', weekly_rate: 500,
    }, ACTOR);

    await expect(tdPeriodsService.reinstatePeriod(claimId, first.id, {
      start_date: '2025-11-01', weekly_rate: 500,
    }, ACTOR)).rejects.toThrow(/Cannot reinstate while another active/);
  });

  it('rejects when start_date <= source.end_date', async () => {
    const claimId = await seedClaim();
    const first = await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 500,
    }, ACTOR);
    await tdPeriodsService.closePeriod(first.id, {
      end_date: '2025-09-01', reason_ended: 'rtw_full',
    }, ACTOR);

    await expect(tdPeriodsService.reinstatePeriod(claimId, first.id, {
      start_date: '2025-09-01', weekly_rate: 500,
    }, ACTOR)).rejects.toThrow(/after the source period end_date/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// updatePeriodMetadata
// ═════════════════════════════════════════════════════════════════════════════
describe('updatePeriodMetadata', () => {
  it('happy path — updates notes and suspension_reason_code', async () => {
    const claimId = await seedClaim();
    const period = await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 500,
    }, ACTOR);
    const updated = await tdPeriodsService.updatePeriodMetadata(period.id, {
      notes: 'reviewed by adjuster', suspension_reason_code: 'S1',
    }, ACTOR);
    expect(updated.notes).toBe('reviewed by adjuster');
    expect(updated.suspension_reason_code).toBe('S1');
  });

  it('rejects forbidden structural fields', async () => {
    const claimId = await seedClaim();
    const period = await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 500,
    }, ACTOR);
    for (const field of ['start_date', 'end_date', 'weekly_rate', 'benefit_type']) {
      await expect(tdPeriodsService.updatePeriodMetadata(period.id, {
        [field]: 'whatever',
      }, ACTOR)).rejects.toThrow(/cannot be updated via metadata patch/);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// summary math
// ═════════════════════════════════════════════════════════════════════════════
describe('summary', () => {
  it('zero periods — all zeros, weeks_remaining = 104', async () => {
    const claimId = await seedClaim();
    const s = await tdPeriodsService.summary(claimId);
    expect(s.active).toBeNull();
    expect(s.total_weeks_paid).toBe(0);
    expect(s.total_indemnity_paid).toBe(0);
    expect(s.periods_count).toBe(0);
    expect(s.statutory_cap_weeks).toBe(104);
    expect(s.weeks_remaining).toBe(104);
    expect(s.projected_exhaustion_date).toBeNull();
  });

  it('one closed period — correct weeks + indemnity', async () => {
    const claimId = await seedClaim();
    // Insert directly to bypass transition-state branching
    await supabase.from('td_periods').insert({
      id: 'tdp_one',
      claim_id: claimId,
      benefit_type: 'TTD',
      start_date: '2025-07-01',
      end_date:   '2025-07-14',                  // 14 days inclusive = 2.0 weeks
      weekly_rate: 500,
      reason_started: 'initial_disability',
      reason_ended:   'rtw_full',
      created_at: new Date().toISOString(),
    });
    const s = await tdPeriodsService.summary(claimId);
    expect(s.total_weeks_paid).toBe(2);
    expect(s.total_indemnity_paid).toBe(1000);   // 2 × 500
    expect(s.periods_count).toBe(1);
    expect(s.active).toBeNull();
    expect(s.weeks_remaining).toBe(102);
  });

  it('one active period — pro-rates to today and projects exhaustion', async () => {
    const claimId = await seedClaim();
    const start = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    await supabase.from('td_periods').insert({
      id: 'tdp_active',
      claim_id: claimId,
      benefit_type: 'TTD',
      start_date: start,
      end_date:   null,
      weekly_rate: 500,
      reason_started: 'initial_disability',
      created_at: new Date().toISOString(),
    });
    const s = await tdPeriodsService.summary(claimId);
    expect(s.active).not.toBeNull();
    expect(s.active.benefit_type).toBe('TTD');
    expect(s.active.days_in).toBeGreaterThanOrEqual(7);
    expect(s.total_weeks_paid).toBeGreaterThanOrEqual(1);
    expect(s.weeks_remaining).toBeLessThan(104);
    expect(s.projected_exhaustion_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('multiple periods with gaps — sums only the active days', async () => {
    const claimId = await seedClaim();
    await supabase.from('td_periods').insert([
      { id: 'tdp_a', claim_id: claimId, benefit_type: 'TTD', start_date: '2025-01-01', end_date: '2025-01-14', weekly_rate: 500, reason_started: 'initial_disability', reason_ended: 'rtw_full', created_at: new Date().toISOString() },
      { id: 'tdp_b', claim_id: claimId, benefit_type: 'TTD', start_date: '2025-03-01', end_date: '2025-03-28', weekly_rate: 500, reason_started: 'reinstatement',     reason_ended: 'rtw_full', created_at: new Date().toISOString() },
    ]);
    const s = await tdPeriodsService.summary(claimId);
    // 14 days + 28 days = 42 days = 6.0 weeks
    expect(s.total_weeks_paid).toBe(6);
    expect(s.total_indemnity_paid).toBe(3000);
    expect(s.periods_count).toBe(2);
    expect(s.active).toBeNull();
  });

  it('total_weeks_paid > 104 — weeks_remaining floors to 0 and projected = today', async () => {
    const claimId = await seedClaim();
    // 800 days = ~114 weeks (over the 104 cap)
    const start = new Date(Date.now() - 800 * 86400000).toISOString().split('T')[0];
    await supabase.from('td_periods').insert({
      id: 'tdp_over',
      claim_id: claimId,
      benefit_type: 'TTD',
      start_date: start,
      end_date:   null,
      weekly_rate: 500,
      reason_started: 'initial_disability',
      created_at: new Date().toISOString(),
    });
    const s = await tdPeriodsService.summary(claimId);
    expect(s.total_weeks_paid).toBeGreaterThan(104);
    expect(s.weeks_remaining).toBe(0);
    expect(s.projected_exhaustion_date).toBe(TODAY);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TD_PAYMENT_SETUP diary auto-completion on first period
// ═════════════════════════════════════════════════════════════════════════════
describe('first-period diary auto-completion', () => {
  it('auto-completes the open TD_PAYMENT_SETUP diary on first period creation', async () => {
    const claimId = await seedClaim();
    await supabase.from('diaries').insert({
      id: 'diy_setup_1',
      claim_id: claimId,
      diary_type: 'TD_PAYMENT_SETUP',
      due_date: '2025-07-15',
      assigned_to: 'system@homecaretpa.com',
      priority: 'HIGH',
      notes: 'First TD payment due within 14 days',
      status: 'open',
      created_at: new Date().toISOString(),
    });

    const period = await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 500,
    }, ACTOR);

    const { data: diary } = await supabase.from('diaries').select('*').eq('id', 'diy_setup_1').single();
    expect(diary.status).toBe('completed');
    expect(diary.resolution_notes).toContain(period.id);
    expect(diary.resolution_notes).toContain('Completed by td_period creation');
  });

  it('does NOT auto-complete on the second period (only the first creation triggers it)', async () => {
    const claimId = await seedClaim();
    await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-07-01', weekly_rate: 500,
    }, ACTOR);
    // Insert another setup diary AFTER the first period (simulating
    // an out-of-band re-open scenario) and confirm it stays open when
    // the second period is created.
    await supabase.from('diaries').insert({
      id: 'diy_setup_2',
      claim_id: claimId,
      diary_type: 'TD_PAYMENT_SETUP',
      due_date: '2025-08-01',
      assigned_to: 'system@homecaretpa.com',
      priority: 'HIGH',
      notes: 'Second setup diary',
      status: 'open',
      created_at: new Date().toISOString(),
    });
    await tdPeriodsService.createPeriod(claimId, {
      benefit_type: 'TTD', start_date: '2025-08-15', weekly_rate: 600,
    }, ACTOR);
    const { data: diary2 } = await supabase.from('diaries').select('*').eq('id', 'diy_setup_2').single();
    expect(diary2.status).toBe('open');
  });
});
