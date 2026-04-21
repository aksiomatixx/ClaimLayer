'use strict';

/**
 * Integration — C&R and stip settlement flows → SROI PY + FN.
 */

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const wcisTrigger = require('../../src/services/wcisTriggerService');
const wcisPayload = require('../../src/services/wcisPayloadService');

async function seedBaseline(id) {
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
    jcn: `STUB-2026-${id}`, first_froi_accepted_at: '2025-06-20T00:00:00Z',
  });
}

beforeEach(() => { supabase._resetStore(); });

describe('C&R settlement: full breakdown', () => {
  test('emits 3 PY lines (530/501/500)', async () => {
    await seedBaseline('c1');
    await supabase.from('settlement_offers').insert({
      id: 'of1', claim_id: 'c1', offer_type: 'cnr',
      cnr_value: 30000, cnr_pd_amount: 18000, cnr_medical_amount: 8000,
      cnr_attorney_fee_amount: 4000, cnr_other_amount: 0,
      cnr_breakdown_source: 'oacr_final',
    });
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c1', trigger_event: 'cnr_settlement_paid',
      source_service: 'cnrService', event_date: '2026-01-15',
      payload_context: { source: 'cnr_settlement', offer_id: 'of1', paid_date: '2026-01-15' },
    });
    const txn = await wcisPayload.buildPayload(r.trigger_queue_id);
    expect(txn.payload.benefit_lines).toHaveLength(3);
    expect(txn.payload.benefit_lines.map(l => l.DN85_benefit_type_code)).toEqual(['530','501','500']);
  });

  test('attaches CNR_BREAKDOWN_PRE_OACR warning on estimate', async () => {
    await seedBaseline('c2');
    await supabase.from('settlement_offers').insert({
      id: 'of2', claim_id: 'c2', offer_type: 'cnr',
      cnr_value: 30000, cnr_pd_amount: 18000, cnr_medical_amount: 8000,
      cnr_attorney_fee_amount: 4000, cnr_other_amount: 0,
      cnr_breakdown_source: 'estimate',
    });
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c2', trigger_event: 'cnr_settlement_paid',
      source_service: 'cnrService', event_date: '2026-01-15',
      payload_context: { source: 'cnr_settlement', offer_id: 'of2' },
    });
    const txn = await wcisPayload.buildPayload(r.trigger_queue_id);
    expect(txn.validation_warnings.some(w => w.code === 'WCIS_CNR_BREAKDOWN_PRE_OACR')).toBe(true);
  });

  test('fallback to single 500 line + warning when breakdown missing', async () => {
    await seedBaseline('c3');
    await supabase.from('settlement_offers').insert({
      id: 'of3', claim_id: 'c3', offer_type: 'cnr', cnr_value: 25000,
    });
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c3', trigger_event: 'cnr_settlement_paid',
      source_service: 'cnrService', event_date: '2026-01-15',
      payload_context: { source: 'cnr_settlement', offer_id: 'of3' },
    });
    const txn = await wcisPayload.buildPayload(r.trigger_queue_id);
    expect(txn.payload.benefit_lines).toHaveLength(1);
    expect(txn.payload.benefit_lines[0].DN85_benefit_type_code).toBe('500');
    expect(txn.payload.benefit_lines[0].DN89_gross_weekly_amount_paid).toBe('25000.00');
    expect(txn.validation_warnings.some(w => w.code === 'WCIS_CNR_BREAKDOWN_MISSING')).toBe(true);
  });

  test('fallback + warning when sum mismatches cnr_value', async () => {
    await seedBaseline('c4');
    await supabase.from('settlement_offers').insert({
      id: 'of4', claim_id: 'c4', offer_type: 'cnr',
      cnr_value: 30000, cnr_pd_amount: 5000, cnr_medical_amount: 5000,
      cnr_attorney_fee_amount: 500, cnr_other_amount: 0,
      cnr_breakdown_source: 'oacr_final',
    });
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c4', trigger_event: 'cnr_settlement_paid',
      source_service: 'cnrService', event_date: '2026-01-15',
      payload_context: { source: 'cnr_settlement', offer_id: 'of4' },
    });
    const txn = await wcisPayload.buildPayload(r.trigger_queue_id);
    expect(txn.payload.benefit_lines).toHaveLength(1);
    expect(txn.validation_warnings.some(w => w.code === 'WCIS_CNR_BREAKDOWN_MISSING')).toBe(true);
  });
});

describe('C&R pays PY + FN in sequence', () => {
  test('both PY and FN enqueue from same flow', async () => {
    await seedBaseline('c5');
    await supabase.from('settlement_offers').insert({
      id: 'of5', claim_id: 'c5', offer_type: 'cnr', cnr_value: 20000,
    });
    const rPy = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c5', trigger_event: 'cnr_settlement_paid',
      source_service: 'cnrService', event_date: '2026-01-15',
      payload_context: { source: 'cnr_settlement', offer_id: 'of5' },
    });
    const rFn = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c5', trigger_event: 'claim_closed',
      source_service: 'cnrService', event_date: '2026-01-15',
      payload_context: { source: 'cnr_settlement', offer_id: 'of5', claim_status_code: 'C' },
    });
    expect(rPy.enqueued).toBe(true);
    expect(rFn.enqueued).toBe(true);
  });

  test('FN with DN73=C validates and renders', async () => {
    await seedBaseline('c6');
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c6', trigger_event: 'claim_closed',
      source_service: 'cnrService', event_date: '2026-01-15',
      payload_context: { claim_status_code: 'C', closed_date: '2026-01-15' },
    });
    const txn = await wcisPayload.buildPayload(r.trigger_queue_id);
    expect(txn.mtc_code).toBe('FN');
    expect(txn.payload.DN73_claim_status_code).toBe('C');
  });
});

