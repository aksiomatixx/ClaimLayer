'use strict';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const wcis = require('../../src/services/wcisTriggerService');
const { REPORTABLE_BENEFIT_CODES } = require('../../src/constants/wcisConstants');

async function seedClaim(overrides = {}) {
  const claimId = `c_trig_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await supabase.from('claims').insert({
    id: claimId,
    claim_number: 'HHW-2026-TRIG',
    employer_id: 'employer-1',
    date_of_injury: '2025-06-15',
    wcis_enabled: true,
    status: 'active_medical',
    ...overrides,
  });
  return claimId;
}

beforeEach(() => {
  supabase._resetStore();
});

describe('resolveMtc', () => {
  test('returns FROI 00 for claim_created', () => {
    expect(wcis.resolveMtc({ trigger_event: 'claim_created' })).toMatchObject({
      mtc_family: 'FROI', mtc_code: '00', deadline_type: 'business_days_10', wired: true,
    });
  });
  test('returns SROI PY for cnr_settlement_paid', () => {
    expect(wcis.resolveMtc({ trigger_event: 'cnr_settlement_paid' }).mtc_code).toBe('PY');
  });
  test('returns FROI 04 for claim_denied_no_payment', () => {
    expect(wcis.resolveMtc({ trigger_event: 'claim_denied_no_payment' }).mtc_code).toBe('04');
  });
  test('returns SROI 04 for claim_denied_after_payment', () => {
    expect(wcis.resolveMtc({ trigger_event: 'claim_denied_after_payment' }).mtc_code).toBe('04');
  });
  test('returns SROI FN for claim_closed', () => {
    expect(wcis.resolveMtc({ trigger_event: 'claim_closed' }).mtc_code).toBe('FN');
  });
  test('returns SROI CB for pd_advance_benefit_transition', () => {
    expect(wcis.resolveMtc({ trigger_event: 'pd_advance_benefit_transition' }).mtc_code).toBe('CB');
  });
  test('returns SROI RB for pd_advance_after_suspended_td', () => {
    expect(wcis.resolveMtc({ trigger_event: 'pd_advance_after_suspended_td' }).mtc_code).toBe('RB');
  });
  test('returns SROI IP for pd_first_advance_as_initial', () => {
    expect(wcis.resolveMtc({ trigger_event: 'pd_first_advance_as_initial' }).mtc_code).toBe('IP');
  });
  test('returns SROI PY for pd_advance_paid', () => {
    expect(wcis.resolveMtc({ trigger_event: 'pd_advance_paid' }).mtc_code).toBe('PY');
  });
  test('returns SROI 4P for specific_benefit_denied', () => {
    expect(wcis.resolveMtc({ trigger_event: 'specific_benefit_denied' }).mtc_code).toBe('4P');
  });
  test('returns SROI CO 60d for correction_after_te', () => {
    expect(wcis.resolveMtc({ trigger_event: 'correction_after_te' })).toMatchObject({
      mtc_code: 'CO', deadline_type: 'calendar_days_60',
    });
  });
  test('marks TD-family as not wired', () => {
    expect(wcis.resolveMtc({ trigger_event: 'td_rate_changed' }).wired).toBe(false);
    expect(wcis.resolveMtc({ trigger_event: 'td_first_payment' }).wired).toBe(false);
    expect(wcis.resolveMtc({ trigger_event: 'td_suspended_rtw' }).wired).toBe(false);
    expect(wcis.resolveMtc({ trigger_event: 'salary_continuation' }).wired).toBe(false);
  });
  test('marks representation_changed as not wired', () => {
    expect(wcis.resolveMtc({ trigger_event: 'representation_changed' }).wired).toBe(false);
  });
  test('throws on unknown trigger_event', () => {
    expect(() => wcis.resolveMtc({ trigger_event: 'not_a_real_event' })).toThrow(/unknown/);
  });
});

describe('checkWcisEnabled', () => {
  test('returns true for claim with wcis_enabled=true', async () => {
    const id = await seedClaim({ wcis_enabled: true });
    expect(await wcis.checkWcisEnabled(id)).toBe(true);
  });
  test('returns false for claim with wcis_enabled=false', async () => {
    const id = await seedClaim({ wcis_enabled: false });
    expect(await wcis.checkWcisEnabled(id)).toBe(false);
  });
  test('returns false for missing claim', async () => {
    expect(await wcis.checkWcisEnabled('no-such-claim')).toBe(false);
  });
  test('returns true when wcis_enabled is null/undefined (default-eligible)', async () => {
    const id = await seedClaim({ wcis_enabled: null });
    expect(await wcis.checkWcisEnabled(id)).toBe(true);
  });
});

describe('enqueueIfReportable — suppression rules', () => {
  test('suppresses when wcis_enabled=false', async () => {
    const id = await seedClaim({ wcis_enabled: false });
    const r = await wcis.enqueueIfReportable({
      claim_id: id, trigger_event: 'claim_created', source_service: 'test',
      event_date: '2025-06-15',
    });
    expect(r.enqueued).toBe(false);
    expect(r.suppressed_reason).toBe('WCIS_DISABLED_ON_CLAIM');
  });

  test('suppresses FROI when DOI before 2000-03-01', async () => {
    const id = await seedClaim({ date_of_injury: '2000-02-01' });
    const r = await wcis.enqueueIfReportable({
      claim_id: id, trigger_event: 'claim_created', source_service: 'test',
      event_date: '2000-02-01',
    });
    expect(r.suppressed_reason).toBe('DOI_BEFORE_WCIS_MANDATE');
  });

  test('allows FROI when DOI on/after 2000-03-01', async () => {
    const id = await seedClaim({ date_of_injury: '2000-03-01' });
    const r = await wcis.enqueueIfReportable({
      claim_id: id, trigger_event: 'claim_created', source_service: 'test',
      event_date: '2000-03-01',
    });
    expect(r.enqueued).toBe(true);
  });

  test('suppresses SROI when DOI before 2000-07-01', async () => {
    const id = await seedClaim({ date_of_injury: '2000-06-30' });
    const r = await wcis.enqueueIfReportable({
      claim_id: id, trigger_event: 'pd_advance_paid', source_service: 'test',
      event_date: '2020-01-01',
    });
    expect(r.suppressed_reason).toBe('DOI_BEFORE_WCIS_MANDATE');
  });

  test('reroutes FROI 04 to SROI 04 when FROI 00 already accepted', async () => {
    const id = await seedClaim();
    await supabase.from('wcis_claim_state').insert({
      claim_id: id,
      claim_admin_claim_number: 'HHW-TRIG',
      first_froi_accepted_at: new Date().toISOString(),
    });
    const r = await wcis.enqueueIfReportable({
      claim_id: id, trigger_event: 'claim_denied_no_payment',
      source_service: 'test', event_date: '2025-07-01',
    });
    expect(r.enqueued).toBe(true);
    const { data: rows } = await supabase.from('wcis_trigger_queue').select('*').eq('id', r.trigger_queue_id);
    expect(rows[0].mtc_family).toBe('SROI');
    expect(rows[0].mtc_code).toBe('04');
  });

  test('throws on missing required args', async () => {
    await expect(wcis.enqueueIfReportable({})).rejects.toThrow(/claim_id/);
    await expect(wcis.enqueueIfReportable({ claim_id: 'x' })).rejects.toThrow(/trigger_event/);
    await expect(wcis.enqueueIfReportable({
      claim_id: 'x', trigger_event: 'claim_created',
    })).rejects.toThrow(/source_service/);
  });

  test('suppresses duplicate within 24h', async () => {
    const id = await seedClaim();
    const r1 = await wcis.enqueueIfReportable({
      claim_id: id, trigger_event: 'pd_advance_paid',
      source_service: 'test', event_date: '2025-07-01',
      payload_context: { weekStart: '2025-07-01' },
    });
    expect(r1.enqueued).toBe(true);
    const r2 = await wcis.enqueueIfReportable({
      claim_id: id, trigger_event: 'pd_advance_paid',
      source_service: 'test', event_date: '2025-07-01',
      payload_context: { weekStart: '2025-07-01' },
    });
    expect(r2.enqueued).toBe(false);
    expect(r2.suppressed_reason).toBe('DUPLICATE_EVENT');
  });

  test('allows non-duplicate (different payload) same day', async () => {
    const id = await seedClaim();
    const r1 = await wcis.enqueueIfReportable({
      claim_id: id, trigger_event: 'pd_advance_paid',
      source_service: 'test', event_date: '2025-07-01',
      payload_context: { weekStart: '2025-07-01' },
    });
    const r2 = await wcis.enqueueIfReportable({
      claim_id: id, trigger_event: 'pd_advance_paid',
      source_service: 'test', event_date: '2025-07-08',
      payload_context: { weekStart: '2025-07-08' },
    });
    expect(r1.enqueued).toBe(true);
    expect(r2.enqueued).toBe(true);
  });

  test('suppresses CB when to_benefit_code already open', async () => {
    const id = await seedClaim();
    await supabase.from('wcis_claim_state').insert({
      claim_id: id,
      claim_admin_claim_number: 'x',
      open_benefit_codes: [REPORTABLE_BENEFIT_CODES.PD_SCHEDULED],
    });
    const r = await wcis.enqueueIfReportable({
      claim_id: id, trigger_event: 'pd_advance_benefit_transition',
      source_service: 'test', event_date: '2025-07-01',
      payload_context: {
        from_benefit_code: REPORTABLE_BENEFIT_CODES.TT,
        to_benefit_code: REPORTABLE_BENEFIT_CODES.PD_SCHEDULED,
      },
    });
    expect(r.suppressed_reason).toBe('BENEFIT_ALREADY_OPEN');
  });

  test('computes business_days_10 deadline', async () => {
    const id = await seedClaim();
    const r = await wcis.enqueueIfReportable({
      claim_id: id, trigger_event: 'claim_created',
      source_service: 'test', event_date: '2025-06-02', // Monday
    });
    expect(r.enqueued).toBe(true);
    const { data: row } = await supabase
      .from('wcis_trigger_queue').select('*').eq('id', r.trigger_queue_id).single();
    expect(row.deadline_date).toBe('2025-06-16'); // 10 bd later
  });

  test('computes calendar_days_60 deadline for correction_after_te', async () => {
    const id = await seedClaim();
    const r = await wcis.enqueueIfReportable({
      claim_id: id, trigger_event: 'correction_after_te',
      source_service: 'test', event_date: '2025-06-01',
    });
    const { data: row } = await supabase
      .from('wcis_trigger_queue').select('*').eq('id', r.trigger_queue_id).single();
    expect(row.deadline_date).toBe('2025-07-31');
  });

  test('writes trigger_event, mtc_family, mtc_code on row', async () => {
    const id = await seedClaim();
    const r = await wcis.enqueueIfReportable({
      claim_id: id, trigger_event: 'cnr_settlement_paid',
      source_service: 'cnrService', event_date: '2025-06-01',
      payload_context: { offer_id: 'of_1', source: 'cnr_settlement' },
    });
    const { data: row } = await supabase
      .from('wcis_trigger_queue').select('*').eq('id', r.trigger_queue_id).single();
    expect(row).toMatchObject({
      trigger_event: 'cnr_settlement_paid', mtc_family: 'SROI', mtc_code: 'PY',
      source_service: 'cnrService',
    });
  });
});

describe('suppressPending', () => {
  test('marks matching pending rows as suppressed', async () => {
    const id = await seedClaim();
    const r = await wcis.enqueueIfReportable({
      claim_id: id, trigger_event: 'claim_created',
      source_service: 'test', event_date: '2025-07-01',
    });
    expect(r.enqueued).toBe(true);
    await wcis.suppressPending({
      claim_id: id, trigger_event: 'claim_created', reason: 'TEST_REASON',
    });
    const { data: row } = await supabase
      .from('wcis_trigger_queue').select('*').eq('id', r.trigger_queue_id).single();
    expect(row.status).toBe('suppressed');
    expect(row.suppression_reason).toBe('TEST_REASON');
  });
});

describe('_hashPayloadContext', () => {
  test('same input → same hash', () => {
    const h1 = wcis._hashPayloadContext({ a: 1, b: 2 });
    const h2 = wcis._hashPayloadContext({ a: 1, b: 2 });
    expect(h1).toBe(h2);
  });
  test('different input → different hash', () => {
    expect(wcis._hashPayloadContext({ a: 1 })).not.toBe(wcis._hashPayloadContext({ a: 2 }));
  });
  test('null/undefined collapses to empty object hash', () => {
    expect(wcis._hashPayloadContext(null)).toBe(wcis._hashPayloadContext({}));
    expect(wcis._hashPayloadContext(undefined)).toBe(wcis._hashPayloadContext({}));
  });
});

describe('_isBeforeWcisMandate', () => {
  test('FROI: true when DOI < 2000-03-01', () => {
    expect(wcis._isBeforeWcisMandate('FROI', '2000-02-28')).toBe(true);
    expect(wcis._isBeforeWcisMandate('FROI', '2000-03-01')).toBe(false);
  });
  test('SROI: true when DOI < 2000-07-01', () => {
    expect(wcis._isBeforeWcisMandate('SROI', '2000-06-30')).toBe(true);
    expect(wcis._isBeforeWcisMandate('SROI', '2000-07-01')).toBe(false);
  });
  test('returns false for missing DOI', () => {
    expect(wcis._isBeforeWcisMandate('FROI', null)).toBe(false);
    expect(wcis._isBeforeWcisMandate('FROI', undefined)).toBe(false);
  });
});
