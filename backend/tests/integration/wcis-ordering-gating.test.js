'use strict';

/**
 * Integration — ordering / gating / correction scenarios.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const wcisTrigger = require('../../src/services/wcisTriggerService');
const wcisPayload = require('../../src/services/wcisPayloadService');
const wcisTx      = require('../../src/services/wcisTransmissionService');

async function seedBaseline(id, accepted = true) {
  await supabase.from('claims').insert({
    id, claim_number: `HHW-${id}`,
    employer_id: 'e1', employer_name: 'BrightCare',
    date_of_injury: '2025-06-15',
    employee: { first_name: 'A', last_name: 'B', ssn: '555114444' },
    insurer_fein: '123456789', claim_administrator_fein: '123456789',
    employer_fein: '123456789', wcis_enabled: true,
  });
  await supabase.from('employers').insert({ id: 'e1', name: 'BrightCare', fein: '123456789' });
  await supabase.from('wcis_claim_state').insert({
    claim_id: id, claim_admin_claim_number: `HHW-${id}`,
    jcn: accepted ? `STUB-2026-${id}` : null,
    first_froi_accepted_at: accepted ? '2025-06-20T00:00:00Z' : null,
  });
}

beforeEach(() => { supabase._resetStore(); });

describe('FROI/SROI separation', () => {
  test('FROI and SROI into separate transmissions', async () => {
    await seedBaseline('c1');
    await supabase.from('wcis_transactions').insert({
      id: 't1', claim_id: 'c1', mtc_family: 'FROI', mtc_code: '00',
      mtc_date: '2025-06-15', environment: 'production',
      payload: {}, payload_hash: 'a', adapter_used: 'stub', status: 'generated',
    });
    await supabase.from('wcis_transactions').insert({
      id: 't2', claim_id: 'c1', mtc_family: 'SROI', mtc_code: 'IP',
      mtc_date: '2025-09-01', environment: 'production',
      payload: {}, payload_hash: 'b', adapter_used: 'stub', status: 'generated',
    });
    const r = await wcisTx.batchAndTransmit('production');
    expect(r.transmissions_created).toBe(2);
  });
});

describe('Correction flow', () => {
  test('regeneratePayload creates SROI CO and supersedes original', async () => {
    await seedBaseline('c2');
    await supabase.from('wcis_transactions').insert({
      id: 't1', claim_id: 'c2', mtc_family: 'SROI', mtc_code: 'IP',
      mtc_date: '2025-09-01', environment: 'production',
      payload: {
        _mtc_family: 'SROI', _mtc_code: 'IP',
        DN2_jurisdiction: 'CA', DN5_jcn_or_null: 'STUB-2026-c2',
        DN15_claim_admin_claim_number: 'HHW-c2', DN31_date_of_injury: '2025-06-15',
        DN42_employee_ssn: '555114444', DN43_employee_last_name: 'B', DN44_employee_first_name: 'A',
        DN6_insurer_fein: '123456789', DN18_claim_administrator_fein: '123456789',
        DN187_employer_fein: '123456789',
        benefit_lines: [],
      },
      payload_hash: 'a', adapter_used: 'stub', status: 'accepted_with_error',
    });
    const newTxn = await wcisPayload.regeneratePayload('t1', { reason: 'SSN corrected' });
    expect(newTxn.mtc_code).toBe('CO');
    expect(newTxn.payload.DN_correction_of_transaction_id).toBe('t1');

    const { data: orig } = await supabase.from('wcis_transactions').select('*').eq('id', 't1').single();
    expect(orig.status).toBe('superseded');
  });
});

describe('Duplicate detection across states', () => {
  test('pending + transmitted both count against duplicate check', async () => {
    await seedBaseline('c3');
    const r1 = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c3', trigger_event: 'pd_advance_paid',
      source_service: 'test', event_date: '2025-09-22',
      payload_context: { period_start: '2025-09-22' },
    });
    // Mark r1 transmitted (simulate earlier batch run)
    await supabase.from('wcis_trigger_queue').update({ status: 'generated' }).eq('id', r1.trigger_queue_id);
    const r2 = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c3', trigger_event: 'pd_advance_paid',
      source_service: 'test', event_date: '2025-09-22',
      payload_context: { period_start: '2025-09-22' },
    });
    // status 'generated' is NOT in the excluded-from-dedup set
    // (only 'suppressed','abandoned','failed' excluded)
    expect(r2.suppressed_reason).toBe('DUPLICATE_EVENT');
  });

  test('suppressed row does NOT block new enqueue', async () => {
    await seedBaseline('c4');
    const r1 = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c4', trigger_event: 'pd_advance_paid',
      source_service: 'test', event_date: '2025-09-22',
      payload_context: { period_start: '2025-09-22' },
    });
    await wcisTrigger.suppressPending({
      claim_id: 'c4', trigger_event: 'pd_advance_paid', reason: 'TEST',
    });
    const r2 = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c4', trigger_event: 'pd_advance_paid',
      source_service: 'test', event_date: '2025-09-22',
      payload_context: { period_start: '2025-09-22' },
    });
    void r1;
    expect(r2.enqueued).toBe(true);
  });
});

describe('FROI rejection cascade', () => {
  test('suppressPending for SROI rows when FROI rejected', async () => {
    await seedBaseline('c5');
    const r1 = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c5', trigger_event: 'pd_advance_paid',
      source_service: 'test', event_date: '2025-09-22',
      payload_context: {},
    });
    await wcisTrigger.suppressPending({
      claim_id: 'c5', trigger_event: 'pd_advance_paid', reason: 'FROI_REJECTED',
    });
    const { data: row } = await supabase.from('wcis_trigger_queue').select('*').eq('id', r1.trigger_queue_id).single();
    expect(row.status).toBe('suppressed');
    expect(row.suppression_reason).toBe('FROI_REJECTED');
  });
});

describe('Batch file sequence', () => {
  test('file_sequence monotonic across batches', async () => {
    await seedBaseline('c6');
    await supabase.from('wcis_transactions').insert({
      id: 't1', claim_id: 'c6', mtc_family: 'FROI', mtc_code: '00',
      mtc_date: '2025-06-15', environment: 'production',
      payload: {}, payload_hash: 'a', adapter_used: 'stub', status: 'generated',
    });
    await wcisTx.batchAndTransmit('production');

    await supabase.from('wcis_transactions').insert({
      id: 't2', claim_id: 'c6', mtc_family: 'FROI', mtc_code: '02',
      mtc_date: '2025-07-01', environment: 'production',
      payload: {}, payload_hash: 'b', adapter_used: 'stub', status: 'generated',
    });
    await wcisTx.batchAndTransmit('production');

    const { data } = await supabase.from('wcis_transmissions').select('*');
    const seqs = data.map(r => r.file_sequence).sort();
    expect(seqs).toEqual([1, 2]);
  });
});

describe('Environment separation', () => {
  test('production batch does not touch test transactions', async () => {
    await seedBaseline('c7');
    await supabase.from('wcis_transactions').insert({
      id: 't1', claim_id: 'c7', mtc_family: 'FROI', mtc_code: '00',
      mtc_date: '2025-06-15', environment: 'test',
      payload: {}, payload_hash: 'a', adapter_used: 'stub', status: 'generated',
    });
    const r = await wcisTx.batchAndTransmit('production');
    expect(r.transactions_sent).toBe(0);
    const { data } = await supabase.from('wcis_transactions').select('*').eq('id', 't1').single();
    expect(data.status).toBe('generated');
  });
});

describe('Full pipeline end-to-end', () => {
  test('enqueue → build → batch → ack for single FROI 00', async () => {
    await seedBaseline('c8', false); // not yet accepted
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c8', trigger_event: 'claim_created',
      source_service: 'test', event_date: '2025-06-16',
    });
    const txn = await wcisPayload.buildPayload(r.trigger_queue_id);
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    await wcisTx.batchAndTransmit('production');
    const { data: tsms } = await supabase.from('wcis_transmissions').select('*');
    for (const t of tsms) {
      await supabase.from('wcis_transmissions').update({ transmitted_at: past }).eq('id', t.id);
    }
    await supabase.from('wcis_transactions').update({ transmitted_at: past }).eq('id', txn.id);
    const ackRes = await wcisTx.pollAcksForEnvironment('production');
    expect(ackRes.applied).toBeGreaterThan(0);

    const { data: state } = await supabase.from('wcis_claim_state').select('*').eq('claim_id', 'c8').single();
    expect(state.jcn).toMatch(/^STUB-\d{4}-\d{6}$/);
  });
});