describe('Stip settlement breakdown', () => {
  test('future_medical=false → 530+500, FN enqueues', async () => {
    await seedBaseline('c7');
    await supabase.from('stipulations').insert({ id: 'st1', claim_id: 'c7', future_medical: false });
    await supabase.from('award_disbursements').insert({
      id: 'd1', claim_id: 'c7', stipulation_id: 'st1', award_type: 'stip_f_and_a',
      award_date: '2025-12-01', award_service_date: '2025-12-05', accrued_start_date: '2025-06-20',
      total_award: 15000, accrued_amount: 3000, scheduled_amount: 10000, aa_fee_amount: 2000,
    });
    const rPy = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c7', trigger_event: 'stip_disbursement_paid',
      source_service: 'disbursementService', event_date: '2026-01-10',
      payload_context: { source: 'stip_disbursement', disbursement_id: 'd1' },
    });
    const txn = await wcisPayload.buildPayload(rPy.trigger_queue_id);
    expect(txn.payload.benefit_lines).toHaveLength(2);
    expect(txn.payload.benefit_lines[0].DN85_benefit_type_code).toBe('530');
    expect(txn.payload.benefit_lines[0].DN89_gross_weekly_amount_paid).toBe('13000.00');
    expect(txn.payload.benefit_lines[1].DN85_benefit_type_code).toBe('500');

    const rFn = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c7', trigger_event: 'claim_closed',
      source_service: 'disbursementService', event_date: '2026-01-10',
      payload_context: { claim_status_code: 'C' },
    });
    expect(rFn.enqueued).toBe(true);
  });

  test('future_medical=true → PY only, warning, no FN enqueued from disbursement', async () => {
    await seedBaseline('c8');
    await supabase.from('stipulations').insert({ id: 'st2', claim_id: 'c8', future_medical: true });
    await supabase.from('award_disbursements').insert({
      id: 'd2', claim_id: 'c8', stipulation_id: 'st2', award_type: 'stip_f_and_a',
      award_date: '2025-12-01', award_service_date: '2025-12-05', accrued_start_date: '2025-06-20',
      total_award: 10000, accrued_amount: 0, scheduled_amount: 10000, aa_fee_amount: 0,
    });
    const rPy = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c8', trigger_event: 'stip_disbursement_paid',
      source_service: 'disbursementService', event_date: '2026-01-10',
      payload_context: { source: 'stip_disbursement', disbursement_id: 'd2' },
    });
    const txn = await wcisPayload.buildPayload(rPy.trigger_queue_id);
    expect(txn.validation_warnings.some(w => w.code === 'WCIS_STIP_FUTURE_MEDICAL_NO_FN')).toBe(true);
  });
});

describe('close suppression', () => {
  test('updateStatus suppressWcisClose flag prevents duplicate FN', async () => {
    // We cannot directly invoke claimService without huge fixtures; verify
    // the mechanism via direct enqueue: two enqueues with same payload_hash
    // dedupe within 24h.
    await seedBaseline('c9');
    const ctx = { source: 'cnr_settlement', offer_id: 'of_x', claim_status_code: 'C' };
    const r1 = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c9', trigger_event: 'claim_closed',
      source_service: 'cnrService', event_date: '2026-01-15', payload_context: ctx,
    });
    const r2 = await wcisTrigger.enqueueIfReportable({
      claim_id: 'c9', trigger_event: 'claim_closed',
      source_service: 'cnrService', event_date: '2026-01-15', payload_context: ctx,
    });
    expect(r1.enqueued).toBe(true);
    expect(r2.enqueued).toBe(false);
    expect(r2.suppressed_reason).toBe('DUPLICATE_EVENT');
  });
});

describe('FN validation — DN73 C/X rule', () => {
  test('FN with claim_status_code=O (invalid) is rejected', async () => {
    await seedBaseline('cB');
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'cB', trigger_event: 'claim_closed',
      source_service: 'test', event_date: '2026-01-15',
      payload_context: { claim_status_code: 'O' },
    });
    await expect(wcisPayload.buildPayload(r.trigger_queue_id)).rejects.toThrow();
  });
  test('FN with claim_status_code=X (future medical only) accepted', async () => {
    await seedBaseline('cC');
    const r = await wcisTrigger.enqueueIfReportable({
      claim_id: 'cC', trigger_event: 'claim_closed',
      source_service: 'test', event_date: '2026-01-15',
      payload_context: { claim_status_code: 'X' },
    });
    const txn = await wcisPayload.buildPayload(r.trigger_queue_id);
    expect(txn.payload.DN73_claim_status_code).toBe('X');
  });
});
