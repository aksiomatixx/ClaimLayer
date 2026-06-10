'use strict';

/**
 * Unit tests — tdService completion: WCIS SROI trigger wiring on every
 * TD state change, plus the named TD operations.
 *
 * Asserts actual wcis_trigger_queue rows (through the real
 * wcisTriggerService against the in-memory mock), not mocks of the
 * trigger service — except the non-fatality test, which forces a
 * throw and asserts the benefit change still lands.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const td = require('../../src/services/tdPeriodsService');

const CLAIM = 'claim_tdwcis_test';

beforeEach(async () => {
  supabase._resetStore();
  await supabase.from('claims').insert({
    id: CLAIM, claim_number: 'HHW-TD-1', status: 'active_medical',
    date_of_injury: '2026-04-01', employer_id: 'emp-1',
    wcis_enabled: true, aww: 900, td_rate: 600,
  });
});

async function queueRows() {
  const { data } = await supabase.from('wcis_trigger_queue').select('*').eq('claim_id', CLAIM);
  return data || [];
}

const startTTD = (overrides = {}) => td.createPeriod(CLAIM, {
  benefit_type: 'TTD', start_date: '2026-04-15', weekly_rate: 600, ...overrides,
}, 'adjuster@test');

describe('start-of-benefit triggers', () => {
  it('first TD period ever fires SROI IP (td_first_payment)', async () => {
    await startTTD();
    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger_event).toBe('td_first_payment');
    expect(rows[0].mtc_code).toBe('IP');
    expect(rows[0].source_service).toBe('tdPeriodsService');
  });

  it('salary continuation as first benefit fires SROI FS', async () => {
    await td.startSalaryContinuation(CLAIM, { effective_date: '2026-04-15', weekly_rate: 900 }, 'adj@test');
    const rows = await queueRows();
    expect(rows.map(r => r.mtc_code)).toEqual(['FS']);
  });
});

describe('named TD operations', () => {
  it('changeTdRate supersedes the active period and fires SROI CA', async () => {
    await startTTD();
    const next = await td.changeTdRate(CLAIM, { new_rate: 650, effective_date: '2026-05-01' }, 'adj@test');
    expect(next.weekly_rate).toBe(650);
    expect(next.reason_started).toBe('rate_change');

    const rows = await queueRows();
    expect(rows.map(r => r.mtc_code).sort()).toEqual(['CA', 'IP']);
  });

  it('transitionBenefitType TTD→TPD fires SROI CB and rejects no-op transitions', async () => {
    await startTTD();
    await td.transitionBenefitType(CLAIM, { to_benefit_type: 'TPD', effective_date: '2026-05-01', weekly_rate: 400 }, 'adj@test');
    const rows = await queueRows();
    expect(rows.map(r => r.mtc_code).sort()).toEqual(['CB', 'IP']);

    await expect(td.transitionBenefitType(CLAIM, { to_benefit_type: 'TPD', effective_date: '2026-06-01' }, 'adj@test'))
      .rejects.toThrow('already on that benefit type');
  });

  it('recordReducedEarnings fires SROI RE (not CA/CB)', async () => {
    await startTTD();
    const tpd = await td.recordReducedEarnings(CLAIM, { effective_date: '2026-05-01', new_rate: 300 }, 'adj@test');
    expect(tpd.benefit_type).toBe('TPD');
    const rows = await queueRows();
    expect(rows.map(r => r.trigger_event).sort()).toEqual(['td_first_payment', 'td_reduced_earnings']);
    expect(rows.find(r => r.trigger_event === 'td_reduced_earnings').mtc_code).toBe('RE');
  });

  it('changeTdRate with no active period throws', async () => {
    await expect(td.changeTdRate(CLAIM, { new_rate: 650, effective_date: '2026-05-01' }, 'adj@test'))
      .rejects.toThrow('No active TD period');
  });
});

describe('suspension triggers (closePeriod reason_ended mapping)', () => {
  const closeWith = async (reason) => {
    const p = await startTTD();
    await td.closePeriod(p.id, { end_date: '2026-05-10', reason_ended: reason }, 'adj@test');
    return (await queueRows()).filter(r => r.source_record_id === p.id && r.mtc_code !== 'IP');
  };

  it.each([
    ['rtw_full',              'S1'],
    ['rtw_modified',          'P1'],
    ['med_noncompliance',     'S2'],
    ['suspended_by_adjuster', 'S3'],
    ['max_weeks_exhausted',   'S7'],
  ])('reason %s fires SROI %s', async (reason, mtc) => {
    const rows = await closeWith(reason);
    expect(rows).toHaveLength(1);
    expect(rows[0].mtc_code).toBe(mtc);
  });

  it('mmi_reached fires nothing (PD pathway reports the CB)', async () => {
    const rows = await closeWith('mmi_reached');
    expect(rows).toHaveLength(0);
  });

  it('settled fires nothing (settlement services report PY/FN)', async () => {
    const rows = await closeWith('settled');
    expect(rows).toHaveLength(0);
  });
});

describe('reinstatement triggers', () => {
  it('reinstatePeriod fires SROI RB', async () => {
    const p = await startTTD();
    await td.closePeriod(p.id, { end_date: '2026-05-10', reason_ended: 'rtw_full' }, 'adj@test');
    await td.reinstatePeriod(CLAIM, p.id, { start_date: '2026-06-01', weekly_rate: 600 }, 'adj@test');

    const rows = await queueRows();
    expect(rows.map(r => r.mtc_code).sort()).toEqual(['IP', 'RB', 'S1']);
    expect(rows.find(r => r.mtc_code === 'RB').trigger_event).toBe('td_reinstated');
  });

  it('a fresh createPeriod after a gap (not via reinstate) reports RB, not a duplicate IP', async () => {
    const p = await startTTD();
    await td.closePeriod(p.id, { end_date: '2026-05-10', reason_ended: 'rtw_full' }, 'adj@test');
    await td.createPeriod(CLAIM, {
      benefit_type: 'TTD', start_date: '2026-06-01', weekly_rate: 600,
      reason_started: 'initial_disability',
    }, 'adj@test');

    const rows = await queueRows();
    expect(rows.filter(r => r.mtc_code === 'IP')).toHaveLength(1);
    expect(rows.filter(r => r.mtc_code === 'RB')).toHaveLength(1);
  });
});

describe('safety properties', () => {
  it('WCIS-disabled claims still get their benefit changes (suppressed, no queue row)', async () => {
    await supabase.from('claims').update({ wcis_enabled: false }).eq('id', CLAIM);
    const p = await startTTD();
    expect(p.id).toBeTruthy();
    expect(await queueRows()).toHaveLength(0);
  });

  it('a throwing trigger service never blocks the benefit change (non-fatal hook)', async () => {
    const wcis = require('../../src/services/wcisTriggerService');
    const spy = jest.spyOn(wcis, 'enqueueIfReportable').mockRejectedValue(new Error('queue down'));
    const p = await startTTD();
    expect(p.id).toBeTruthy();

    const { data: periods } = await supabase.from('td_periods').select('*').eq('claim_id', CLAIM);
    expect(periods).toHaveLength(1);
    spy.mockRestore();
  });
});
