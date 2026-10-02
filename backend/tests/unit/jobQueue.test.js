'use strict';

/**
 * jobQueue — compatibility mode, retry curve and registry wiring.
 * The durable (pg) behaviour — transactional enqueue, SKIP LOCKED claims,
 * leases, retries, dead-lettering — is proven against real PostgreSQL in
 * tests/pg/jobQueue.pg.test.js.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const jobQueue = require('../../src/services/jobQueue');
const registry = require('../../src/jobs/registry');
const { compatAdapter } = require('../../src/db/adapters');
const { supabase } = require('../../src/services/supabase');

const flush = () => new Promise(r => setImmediate(r));

afterEach(() => jest.restoreAllMocks());

describe('compatibility mode (no DATABASE_URL)', () => {
  it('runs the handler on the next macrotask — the timing setImmediate gave callers', async () => {
    const run = jest.spyOn(registry.QUEUES['rfa.evaluate'], 'run').mockResolvedValue();
    const out = await jobQueue.enqueue({ queue: 'rfa.evaluate', payload: { rfaId: 'rfa_1' } });
    expect(out).toEqual({ id: null, mode: 'compat' });
    expect(run).not.toHaveBeenCalled();          // not synchronously…
    await flush();
    expect(run).toHaveBeenCalledWith({ rfaId: 'rfa_1' }, { mode: 'compat', job: null }); // …but on the next tick
  });

  it('preserves enqueue order', async () => {
    const seen = [];
    jest.spyOn(registry.QUEUES['claim.analysis'], 'run').mockImplementation(async (p) => { seen.push(`a:${p.claimId}`); });
    jest.spyOn(registry.QUEUES['notice.dwc7'], 'run').mockImplementation(async (p) => { seen.push(`n:${p.claimId}`); });
    await jobQueue.enqueue({ queue: 'claim.analysis', payload: { claimId: 'c1' } });
    await jobQueue.enqueue({ queue: 'notice.dwc7', payload: { claimId: 'c1' } });
    await flush(); await flush();
    expect(seen).toEqual(['a:c1', 'n:c1']);
  });

  it('logs a failing handler instead of throwing into the caller', async () => {
    jest.spyOn(registry.QUEUES['rfa.evaluate'], 'run').mockRejectedValue(new Error('boom'));
    await expect(jobQueue.enqueue({ queue: 'rfa.evaluate', payload: { rfaId: 'r' } })).resolves.toBeDefined();
    await flush(); await flush();
  });

  it('hands the handler a JSON round-tripped payload (the shape pg mode delivers)', async () => {
    const run = jest.spyOn(registry.QUEUES['rfa.evaluate'], 'run').mockResolvedValue();
    const when = new Date('2026-10-01T12:00:00Z');
    await jobQueue.enqueue({ queue: 'rfa.evaluate', payload: { rfaId: 'r', when, skip: undefined } });
    await flush();
    expect(run.mock.calls[0][0]).toEqual({ rfaId: 'r', when: '2026-10-01T12:00:00.000Z' });
  });

  it('inside a unit of work, defers the job until the work has finished', async () => {
    const run = jest.spyOn(registry.QUEUES['rfa.evaluate'], 'run').mockResolvedValue();
    const tx = compatAdapter(supabase, { tenantId: 't' });
    await jobQueue.enqueue({ queue: 'rfa.evaluate', payload: { rfaId: 'r' } }, { tx });
    await flush();
    expect(run).not.toHaveBeenCalled();        // only registered as an after-commit hook
    for (const hook of tx._hooks) await hook();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a delayed job waits for its run time instead of running on the next tick', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const run = jest.spyOn(registry.QUEUES['rfa.evaluate'], 'run').mockResolvedValue();
      await jobQueue.enqueue({ queue: 'rfa.evaluate', payload: { rfaId: 'later' },
                               runAt: new Date(Date.now() + 60_000).toISOString() });
      await flush();
      expect(run).not.toHaveBeenCalled();
      jest.advanceTimersByTime(60_000);
      await flush();
      expect(run).toHaveBeenCalledWith({ rfaId: 'later' }, expect.anything());
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects an unknown queue at the call site', async () => {
    await expect(jobQueue.enqueue({ queue: 'claim.anaylsis', payload: {} }))
      .rejects.toThrow(/unknown queue 'claim.anaylsis'/);
  });

  it('rejects a non-object payload', async () => {
    await expect(jobQueue.enqueue({ queue: 'rfa.evaluate', payload: ['x'] }))
      .rejects.toThrow(/payload must be a plain object/);
  });

  it('worker operations refuse to run without DATABASE_URL', async () => {
    await expect(jobQueue.runOnce()).rejects.toThrow(/require DATABASE_URL/);
    expect(() => jobQueue.startPoller()).toThrow(/require DATABASE_URL/);
  });
});

describe('backoffSeconds', () => {
  it('doubles from 30 s and caps at one hour (no jitter at the midpoint)', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(n => jobQueue.backoffSeconds(n, mid)))
      .toEqual([30, 60, 120, 240, 480, 960, 1920, 3600]);
    expect(jobQueue.backoffSeconds(20, mid)).toBe(3600);
  });

  it('jitters within ±20%', () => {
    expect(jobQueue.backoffSeconds(3, () => 0)).toBe(96);
    expect(jobQueue.backoffSeconds(3, () => 0.999999)).toBe(144);
  });
});

describe('registry', () => {
  it('every queue name satisfies the jobs_queue_chk pattern and has a bounded retry budget', () => {
    for (const name of registry.names()) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/);
      const { maxAttempts, run } = registry.get(name);
      expect(typeof run).toBe('function');
      expect(maxAttempts).toBeGreaterThanOrEqual(1);
      expect(maxAttempts).toBeLessThanOrEqual(25);
    }
  });

  it('every handler resolves to an exported service function', () => {
    const targets = {
      'claim.analysis':               ['claimService', '_runAnalysis'],
      'notice.dwc7':                  ['noticeService', 'generateDwc7'],
      'wcis.trigger':                 ['wcisTriggerService', 'enqueueIfReportable'],
      'wcis.cnr_paid':                ['cnrService', '_wcisOnPayment'],
      'wcis.disbursement_paid':       ['disbursementService', '_wcisOnPayment'],
      'wcis.pd_advances_initiated':   ['pdService', '_wcisOnAdvancesInitiated'],
      'wcis.pd_advance_paid':         ['pdService', '_wcisOnAdvancePayment'],
      'claim.legacy_writeback':       ['claimService', '_legacyWriteBackUpdate'],
      'appointment.post_confirmation':['appointmentService', '_runPostConfirmation'],
      'qme.supplemental_evaluation':  ['supplementalRequestService', 'evaluateQmeReport'],
      'rfa.evaluate':                 ['rfaService', 'evaluateRFA'],
      'notice.rfa_letter':            ['noticeService', 'generateRfaLetter'],
      'documents.filehandler_push':   ['documentPushService', 'pushToFileHandler'],
      'filehandler.create_claim':     ['claimService', '_syncFileHandlerClaim'],
      'qa.file_sweep':                ['fileQaSupervisor', 'runFileQASweep'],
      'loss_fund.reconcile':          ['lossFundService', 'reconcileClearedPayments'],
    };
    expect(registry.names().sort()).toEqual(Object.keys(targets).sort());
    for (const [queue, [mod, fn]] of Object.entries(targets)) {
      const service = require(`../../src/services/${mod}`);
      expect({ queue, type: typeof service[fn] }).toEqual({ queue, type: 'function' });
    }
  });

  it('a handler calls through the module export (test doubles and spies apply)', async () => {
    const rfaService = require('../../src/services/rfaService');
    const spy = jest.spyOn(rfaService, 'evaluateRFA').mockResolvedValue('done');
    await expect(registry.get('rfa.evaluate').run({ rfaId: 'rfa_9' })).resolves.toBe('done');
    expect(spy).toHaveBeenCalledWith('rfa_9');
  });
});
