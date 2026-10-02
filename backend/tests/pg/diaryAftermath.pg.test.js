'use strict';

/**
 * Diary decisions on real PostgreSQL (ADR-0006, increment 2): completing,
 * declining or editing a queued action is one unit of work — notices and
 * their delivery channels, successor diaries, outbox rows, events, audit
 * rows, the ledger entry and the status transition commit together, or
 * none of them do.
 */

jest.mock('../../src/services/supabase', () => require('./pgSupabase'));
const mockAddNote = jest.fn();
const mockCompleteDiary = jest.fn();
jest.mock('../../src/services/filehandler', () => ({
  addNote: (...a) => mockAddNote(...a), completeDiary: (...a) => mockCompleteDiary(...a),
  createClaim: jest.fn(), setReserves: jest.fn(), createDiary: jest.fn(), attachDocument: jest.fn(),
}));

const config = require('../../src/config');
const svc    = require('../../src/services/diaryActionService');
const { getPool, closePool } = require('../../src/db/pool');

const db = (sql, params) => getPool().query(sql, params).then(r => r.rows);
let n = 0;

async function blockOn(table, column, value, fn) {
  const name = `test_block_${table}_${String(value).replace(/\W/g, '_')}`;
  await db(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${column} <> '${value}') NOT VALID`);
  try { return await fn(); } finally { await db(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`); }
}

async function seed({ status = 'under_investigation', diaryType = 'COMPENSABILITY_NOTICE_DUE' } = {}) {
  const claimId = `claim_da_${process.pid}_${++n}`;
  await db(`INSERT INTO claims (id, claim_number, status, date_of_injury, filehandler_id, wcis_enabled, employee, filed_at)
            VALUES ($1, $2, $3, '2026-05-01', 'FH-DA', false, '{"firstName":"Dia","lastName":"Ry"}', now())`,
  [claimId, `DA-${process.pid % 100000}-${n}`, status]);
  const diaryId = `diy_da_${process.pid}_${n}`;
  await db(`INSERT INTO diaries (id, claim_id, diary_type, due_date, status, fh_diary_id, statutory_deadline, priority)
            VALUES ($1, $2, $3, current_date + 7, 'open', 'FHD-1', current_date + 7, 'CRITICAL')`,
  [diaryId, claimId, diaryType]);
  return { claimId, diaryId };
}

const count = async (sql, params) => (await db(sql, params))[0].n;

beforeEach(() => {
  config.jobs.kick = false;
  mockAddNote.mockReset().mockResolvedValue({ noteId: 'n1' });
  mockCompleteDiary.mockReset().mockResolvedValue({ ok: true });
});
afterAll(closePool);

