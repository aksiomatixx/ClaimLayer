'use strict';

/**
 * Claim lifecycle units of work on real PostgreSQL (ADR-0006, increment 2):
 * create, status change, reopen and representation each commit with their
 * events, ledger entries and follow-up jobs — or not at all.
 */

jest.mock('../../src/services/supabase', () => require('./pgSupabase'));
jest.mock('../../src/services/filehandler', () => ({
  createClaim: jest.fn(), setReserves: jest.fn(), createDiary: jest.fn(), completeDiary: jest.fn(),
  addNote: jest.fn(), attachDocument: jest.fn(),
}));
jest.mock('../../src/services/adp', () => ({ getEmployeeWithFinancials: jest.fn() }));
jest.mock('../../src/services/aiService', () => ({ analyzeCompensability: jest.fn(), evaluateRFA: jest.fn() }));

const config       = require('../../src/config');
const filehandler  = require('../../src/services/filehandler');
const adp          = require('../../src/services/adp');
const claimService = require('../../src/services/claimService');
const jobQueue     = require('../../src/services/jobQueue');
const { humanPrincipal } = require('../../src/policy/principal');
const { getPool, closePool } = require('../../src/db/pool');

const TENANT = '00000000-0000-0000-0000-000000000001';
const ADJ = humanPrincipal({ email: 'adj@tpa.test', role: 'adjuster', mfa: true, tenantId: TENANT });
const db = (sql, params) => getPool().query(sql, params).then(r => r.rows);
let n = 0;

const FROI = () => ({
  adpEmployeeId: `ADP-LC-${process.pid}-${++n}`, employerName: 'BrightCare', dateOfInjury: '2026-06-01',
  bodyPart: 'Lumbar', injuryType: 'Lifting Injury', injuryDescription: 'Lifted a patient',
});

async function blockLedger(action, fn) {
  const name = `test_block_${action.replace(/\W/g, '_')}`;
  await db(`ALTER TABLE audit_ledger ADD CONSTRAINT ${name} CHECK (action <> '${action}') NOT VALID`);
  try { return await fn(); } finally { await db(`ALTER TABLE audit_ledger DROP CONSTRAINT ${name}`); }
}

async function seedClaim(status) {
  const id = `claim_lc_${process.pid}_${++n}`;
  await db(`INSERT INTO claims (id, claim_number, status, date_of_injury, wcis_enabled)
            VALUES ($1, $2, $3, '2026-05-01', false)`, [id, `LC-${process.pid % 100000}-${n}`, status]);
  return id;
}

beforeEach(() => {
  config.jobs.kick = false;
  adp.getEmployeeWithFinancials.mockImplementation(async (id) => ({
    associateOID: `G3-${id}`, firstName: 'Rosa', lastName: 'Mendez', dob: '1980-02-02',
    address: { line1: '1 Main', state: 'CA', zip: '90001' }, phone: '555', jobTitle: 'Caregiver',
    hireDate: '2020-01-01', aww: 900, tdRate: 600, weeksCalculated: 13,
  }));
  filehandler.createClaim.mockReset();
  filehandler.createClaim.mockResolvedValue({ claimId: 'FH-LC-1', status: 'open' });
});
afterEach(() => jest.restoreAllMocks());
afterAll(closePool);

