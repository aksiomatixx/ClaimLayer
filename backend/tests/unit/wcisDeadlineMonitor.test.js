'use strict';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const cron = require('../../src/cron/wcisDeadlineMonitor');

function daysFromNow(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

beforeEach(async () => {
  supabase._resetStore();
  await supabase.from('claims').insert({ id: 'c1', claim_number: 'X' });
});

describe('scanApproaching', () => {
  test('creates WCIS_DEADLINE_APPROACHING diary for pending row due in 2 days', async () => {
    await supabase.from('wcis_trigger_queue').insert({
      id: 'q1', claim_id: 'c1', trigger_event: 'claim_created',
      source_service: 'test', mtc_family: 'FROI', mtc_code: '00',
      event_date: daysFromNow(-5), deadline_date: daysFromNow(2),
      deadline_type: 'business_days_10', status: 'pending',
    });
    const n = await cron.scanApproaching();
    expect(n).toBe(1);
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', 'c1');
    expect(diaries.some(d => d.diary_type === 'WCIS_DEADLINE_APPROACHING' && d.priority === 'CRITICAL')).toBe(true);
  });

  test('ignores rows beyond 3-day window', async () => {
    await supabase.from('wcis_trigger_queue').insert({
      id: 'q2', claim_id: 'c1', trigger_event: 'claim_created',
      source_service: 'test', mtc_family: 'FROI', mtc_code: '00',
      event_date: daysFromNow(0), deadline_date: daysFromNow(10),
      deadline_type: 'business_days_10', status: 'pending',
    });
    const n = await cron.scanApproaching();
    expect(n).toBe(0);
  });

  test('ignores generated / suppressed rows', async () => {
    await supabase.from('wcis_trigger_queue').insert({
      id: 'q3', claim_id: 'c1', trigger_event: 'claim_created',
      source_service: 'test', mtc_family: 'FROI', mtc_code: '00',
      event_date: daysFromNow(-5), deadline_date: daysFromNow(1),
      deadline_type: 'business_days_10', status: 'generated',
    });
    const n = await cron.scanApproaching();
    expect(n).toBe(0);
  });

  test('diary dedup: does not double-create within 24h', async () => {
    await supabase.from('wcis_trigger_queue').insert({
      id: 'q4', claim_id: 'c1', trigger_event: 'claim_created',
      source_service: 'test', mtc_family: 'FROI', mtc_code: '00',
      event_date: daysFromNow(-5), deadline_date: daysFromNow(2),
      deadline_type: 'business_days_10', status: 'pending',
    });
    await cron.scanApproaching();
    await cron.scanApproaching();
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', 'c1');
    expect(diaries.filter(d => d.diary_type === 'WCIS_DEADLINE_APPROACHING')).toHaveLength(1);
  });
});

describe('scanAckOverdue', () => {
  test('flags transaction transmitted > 5 bd ago with no ack', async () => {
    const longAgo = new Date();
    longAgo.setUTCDate(longAgo.getUTCDate() - 15);
    await supabase.from('wcis_transactions').insert({
      id: 't1', claim_id: 'c1', mtc_family: 'FROI', mtc_code: '00',
      mtc_date: daysFromNow(-15), environment: 'test',
      payload: {}, payload_hash: 'h', adapter_used: 'stub',
      status: 'transmitted',
      transmitted_at: longAgo.toISOString(),
    });
    const n = await cron.scanAckOverdue();
    expect(n).toBeGreaterThan(0);
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', 'c1');
    expect(diaries.some(d => d.diary_type === 'WCIS_ACK_OVERDUE')).toBe(true);
  });
  test('does not flag recently transmitted', async () => {
    await supabase.from('wcis_transactions').insert({
      id: 't2', claim_id: 'c1', mtc_family: 'FROI', mtc_code: '00',
      mtc_date: daysFromNow(0), environment: 'test',
      payload: {}, payload_hash: 'h', adapter_used: 'stub',
      status: 'transmitted', transmitted_at: new Date().toISOString(),
    });
    const n = await cron.scanAckOverdue();
    expect(n).toBe(0);
  });
  test('ignores already-acked transactions', async () => {
    const longAgo = new Date();
    longAgo.setUTCDate(longAgo.getUTCDate() - 30);
    await supabase.from('wcis_transactions').insert({
      id: 't3', claim_id: 'c1', mtc_family: 'FROI', mtc_code: '00',
      mtc_date: daysFromNow(-30), environment: 'test',
      payload: {}, payload_hash: 'h', adapter_used: 'stub',
      status: 'accepted', transmitted_at: longAgo.toISOString(),
      ack_received_at: longAgo.toISOString(),
    });
    const n = await cron.scanAckOverdue();
    expect(n).toBe(0);
  });
});

describe('scanMissed', () => {
  test('flags pending row with deadline in past', async () => {
    await supabase.from('wcis_trigger_queue').insert({
      id: 'q5', claim_id: 'c1', trigger_event: 'claim_created',
      source_service: 'test', mtc_family: 'FROI', mtc_code: '00',
      event_date: daysFromNow(-30), deadline_date: daysFromNow(-5),
      deadline_type: 'business_days_10', status: 'pending',
    });
    const n = await cron.scanMissed();
    expect(n).toBe(1);
    const { data: diaries } = await supabase.from('diaries').select('*').eq('claim_id', 'c1');
    const missed = diaries.find(d => d.diary_type === 'WCIS_DEADLINE_MISSED');
    expect(missed).toBeTruthy();
    expect(missed.priority).toBe('CRITICAL');
    expect(missed.notes).toMatch(/129\.5/);
  });

  test('does not flag future deadlines', async () => {
    await supabase.from('wcis_trigger_queue').insert({
      id: 'q6', claim_id: 'c1', trigger_event: 'claim_created',
      source_service: 'test', mtc_family: 'FROI', mtc_code: '00',
      event_date: daysFromNow(0), deadline_date: daysFromNow(3),
      deadline_type: 'business_days_10', status: 'pending',
    });
    const n = await cron.scanMissed();
    expect(n).toBe(0);
  });
});

describe('run — end-to-end monitor', () => {
  test('aggregates approaching + overdue + missed counts', async () => {
    await supabase.from('wcis_trigger_queue').insert({
      id: 'qA', claim_id: 'c1', trigger_event: 'claim_created',
      source_service: 'test', mtc_family: 'FROI', mtc_code: '00',
      event_date: daysFromNow(-5), deadline_date: daysFromNow(1),
      deadline_type: 'business_days_10', status: 'pending',
    });
    await supabase.from('wcis_trigger_queue').insert({
      id: 'qB', claim_id: 'c1', trigger_event: 'claim_created',
      source_service: 'test', mtc_family: 'FROI', mtc_code: '00',
      event_date: daysFromNow(-30), deadline_date: daysFromNow(-5),
      deadline_type: 'business_days_10', status: 'pending',
    });
    const r = await cron.run();
    expect(r.approaching).toBeGreaterThanOrEqual(1);
    expect(r.missed).toBeGreaterThanOrEqual(1);
  });
});
