'use strict';

/**
 * Supervisor Daily Alerts (CL-SUP1) — deterministic queries only.
 *
 * Boundary cases on the two scope queries, adjuster grouping, the
 * idempotent per-(date, recipient) generation, supervisor-only role
 * gating, acknowledge auditing, and the business-morning cron wiring.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const request = require('supertest');
const app = require('../../src/index');
const { generateAdminToken, generateSupervisorToken, generateMagicToken } = require('../../src/middleware/auth');
const { supabase } = require('../../src/services/supabase');
const svc = require('../../src/services/supervisorAlertService');
const worker = require('../../src/cron/supervisorAlertWorker');

const SUP = `Bearer ${generateSupervisorToken({ sub: 'sup-1', email: 'supervisor@test' })}`;
const ADMIN = `Bearer ${generateAdminToken({ sub: 'adm', email: 'admin@test' })}`;

function iso(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().split('T')[0];
}
const TODAY = iso(0);

async function seedClaim(id, worker_name) {
  await supabase.from('claims').insert({
    id, claim_number: `HHW-SUP-${id.slice(-1)}`, status: 'active_medical',
    date_of_injury: '2026-04-01', employer_id: 'emp-1',
    employee: { firstName: worker_name, lastName: 'Test' },
  });
}

async function seedDiary(id, { due, priority = 'MEDIUM', status = 'open', no_snooze = false, claim = 'claim_sup_a', assigned = 'adjuster-a@test' }) {
  await supabase.from('diaries').insert({
    id, claim_id: claim, diary_type: 'TD_PAYMENT_REVIEW',
    due_date: due, priority, status, no_snooze, assigned_to: assigned,
  });
}

async function seedSupervisor(email = 'supervisor@test') {
  await supabase.from('users').insert({
    id: `u_${email}`, email, role: 'supervisor', created_at: new Date().toISOString(),
  });
}

beforeEach(async () => {
  supabase._resetStore();
  await seedClaim('claim_sup_a', 'Alice');
  await seedClaim('claim_sup_b', 'Bob');
});

describe('the two scope queries — boundary cases', () => {
  it('due-today-important: today + (CRITICAL or no_snooze) only', async () => {
    await seedDiary('d_yesterday_crit', { due: iso(-1), priority: 'CRITICAL' });
    await seedDiary('d_today_crit',     { due: TODAY, priority: 'CRITICAL' });
    await seedDiary('d_today_nosnooze', { due: TODAY, priority: 'MEDIUM', no_snooze: true });
    await seedDiary('d_today_medium',   { due: TODAY, priority: 'MEDIUM' });        // important? NO
    await seedDiary('d_tomorrow_crit',  { due: iso(1), priority: 'CRITICAL' });     // not yet
    await seedDiary('d_today_closed',   { due: TODAY, priority: 'CRITICAL', status: 'completed' });
    await seedDiary('d_today_completing', { due: TODAY, priority: 'CRITICAL', status: 'completing' });

    const due = await svc.dueTodayImportant(TODAY);
    expect(due.map(d => d.id).sort()).toEqual(['d_today_crit', 'd_today_nosnooze']);
  });

  it('overdue: EVERY open diary past due, regardless of priority', async () => {
    await seedDiary('d_yesterday_low',  { due: iso(-1), priority: 'LOW' });   // included
    await seedDiary('d_lastweek_crit',  { due: iso(-7), priority: 'CRITICAL' });
    await seedDiary('d_today_crit',     { due: TODAY, priority: 'CRITICAL' }); // due today ≠ overdue
    await seedDiary('d_closed_overdue', { due: iso(-3), status: 'cancelled' });

    const od = await svc.overdue(TODAY);
    expect(od.map(d => d.id).sort()).toEqual(['d_lastweek_crit', 'd_yesterday_low']);
  });

  it('a non-critical diary due today is excluded from section 1 but joins overdue once past due', async () => {
    await seedDiary('d_medium', { due: TODAY, priority: 'MEDIUM' });
    expect(await svc.dueTodayImportant(TODAY)).toHaveLength(0);
    expect(await svc.overdue(TODAY)).toHaveLength(0);

    const tomorrow = iso(1);
    expect((await svc.overdue(tomorrow)).map(d => d.id)).toEqual(['d_medium']);
  });
});

describe('digest assembly', () => {
  it('groups by adjuster then claim, with worker names, claim numbers, and days overdue', async () => {
    await seedDiary('d1', { due: TODAY, priority: 'CRITICAL', claim: 'claim_sup_a', assigned: 'adjuster-b@test' });
    await seedDiary('d2', { due: iso(-4), priority: 'LOW', claim: 'claim_sup_b', assigned: 'adjuster-a@test' });
    await seedDiary('d3', { due: iso(-2), priority: 'HIGH', claim: 'claim_sup_a', assigned: 'adjuster-b@test' });

    const digest = await svc.buildDigest(TODAY);
    expect(digest.due_today_count).toBe(1);
    expect(digest.overdue_count).toBe(2);

    expect(digest.due_today).toHaveLength(1);
    expect(digest.due_today[0].adjuster).toBe('adjuster-b@test');
    expect(digest.due_today[0].items[0]).toMatchObject({
      claim_number: 'HHW-SUP-a', worker: 'Alice Test', diary_type: 'TD_PAYMENT_REVIEW',
      due_date: TODAY, days_overdue: 0,
    });

    const adjusters = digest.overdue.map(g => g.adjuster);
    expect(adjusters).toEqual(['adjuster-a@test', 'adjuster-b@test']); // alphabetical
    const bob = digest.overdue[0].items[0];
    expect(bob.worker).toBe('Bob Test');
    expect(bob.days_overdue).toBe(4);
  });
});

describe('idempotent generation per (date, recipient)', () => {
  it('re-running the same date updates the one row and preserves the acknowledgement', async () => {
    await seedSupervisor();
    await seedDiary('d1', { due: iso(-1), priority: 'LOW' });

    const first = await svc.generate(TODAY);
    expect(first.alerts).toHaveLength(1);
    expect(first.alerts[0].overdue_count).toBe(1);

    await svc.acknowledge(first.alerts[0].id, 'supervisor@test');

    // The book changes; the cron re-runs for the same date.
    await seedDiary('d2', { due: iso(-2), priority: 'HIGH' });
    const second = await svc.generate(TODAY);

    const { data: rows } = await supabase.from('supervisor_alerts').select('*');
    expect(rows).toHaveLength(1); // updated, never duplicated
    expect(rows[0].overdue_count).toBe(2);
    expect(rows[0].acknowledged_at).toBeTruthy(); // ack preserved
    expect(second.alerts[0].id).toBe(first.alerts[0].id);
  });

  it('one row per supervisor', async () => {
    await seedSupervisor('supervisor@test');
    await seedSupervisor('lead@test');
    await seedDiary('d1', { due: iso(-1) });
    await svc.generate(TODAY);
    const { data: rows } = await supabase.from('supervisor_alerts').select('*');
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.recipient_user_id).sort()).toEqual(['lead@test', 'supervisor@test']);
  });

  it('no supervisor-role users → nothing generated, loudly logged, no crash', async () => {
    const out = await svc.generate(TODAY);
    expect(out).toMatchObject({ recipients: 0, alerts: [] });
  });
});

describe('role gating', () => {
  beforeEach(async () => {
    await seedSupervisor();
    await seedDiary('d1', { due: iso(-1) });
    await svc.generate(TODAY);
  });

  it('the supervisor reads their digest', async () => {
    const res = await request(app).get('/api/v1/supervisor/alerts/current').set('Authorization', SUP);
    expect(res.status).toBe(200);
    expect(res.body.alert.recipient_user_id).toBe('supervisor@test');
    expect(res.body.alert.overdue_count).toBe(1);
  });

  it('admins and employees cannot read the supervisor digest', async () => {
    expect((await request(app).get('/api/v1/supervisor/alerts/current').set('Authorization', ADMIN)).status).toBe(403);
    const emp = `Bearer ${generateMagicToken({ sub: 'e', claimId: 'claim_sup_a' })}`;
    expect((await request(app).get('/api/v1/supervisor/alerts/current').set('Authorization', emp)).status).toBe(403);
  });

  it('acknowledge is supervisor-only and writes the audit trail', async () => {
    const { data: rows } = await supabase.from('supervisor_alerts').select('*');
    const id = rows[0].id;

    expect((await request(app).post(`/api/v1/supervisor/alerts/${id}/acknowledge`).set('Authorization', ADMIN)).status).toBe(403);

    const res = await request(app).post(`/api/v1/supervisor/alerts/${id}/acknowledge`).set('Authorization', SUP);
    expect(res.status).toBe(200);
    expect(res.body.alert.acknowledged_by).toBe('supervisor@test');

    const { data: audit } = await supabase.from('audit_log').select('*');
    const entry = audit.find(a => a.action === 'supervisor_alert_acknowledged' && a.resource_id === id);
    expect(entry).toBeTruthy();
    expect(entry.actor).toBe('supervisor@test');
  });

  it('the generation trigger stays an admin ops endpoint', async () => {
    const res = await request(app).post('/api/v1/admin/workers/supervisor-alerts/run')
      .set('Authorization', ADMIN).send({ date: TODAY });
    expect(res.status).toBe(200);
    expect((await request(app).post('/api/v1/admin/workers/supervisor-alerts/run').set('Authorization', SUP)).status).toBe(403);
  });
});

describe('cron worker', () => {
  it('skips non-business days (weekend), generates on business days', async () => {
    await seedSupervisor();
    await seedDiary('d1', { due: '2026-06-12' });

    // Saturday 2026-06-13 → skipped.
    const sat = await worker.run('2026-06-13');
    expect(sat.skipped).toBe('not_a_business_day');
    const { data: none } = await supabase.from('supervisor_alerts').select('*');
    expect(none).toHaveLength(0);

    // Monday 2026-06-15 → generated (d1 is overdue by then).
    const mon = await worker.run('2026-06-15');
    expect(mon.recipients).toBe(1);
    const { data: rows } = await supabase.from('supervisor_alerts').select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0].alert_date).toBe('2026-06-15');
    expect(rows[0].overdue_count).toBe(1);
  });

  it('the date defaults to America/Los_Angeles today', () => {
    expect(svc.todayLA()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