describe('createClaim', () => {
  test('commits claim, employee, events, statutory diaries, ledger entry and jobs together', async () => {
    const froi = FROI();
    const claim = await claimService.createClaim(froi, 'emp-1');
    expect(claim).toMatchObject({ status: 'new_claim', filehandlerId: 'FH-LC-1' });

    expect(await db('SELECT first_name FROM employees WHERE adp_employee_id = $1', [froi.adpEmployeeId]))
      .toEqual([{ first_name: 'Rosa' }]);
    const diaries = (await db('SELECT diary_type FROM diaries WHERE claim_id = $1', [claim.id])).map(r => r.diary_type).sort();
    expect(diaries).toEqual(['COMPENSABILITY_NOTICE_DUE', 'DWC1_ISSUE', 'DWC7_NOTICE', 'PR2_FOLLOW_UP', 'TD_PAYMENT_SETUP']);
    const events = (await db('SELECT type FROM claim_events WHERE claim_id = $1', [claim.id])).map(r => r.type);
    expect(events).toEqual(expect.arrayContaining(['claim_created', 'adp_pull_complete', 'diary_created', 'filehandler_claim_created']));
    expect(await db(`SELECT actor_id FROM audit_ledger WHERE action = 'claim.created' AND claim_id = $1`, [claim.id]))
      .toEqual([{ actor_id: 'system:intake' }]);
    const jobs = await db(`SELECT queue, run_at > now() AS delayed FROM jobs WHERE claim_id = $1 ORDER BY queue`, [claim.id]);
    expect(jobs).toEqual([
      { queue: 'claim.analysis', delayed: false },
      { queue: 'filehandler.create_claim', delayed: true },
      { queue: 'notice.dwc7', delayed: false },
      { queue: 'wcis.trigger', delayed: false },
    ]);
  });

  test('a motor-vehicle injury opens a subrogation evaluation in the same unit', async () => {
    const claim = await claimService.createClaim({ ...FROI(), injuryType: 'Motor Vehicle' }, 'emp-1');
    expect(await db('SELECT subrogation_status FROM claims WHERE id = $1', [claim.id]))
      .toEqual([{ subrogation_status: 'under_evaluation' }]);
  });

  test('if any part fails, nothing is created and FileHandler is never called', async () => {
    const froi = FROI();
    await blockLedger('claim.created', () =>
      expect(claimService.createClaim(froi, 'emp-1')).rejects.toThrow(/claim.created/));
    expect(await db('SELECT * FROM employees WHERE adp_employee_id = $1', [froi.adpEmployeeId])).toEqual([]);
    expect(await db(`SELECT * FROM claims WHERE employee->>'adpEmployeeId' = $1`, [froi.adpEmployeeId])).toEqual([]);
    expect(filehandler.createClaim).not.toHaveBeenCalled();
  });

  test('a FileHandler outage leaves the claim committed and the sync retried by its job', async () => {
    filehandler.createClaim.mockRejectedValueOnce(new Error('FileHandler 503'));
    const claim = await claimService.createClaim(FROI(), 'emp-1');
    expect(claim.filehandlerId).toBeFalsy();
    expect(claim.events.map(e => e.type)).toContain('filehandler_sync_failed');
    expect((await db('SELECT count(*)::int AS n FROM diaries WHERE claim_id = $1', [claim.id]))[0].n).toBe(5);

    // The retry job comes due and succeeds; a second run is a no-op.
    const [{ id: jobId }] = await db(
      `UPDATE jobs SET run_at = now() WHERE claim_id = $1 AND queue = 'filehandler.create_claim' RETURNING id`, [claim.id]);
    expect(await jobQueue.runOnce({ ids: [jobId] })).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await db('SELECT filehandler_id FROM claims WHERE id = $1', [claim.id])).toEqual([{ filehandler_id: 'FH-LC-1' }]);
    expect(filehandler.createClaim).toHaveBeenCalledTimes(2);
    await claimService._syncFileHandlerClaim(claim.id);
    expect(filehandler.createClaim).toHaveBeenCalledTimes(2);
  });
});