describe('completeAction', () => {
  test('accept: notices + channels, successor, outbox, event, audit row, ledger and status commit together', async () => {
    const { claimId, diaryId } = await seed();
    const out = await svc.completeAction(diaryId, { action: 'accept', note: 'Medical supports AOE/COE.' }, 'adj@tpa.test');
    expect(out).toMatchObject({ status_transition: 'accepted' });

    expect(await db('SELECT status, decision_action FROM diaries WHERE id = $1', [diaryId]))
      .toEqual([{ status: 'completed', decision_action: 'accept' }]);
    expect(await db('SELECT status FROM claims WHERE id = $1', [claimId])).toEqual([{ status: 'accepted' }]);
    expect(await count(`SELECT count(*)::int AS n FROM benefit_notices WHERE source_diary_id = $1 AND status = 'queued'`, [diaryId])).toBeGreaterThan(0);
    expect(await count(`SELECT count(*)::int AS n FROM benefit_notice_channels c JOIN benefit_notices b ON b.id = c.notice_id
                        WHERE b.source_diary_id = $1`, [diaryId])).toBeGreaterThan(0);
    expect(await db(`SELECT diary_type FROM diaries WHERE parent_diary_id = $1`, [diaryId])).toEqual([{ diary_type: 'TD_PAYMENT_SETUP' }]);
    expect((await db(`SELECT operation, status FROM integration_outbox WHERE claim_id = $1 ORDER BY operation`, [claimId])))
      .toEqual([{ operation: 'add_note', status: 'succeeded' }, { operation: 'complete_diary', status: 'succeeded' }]);
    expect(await count(`SELECT count(*)::int AS n FROM audit_log WHERE resource_id = $1 AND action = 'action_completed'`, [diaryId])).toBe(1);
    expect(await db(`SELECT action FROM audit_ledger WHERE claim_id = $1 ORDER BY seq`, [claimId]))
      .toEqual([{ action: 'claim.status_changed' }, { action: 'diary.action_completed' }]);
  });

  test('if any part fails, NOTHING of the decision survives and the failure is recorded', async () => {
    const { claimId, diaryId } = await seed();
    await blockOn('audit_ledger', 'action', 'diary.action_completed', () =>
      expect(svc.completeAction(diaryId, { action: 'accept', note: 'Medical supports AOE/COE.' }, 'adj@tpa.test'))
        .rejects.toThrow(/rolled back/));

    expect(await db('SELECT status FROM diaries WHERE id = $1', [diaryId])).toEqual([{ status: 'open' }]);
    expect(await db('SELECT status FROM claims WHERE id = $1', [claimId])).toEqual([{ status: 'under_investigation' }]);
    for (const [label, sql] of [
      ['notices',   `SELECT count(*)::int AS n FROM benefit_notices WHERE claim_id = $1`],
      ['channels',  `SELECT count(*)::int AS n FROM benefit_notice_channels WHERE claim_id = $1`],
      ['documents', `SELECT count(*)::int AS n FROM claim_documents WHERE claim_id = $1`],
      ['successor', `SELECT count(*)::int AS n FROM diaries WHERE claim_id = $1 AND id <> '${diaryId}'`],
      ['outbox',    `SELECT count(*)::int AS n FROM integration_outbox WHERE claim_id = $1`],
      ['jobs',      `SELECT count(*)::int AS n FROM jobs WHERE claim_id = $1`],
      ['ledger',    `SELECT count(*)::int AS n FROM audit_ledger WHERE claim_id = $1`],
    ]) {
      expect({ label, n: await count(sql, [claimId]) }).toEqual({ label, n: 0 });
    }
    expect(await db(`SELECT type FROM claim_events WHERE claim_id = $1`, [claimId])).toEqual([{ type: 'action_completion_failed' }]);
    expect(mockAddNote).not.toHaveBeenCalled();

    // Retrying after the fault clears succeeds, exactly once.
    await svc.completeAction(diaryId, { action: 'accept', note: 'Medical supports AOE/COE.' }, 'adj@tpa.test');
    expect(await db('SELECT status FROM diaries WHERE id = $1', [diaryId])).toEqual([{ status: 'completed' }]);
  });

  test('an invalid status transition fails the decision before anything is generated', async () => {
    const { claimId, diaryId } = await seed({ status: 'closed', diaryType: 'COMPENSABILITY_DECISION_DUE' });
    await expect(svc.completeAction(diaryId, { action: 'accept', note: 'x' }, 'adj@tpa.test'))
      .rejects.toThrow(/Invalid status transition: closed → accepted/);
    expect(await count(`SELECT count(*)::int AS n FROM benefit_notices WHERE claim_id = $1`, [claimId])).toBe(0);
  });

  test('two simultaneous completions: exactly one decision, one set of notices', async () => {
    const { claimId, diaryId } = await seed({ status: 'active_medical', diaryType: 'TD_PAYMENT_REVIEW' });
    const results = await Promise.allSettled([
      svc.completeAction(diaryId, { action: 'continue', note: 'A' }, 'a@tpa.test'),
      svc.completeAction(diaryId, { action: 'continue', note: 'B' }, 'b@tpa.test'),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected').reason.message).toBe('Diary is not open');
    expect(await count(`SELECT count(*)::int AS n FROM diaries WHERE parent_diary_id = $1`, [diaryId])).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM claim_events WHERE claim_id = $1 AND type = 'action_completed'`, [claimId])).toBe(1);
  });
});

describe('declineAction and editAction', () => {
  test('a decline commits with its ledger entry, or not at all', async () => {
    const { claimId, diaryId } = await seed({ status: 'active_medical', diaryType: 'TD_PAYMENT_REVIEW' });
    await blockOn('audit_ledger', 'action', 'diary.action_declined', () =>
      expect(svc.declineAction(diaryId, { reason: 'Duplicate of another review' }, 'adj@tpa.test')).rejects.toThrow());
    expect(await db('SELECT status FROM diaries WHERE id = $1', [diaryId])).toEqual([{ status: 'open' }]);
    expect(await count(`SELECT count(*)::int AS n FROM integration_outbox WHERE claim_id = $1`, [claimId])).toBe(0);

    await svc.declineAction(diaryId, { reason: 'Duplicate of another review' }, 'adj@tpa.test');
    expect(await db('SELECT status, decision_note FROM diaries WHERE id = $1', [diaryId]))
      .toEqual([{ status: 'cancelled', decision_note: 'Duplicate of another review' }]);
    expect(await count(`SELECT count(*)::int AS n FROM audit_ledger WHERE action = 'diary.action_declined' AND claim_id = $1`, [claimId])).toBe(1);
  });

  test('a deadline is never moved without the record of who moved it', async () => {
    const { diaryId } = await seed({ status: 'active_medical', diaryType: 'TD_PAYMENT_REVIEW' });
    const [{ due_date: before }] = await db('SELECT due_date FROM diaries WHERE id = $1', [diaryId]);
    await blockOn('audit_log', 'action', 'action_edited', () =>
      expect(svc.editAction(diaryId, { priority: 'LOW' }, 'adj@tpa.test')).rejects.toThrow());
    expect(await db('SELECT priority, due_date FROM diaries WHERE id = $1', [diaryId]))
      .toEqual([{ priority: 'CRITICAL', due_date: before }]);
  });
});
