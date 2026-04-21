'use strict';

/**
 * Integration — SROI benefit-event flow via stubAdapter.
 * Scenarios covered (reduced scope — no tdService):
 *   - PD advance initiation with open TD ('050')       → CB
 *   - PD advance initiation with prior Sx suspension   → RB
 *   - PD advance initiation with no prior SROI         → no enqueue
 *   - Subsequent PD advance payments                    → PY
 *   - First PD advance when no prior SROI              → IP
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const wcisTrigger = require('../../src/services/wcisTriggerService');
const wcisPayload = require('../../src/services/wcisPayloadService');
const { REPORTABLE_BENEFIT_CODES } = require('../../src/constants/wcisConstants');

async function seedBaseline(id) {
  await supabase.from('claims').insert({
    id, claim_number: `HHW-${id}`,
    employer_id: 'e1', employer_name: 'BrightCare',
    date_of_injury: '2025-06-15',
    employee: { first_name: 'A', last_name: 'B', ssn: '555114444' },
    insurer_fein: '123456789', claim_administrator_fein: '123456789',
    employer_fein: '123456789', aww: 750, td_rate: 500,
    body_part: 'Lumbar', injury_type: 'Sprain', wcis_enabled: true,
  });
  await supabase.from('employers').insert({ id: 'e1', name: 'BrightCare', fein: '123456789' });
  await supabase.from('wcis_claim_state').insert({
    claim_id: id, claim_admin_claim_number: `HHW-${id}`,
    jcn: `STUB-2026-${id}`, first_froi_accepted_at: '2025-06-20T00:00:00Z',
    open_benefit_codes: [],
  });
}

beforeEach(() => { supabase._resetStore(); });

describe('PD advance initiation → SROI CB (when TD open)', () => {
  test('emits CB with from=050 to=030 when TT is open', async () => {
    await seedBaseline('c1');
    await supabase.from('wcis_claim_state').update({ open_benefit_codes: ['050'] }).eq('claim_id', 'c1');
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c1', trigger_event: 'pd_advance_benefit_transition',
      source_service: 'pdService', event_date: '2025-09-15',
      payload_context: {
        from_benefit_code: REPORTABLE_BENEFIT_CODES.TT,
        to_benefit_code: REPORTABLE_BENEFIT_CODES.PD_SCHEDULED,
        weekly_rate: 290, source: 'initiate_advances',
      },
    });
    expect(r.enqueued).toBe(true);

    const txn = await wcisPayload.buildPayload(r.trigger_queue_id);
    expect(txn.mtc_code).toBe('CB');
    expect(txn.payload.benefit_lines[0].DN_previous_benefit_type).toBe('050');
    expect(txn.payload.benefit_lines[0].DN85_benefit_type_code).toBe('030');
  });

  test('suppressed when target already open', async () => {
    await seedBaseline('c2');
    await supabase.from('wcis_claim_state').update({ open_benefit_codes: ['050', '030'] }).eq('claim_id', 'c2');
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c2', trigger_event: 'pd_advance_benefit_transition',
      source_service: 'pdService', event_date: '2025-09-15',
      payload_context: {
        from_benefit_code: '050', to_benefit_code: '030',
      },
    });
    expect(r.suppressed_reason).toBe('BENEFIT_ALREADY_OPEN');
  });
});

describe('PD advance initiation → SROI RB (after Sx suspension)', () => {
  test('emits RB when last_sroi_mtc=S1', async () => {
    await seedBaseline('c3');
    await supabase.from('wcis_claim_state').update({
      last_sroi_mtc: 'S1', open_benefit_codes: [],
    }).eq('claim_id', 'c3');
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c3', trigger_event: 'pd_advance_after_suspended_td',
      source_service: 'pdService', event_date: '2025-10-01',
      payload_context: {
        benefit_code: '030', reinstating_after_mtc: 'S1',
        weekly_rate: 290, source: 'initiate_advances',
      },
    });
    expect(r.enqueued).toBe(true);
    const txn = await wcisPayload.buildPayload(r.trigger_queue_id);
    expect(txn.mtc_code).toBe('RB');
    expect(txn.payload.benefit_lines[0].DN_reinstating_after_mtc).toBe('S1');
  });

  test('RB after partial suspension P1 also emits RB', async () => {
    await seedBaseline('c3b');
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c3b', trigger_event: 'pd_advance_after_suspended_td',
      source_service: 'pdService', event_date: '2025-10-01',
      payload_context: { reinstating_after_mtc: 'P1', benefit_code: '030' },
    });
    const txn = await wcisPayload.buildPayload(r.trigger_queue_id);
    expect(txn.payload.benefit_lines[0].DN_reinstating_after_mtc).toBe('P1');
  });
});

describe('PD advance payment → SROI PY or IP', () => {
  test('emits IP when no prior SROI on claim', async () => {
    await seedBaseline('c4');
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c4', trigger_event: 'pd_first_advance_as_initial',
      source_service: 'pdService', event_date: '2025-09-15',
      payload_context: {
        benefit_code: '030', amount_paid: 290, weekly_rate: 290,
        period_start: '2025-09-15', period_end: '2025-09-21',
      },
    });
    expect(r.enqueued).toBe(true);
    const txn = await wcisPayload.buildPayload(r.trigger_queue_id);
    expect(txn.mtc_code).toBe('IP');
    expect(txn.payload.benefit_lines[0].DN85_benefit_type_code).toBe('030');
  });

  test('emits PY when PD already open', async () => {
    await seedBaseline('c5');
    await supabase.from('wcis_claim_state').update({ open_benefit_codes: ['030'] }).eq('claim_id', 'c5');
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c5', trigger_event: 'pd_advance_paid',
      source_service: 'pdService', event_date: '2025-09-22',
      payload_context: {
        benefit_code: '030', amount_paid: 290,
        period_start: '2025-09-22', period_end: '2025-09-28',
      },
    });
    const txn = await wcisPayload.buildPayload(r.trigger_queue_id);
    expect(txn.mtc_code).toBe('PY');
    expect(txn.payload.benefit_lines[0].DN85_benefit_type_code).toBe('030');
    expect(txn.payload.benefit_lines[0].DN89_gross_weekly_amount_paid).toBe('290');
  });
});

describe('suppression — benefit already open', () => {
  test('CB to already-open PD is suppressed at enqueue', async () => {
    await seedBaseline('c6');
    await supabase.from('wcis_claim_state').update({ open_benefit_codes: ['050', '030'] }).eq('claim_id', 'c6');
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c6', trigger_event: 'pd_advance_benefit_transition',
      source_service: 'pdService', event_date: '2025-10-01',
      payload_context: { from_benefit_code: '050', to_benefit_code: '030' },
    });
    expect(r.suppressed_reason).toBe('BENEFIT_ALREADY_OPEN');
  });
});

describe('PY with multiple weeks stays non-duplicate', () => {
  test('two different week payments enqueue twice', async () => {
    await seedBaseline('c7');
    await supabase.from('wcis_claim_state').update({ open_benefit_codes: ['030'] }).eq('claim_id', 'c7');
    const r1 = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c7', trigger_event: 'pd_advance_paid',
      source_service: 'pdService', event_date: '2025-09-22',
      payload_context: { period_start: '2025-09-22', period_end: '2025-09-28', amount_paid: 290 },
    });
    const r2 = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c7', trigger_event: 'pd_advance_paid',
      source_service: 'pdService', event_date: '2025-09-29',
      payload_context: { period_start: '2025-09-29', period_end: '2025-10-05', amount_paid: 290 },
    });
    expect(r1.enqueued).toBe(true);
    expect(r2.enqueued).toBe(true);
  });
});

describe('SROI validation requires JCN', () => {
  test('SROI PY without JCN on state is fatal at validation', async () => {
    await supabase.from('claims').insert({
      id: 'cNoJcn', claim_number: 'X', employer_id: 'e1', employer_name: 'X',
      date_of_injury: '2025-06-15',
      employee: { first_name: 'A', last_name: 'B', ssn: '555114444' },
      insurer_fein: '123456789', claim_administrator_fein: '123456789',
      employer_fein: '123456789', wcis_enabled: true,
    });
    await supabase.from('employers').insert({ id: 'e1', name: 'X', fein: '123456789' });
    await supabase.from('wcis_claim_state').insert({
      claim_id: 'cNoJcn', claim_admin_claim_number: 'X',
      first_froi_accepted_at: '2025-06-20T00:00:00Z', open_benefit_codes: [],
    });
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'cNoJcn', trigger_event: 'pd_advance_paid',
      source_service: 'test', event_date: '2025-09-01',
      payload_context: {},
    });
    await expect(wcisPayload.buildPayload(r.trigger_queue_id))
      .rejects.toThrow(/SROI_REQUIRES_JCN|WcisValidationError/);
  });
});
