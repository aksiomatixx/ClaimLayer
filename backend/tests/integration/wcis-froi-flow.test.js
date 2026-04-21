'use strict';

/**
 * Integration — FROI flow end-to-end via stubAdapter.
 *   - claim_created → FROI 00 queued → batched → stub ack → JCN stored
 *   - Denial before FROI 00 ack → FROI 04
 *   - Denial after FROI 00 accept → SROI 04 reroute
 *   - wcis_enabled=FALSE → no enqueue
 *   - DOI before 2000-03-01 → suppressed
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const wcisTrigger = require('../../src/services/wcisTriggerService');
const wcisPayload = require('../../src/services/wcisPayloadService');
const wcisTx      = require('../../src/services/wcisTransmissionService');

async function seedClaim(id, overrides = {}) {
  await supabase.from('claims').insert({
    id, claim_number: `HHW-2026-${id}`,
    employer_id: 'employer-1', employer_name: 'BrightCare',
    date_of_injury: '2025-06-15',
    employee: { first_name: 'Maria', last_name: 'Santos', ssn: '555114444' },
    insurer_fein: '123456789', claim_administrator_fein: '123456789',
    employer_fein: '123456789',
    wcis_enabled: true, aww: 750, td_rate: 500,
    body_part: 'Lumbar', injury_type: 'Sprain',
    ...overrides,
  });
  await supabase.from('employers').insert({
    id: 'employer-1', name: 'BrightCare', fein: '123456789', self_insured: false,
  });
}

beforeEach(() => { supabase._resetStore(); });

describe('FROI 00 happy path', () => {
  test('claim_created enqueue → build → batch → ack → JCN written', async () => {
    await seedClaim('c1');
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c1', trigger_event: 'claim_created',
      source_service: 'test', event_date: '2025-06-16',
      payload_context: { doi: '2025-06-15' },
    });
    expect(r.enqueued).toBe(true);

    const txn = await wcisPayload.buildPayload(r.trigger_queue_id);
    expect(txn.mtc_family).toBe('FROI');
    expect(txn.mtc_code).toBe('00');
    expect(txn.status).toBe('generated');

    const b = await wcisTx.batchAndTransmit('production');
    expect(b.transmissions_created).toBeGreaterThan(0);

    // Accelerate ack maturity
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const { data: tsms } = await supabase.from('wcis_transmissions').select('*');
    for (const t of tsms) {
      await supabase.from('wcis_transmissions').update({ transmitted_at: past }).eq('id', t.id);
    }
    await supabase.from('wcis_transactions').update({ transmitted_at: past }).eq('id', txn.id);

    await wcisTx.pollAcksForEnvironment('production');

    const { data: state } = await supabase.from('wcis_claim_state').select('*').eq('claim_id', 'c1').single();
    expect(state.jcn).toMatch(/^STUB-\d{4}-\d{6}$/);
    expect(state.first_froi_accepted_at).toBeTruthy();

    const { data: updatedTxn } = await supabase.from('wcis_transactions').select('*').eq('id', txn.id).single();
    expect(updatedTxn.status).toBe('accepted');
  });
});

describe('FROI 04 denial paths', () => {
  test('denial before FROI 00 accept → FROI 04 enqueue', async () => {
    await seedClaim('c2');
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c2', trigger_event: 'claim_denied_no_payment',
      source_service: 'test', event_date: '2025-07-01',
      payload_context: { denial_reason: 'course and scope' },
    });
    expect(r.enqueued).toBe(true);
    const { data: row } = await supabase.from('wcis_trigger_queue').select('*').eq('id', r.trigger_queue_id).single();
    expect(row.mtc_family).toBe('FROI');
    expect(row.mtc_code).toBe('04');
  });

  test('denial after FROI 00 accepted → SROI 04 reroute', async () => {
    await seedClaim('c3');
    await supabase.from('wcis_claim_state').insert({
      claim_id: 'c3', claim_admin_claim_number: 'HHW-2026-c3',
      first_froi_accepted_at: new Date().toISOString(),
    });
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c3', trigger_event: 'claim_denied_no_payment',
      source_service: 'test', event_date: '2025-08-01',
      payload_context: { denial_reason: 'post-accept investigation' },
    });
    expect(r.enqueued).toBe(true);
    const { data: row } = await supabase.from('wcis_trigger_queue').select('*').eq('id', r.trigger_queue_id).single();
    expect(row.mtc_family).toBe('SROI');
    expect(row.mtc_code).toBe('04');
  });
});

describe('FROI suppression paths', () => {
  test('wcis_enabled=false suppresses with reason', async () => {
    await seedClaim('c4', { wcis_enabled: false });
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c4', trigger_event: 'claim_created',
      source_service: 'test', event_date: '2025-06-16',
    });
    expect(r.enqueued).toBe(false);
    expect(r.suppressed_reason).toBe('WCIS_DISABLED_ON_CLAIM');
  });

  test('DOI before 2000-03-01 suppresses with reason', async () => {
    await seedClaim('c5', { date_of_injury: '1999-12-31' });
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c5', trigger_event: 'claim_created',
      source_service: 'test', event_date: '1999-12-31',
    });
    expect(r.enqueued).toBe(false);
    expect(r.suppressed_reason).toBe('DOI_BEFORE_WCIS_MANDATE');
  });
});

describe('FROI 00 validation + build', () => {
  test('builds payload with DN2=CA, DN15, employee demographics', async () => {
    await seedClaim('c6');
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c6', trigger_event: 'claim_created',
      source_service: 'test', event_date: '2025-06-16',
    });
    const txn = await wcisPayload.buildPayload(r.trigger_queue_id);
    expect(txn.payload.DN2_jurisdiction).toBe('CA');
    expect(txn.payload.DN15_claim_admin_claim_number).toBe('HHW-2026-c6');
    expect(txn.payload.DN42_employee_ssn).toBe('555114444');
    expect(txn.payload.DN43_employee_last_name).toBe('Santos');
  });

  test('renders IAIABC_R1 header', async () => {
    await seedClaim('c7');
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c7', trigger_event: 'claim_created',
      source_service: 'test', event_date: '2025-06-16',
    });
    const txn = await wcisPayload.buildPayload(r.trigger_queue_id);
    expect(txn.flatfile_rendered).toMatch(/^IAIABC_R1\|FROI\|00\|CA\|/);
  });

  test('duplicate claim_created within 24h is suppressed', async () => {
    await seedClaim('c8');
    const ctx = { doi: '2025-06-15', employer_id: 'employer-1' };
    const r1 = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c8', trigger_event: 'claim_created',
      source_service: 'test', event_date: '2025-06-16',
      payload_context: ctx,
    });
    const r2 = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c8', trigger_event: 'claim_created',
      source_service: 'test', event_date: '2025-06-16',
      payload_context: ctx,
    });
    expect(r1.enqueued).toBe(true);
    expect(r2.suppressed_reason).toBe('DUPLICATE_EVENT');
  });
});

describe('batching: 2 FROI into one transmission', () => {
  test('multiple enqueued claims batch into single transmission', async () => {
    await seedClaim('cA');
    await seedClaim('cB');
    const r1 = await wcisTrigger.enqueueIfReportable({
      claim_id: 'cA', trigger_event: 'claim_created',
      source_service: 'test', event_date: '2025-06-16',
    });
    const r2 = await wcisTrigger.enqueueIfReportable({
      claim_id: 'cB', trigger_event: 'claim_created',
      source_service: 'test', event_date: '2025-06-16',
    });
    await wcisPayload.buildPayload(r1.trigger_queue_id);
    await wcisPayload.buildPayload(r2.trigger_queue_id);

    const b = await wcisTx.batchAndTransmit('production');
    expect(b.transmissions_created).toBe(1);
    expect(b.transactions_sent).toBe(2);
  });
});