describe('updateStatus', () => {
  test('commits the transition, its event, its ledger entry and its WCIS + write-back jobs', async () => {
    const id = await seedClaim('under_investigation');
    await claimService.updateStatus(id, 'denied', 'adj@tpa.test', { actor: ADJ });
    expect(await db('SELECT status FROM claims WHERE id = $1', [id])).toEqual([{ status: 'denied' }]);
    expect(await db(`SELECT data FROM claim_events WHERE claim_id = $1 AND type = 'status_changed'`, [id]))
      .toEqual([{ data: { from: 'under_investigation', to: 'denied', changedBy: 'adj@tpa.test' } }]);
    expect(await db(`SELECT actor_id, payload FROM audit_ledger WHERE action = 'claim.status_changed' AND claim_id = $1`, [id]))
      .toEqual([{ actor_id: 'adj@tpa.test', payload: { from: 'under_investigation', to: 'denied' } }]);
    expect((await db('SELECT queue FROM jobs WHERE claim_id = $1 ORDER BY queue', [id])).map(r => r.queue))
      .toEqual(['claim.legacy_writeback', 'wcis.trigger']);
  });

  test('a ledger failure leaves the status, events and jobs untouched', async () => {
    const id = await seedClaim('under_investigation');
    await blockLedger('claim.status_changed', () =>
      expect(claimService.updateStatus(id, 'accepted', 'adj@tpa.test', { actor: ADJ })).rejects.toThrow());
    expect(await db('SELECT status FROM claims WHERE id = $1', [id])).toEqual([{ status: 'under_investigation' }]);
    expect(await db('SELECT * FROM claim_events WHERE claim_id = $1', [id])).toEqual([]);
    expect(await db('SELECT * FROM jobs WHERE claim_id = $1', [id])).toEqual([]);
  });

  test('conflicting concurrent transitions: the row lock lets exactly one win', async () => {
    const id = await seedClaim('under_investigation');
    const results = await Promise.allSettled([
      claimService.updateStatus(id, 'accepted', 'a@tpa.test', { actor: ADJ }),
      claimService.updateStatus(id, 'denied', 'b@tpa.test', { actor: ADJ }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected').reason.message).toMatch(/Invalid status transition: (accepted|denied) →/);
    expect((await db(`SELECT count(*)::int AS n FROM claim_events WHERE claim_id = $1`, [id]))[0].n).toBe(1);
  });
});

describe('reopen and representation', () => {
  test('reopen commits status, event, audit row, ledger entry and the FROI 02 job; a racing reopen loses', async () => {
    const id = await seedClaim('closed');
    const results = await Promise.allSettled([
      claimService.reopenClaim(id, 'condition worsened', 'adj@tpa.test', { actor: ADJ }),
      claimService.reopenClaim(id, 'condition worsened', 'adj@tpa.test', { actor: ADJ }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db('SELECT status FROM claims WHERE id = $1', [id])).toEqual([{ status: 'active_medical' }]);
    expect((await db(`SELECT count(*)::int AS n FROM audit_ledger WHERE action = 'claim.reopened' AND claim_id = $1`, [id]))[0].n).toBe(1);
    expect(await db(`SELECT payload->'trigger'->>'trigger_event' AS ev FROM jobs WHERE claim_id = $1`, [id]))
      .toEqual([{ ev: 'froi_data_changed' }]);
  });

  test('representation: SROI 02 job only on a change of state, everything in one unit', async () => {
    const id = await seedClaim('active_medical');
    await claimService.setAttorneyRepresentation(id, { represented: true, attorney: { name: 'L. Counsel' } }, 'adj@tpa.test', { actor: ADJ });
    await claimService.setAttorneyRepresentation(id, { represented: true, attorney: { name: 'L. Counsel', firm: 'Fixed LLP' } }, 'adj@tpa.test', { actor: ADJ });
    expect(await db('SELECT attorney_firm FROM claims WHERE id = $1', [id])).toEqual([{ attorney_firm: 'Fixed LLP' }]);
    expect((await db(`SELECT count(*)::int AS n FROM jobs WHERE claim_id = $1`, [id]))[0].n).toBe(1);
    expect((await db(`SELECT count(*)::int AS n FROM audit_ledger WHERE action = 'claim.representation_changed' AND claim_id = $1`, [id]))[0].n).toBe(2);
  });
});
