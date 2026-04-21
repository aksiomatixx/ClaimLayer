'use strict';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const svc = require('../../src/services/wcisPayloadService');

async function seedClaim(id, overrides = {}) {
  await supabase.from('claims').insert({
    id, claim_number: 'HHW-2026-ASM',
    employer_id: 'employer-1', employer_name: 'BrightCare',
    date_of_injury: '2025-06-15', body_part: 'Lumbar Spine',
    injury_type: 'Sprain',
    insurer_fein: '111111111',
    claim_administrator_fein: '111111111',
    employer_fein: '111111111',
    employee: { first_name: 'Maria', last_name: 'Santos', ssn: '555114444', dob: '1985-01-01' },
    aww: 750, td_rate: 500, ...overrides,
  });
  await supabase.from('employers').insert({
    id: 'employer-1', name: 'BrightCare', insurer_fein: '111111111', fein: '111111111', self_insured: false,
  });
}

beforeEach(() => { supabase._resetStore(); });

describe('_buildBasePayload', () => {
  test('populates jurisdiction + DN15 + employee + employer', async () => {
    await seedClaim('c1');
    const base = await svc._buildBasePayload('c1', 'production');
    expect(base.DN2_jurisdiction).toBe('CA');
    expect(base.DN15_claim_admin_claim_number).toBe('HHW-2026-ASM');
    expect(base.DN43_employee_last_name).toBe('Santos');
    expect(base.DN44_employee_first_name).toBe('Maria');
    expect(base.DN186_employer_name).toBe('BrightCare');
    expect(base.DN31_date_of_injury).toBe('2025-06-15');
  });
  test('uses claim-level FEIN override when present', async () => {
    await seedClaim('c2', { insurer_fein: '999999999' });
    const base = await svc._buildBasePayload('c2', 'production');
    expect(base.DN6_insurer_fein).toBe('999999999');
  });
  test('falls back to employer FEIN when claim has none', async () => {
    await seedClaim('c3', { insurer_fein: null, claim_administrator_fein: null });
    const base = await svc._buildBasePayload('c3', 'production');
    expect(base.DN6_insurer_fein).toBe('111111111');
  });
});

describe('FROI assemblers', () => {
  beforeEach(async () => { await seedClaim('c1'); });

  test('_assembleFroi00 emits mtc_code=00', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleFroi00(base, { event_date: '2025-06-16', payload_context: {} });
    expect(p._mtc_family).toBe('FROI');
    expect(p._mtc_code).toBe('00');
    expect(p.DN41_date_claim_administrator_had_knowledge).toBe('2025-06-16');
  });
  test('_assembleFroi04 emits denial reason', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleFroi04(base,
      { event_date: '2025-06-20', payload_context: { denial_reason: 'not in course and scope' } });
    expect(p._mtc_code).toBe('04');
    expect(p.DN290_denial_reason_narrative).toBe('not in course and scope');
  });
  test('_assembleFroiAu emits AU with original insurer fein', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleFroiAu(base, {
      event_date: '2025-06-15',
      payload_context: { original_insurer_fein: '222222222' },
    });
    expect(p._mtc_code).toBe('AU');
    expect(p.DN258_acquired_claim_original_insurer_fein).toBe('222222222');
  });
  test('_assembleFroi01 emits cancel reason', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleFroi01(base, { payload_context: { cancel_reason: 'dup' } });
    expect(p._mtc_code).toBe('01');
    expect(p.DN82_cancel_reason_narrative).toBe('dup');
  });
  test('_assembleFroi02 emits changed_fields', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleFroi02(base, { payload_context: { changed_fields: ['employer_name'] } });
    expect(p._mtc_code).toBe('02');
    expect(p.DN_changed_fields).toEqual(['employer_name']);
  });
  test('_assembleFroiCo links correcting_transaction_id', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleFroiCo(base, { payload_context: { correcting_transaction_id: 't1' } });
    expect(p._mtc_code).toBe('CO');
    expect(p.DN_correction_of_transaction_id).toBe('t1');
  });
});

describe('SROI core assemblers', () => {
  beforeEach(async () => { await seedClaim('c1'); });

  test('_assembleSroiIp emits PD_SCHEDULED default line', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiIp(base, {
      event_date: '2025-09-01', payload_context: { amount_paid: 500, weekly_rate: 500 },
    });
    expect(p._mtc_code).toBe('IP');
    expect(p.benefit_lines[0].DN85_benefit_type_code).toBe('030');
    expect(p.benefit_lines[0].DN89_gross_weekly_amount_paid).toBe('500');
  });
  test('_assembleSroiIp respects explicit benefit_code', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiIp(base, {
      payload_context: { benefit_code: '050' },
    });
    expect(p.benefit_lines[0].DN85_benefit_type_code).toBe('050');
  });
  test('_assembleSroiAp emits AP with first-payment amount', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiAp(base, {
      event_date: '2025-09-01',
      payload_context: { benefit_code: '050', amount_paid: 500 },
    });
    expect(p._mtc_code).toBe('AP');
  });
  test('_assembleSroiCa emits prior+new rates', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiCa(base, {
      payload_context: { prior_weekly_rate: 450, new_weekly_rate: 500, benefit_code: '050' },
    });
    expect(p._mtc_code).toBe('CA');
    expect(p.benefit_lines[0].DN86_benefit_weekly_amount).toBe('500');
    expect(p.benefit_lines[0].DN_previous_weekly_amount).toBe('450');
  });
  test('_assembleSroiCb emits from/to benefit codes', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiCb(base, {
      event_date: '2025-09-01',
      payload_context: { from_benefit_code: '050', to_benefit_code: '030' },
    });
    expect(p._mtc_code).toBe('CB');
    expect(p.benefit_lines[0].DN85_benefit_type_code).toBe('030');
    expect(p.benefit_lines[0].DN_previous_benefit_type).toBe('050');
  });
  test('_assembleSroiRe emits reduced earnings code', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiRe(base, {
      payload_context: { reduced_earnings_code: '600', reduced_earnings_amount: 200 },
    });
    expect(p._mtc_code).toBe('RE');
    expect(p.benefit_lines[0].DN_reduced_earnings_code).toBe('600');
  });
  test('_assembleSroiFs emits EMPLOYER_PAID', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiFs(base, {
      event_date: '2025-06-20', payload_context: { period_end: '2025-07-05' },
    });
    expect(p._mtc_code).toBe('FS');
    expect(p.benefit_lines[0].DN85_benefit_type_code).toBe('240');
  });
});

describe('SROI suspension assembler', () => {
  beforeEach(async () => { await seedClaim('c1'); });

  test.each(['S1', 'P1', 'S2', 'P2', 'S3', 'P3', 'S7'])('assembles suspension %s', async (mtc) => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiSuspension(base, {
      mtc_code: mtc, payload_context: { reason_code: 'rtw', effective_date: '2025-09-15' },
    });
    expect(p._mtc_code).toBe(mtc);
    expect(p.benefit_lines[0].DN_suspension_reason_code).toBe('rtw');
  });
  test('SUSPENSION_REASON_TO_MTC maps rtw → S1/P1', () => {
    expect(svc.SUSPENSION_REASON_TO_MTC.rtw).toEqual({ full: 'S1', partial: 'P1' });
  });
  test('SUSPENSION_REASON_TO_MTC maps med_noncomp → S2/P2', () => {
    expect(svc.SUSPENSION_REASON_TO_MTC.med_noncomp).toEqual({ full: 'S2', partial: 'P2' });
  });
});

describe('SROI PY with C&R breakdown', () => {
  beforeEach(async () => { await seedClaim('c1'); });

  test('breakdown-available emits 3 lines (530/501/500)', async () => {
    await supabase.from('settlement_offers').insert({
      id: 'of1', claim_id: 'c1', offer_type: 'cnr',
      cnr_value: 30000, cnr_pd_amount: 18000, cnr_medical_amount: 8000,
      cnr_attorney_fee_amount: 4000, cnr_other_amount: 0,
      cnr_breakdown_source: 'oacr_final',
    });
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiPy(base, {
      event_date: '2026-01-15',
      payload_context: { source: 'cnr_settlement', offer_id: 'of1', paid_date: '2026-01-15' },
    });
    expect(p._mtc_code).toBe('PY');
    expect(p.benefit_lines).toHaveLength(3);
    expect(p.benefit_lines[0].DN85_benefit_type_code).toBe('530');
    expect(p.benefit_lines[1].DN85_benefit_type_code).toBe('501');
    expect(p.benefit_lines[2].DN85_benefit_type_code).toBe('500');
    expect(p.benefit_lines[0].DN89_gross_weekly_amount_paid).toBe('18000.00');
    expect(p.benefit_lines[2].DN89_gross_weekly_amount_paid).toBe('4000.00');
  });

  test('breakdown-available with estimate → CNR_BREAKDOWN_PRE_OACR warning', async () => {
    await supabase.from('settlement_offers').insert({
      id: 'of2', claim_id: 'c1', offer_type: 'cnr',
      cnr_value: 30000, cnr_pd_amount: 18000, cnr_medical_amount: 8000,
      cnr_attorney_fee_amount: 4000, cnr_other_amount: 0,
      cnr_breakdown_source: 'estimate',
    });
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiPy(base, {
      payload_context: { source: 'cnr_settlement', offer_id: 'of2' },
    });
    expect(p._assembler_warnings.some(w => w.code === 'WCIS_CNR_BREAKDOWN_PRE_OACR')).toBe(true);
  });

  test('breakdown-missing → single-line 500 fallback + warning', async () => {
    await supabase.from('settlement_offers').insert({
      id: 'of3', claim_id: 'c1', offer_type: 'cnr',
      cnr_value: 30000,
    });
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiPy(base, {
      payload_context: { source: 'cnr_settlement', offer_id: 'of3' },
    });
    expect(p.benefit_lines).toHaveLength(1);
    expect(p.benefit_lines[0].DN85_benefit_type_code).toBe('500');
    expect(p.benefit_lines[0].DN89_gross_weekly_amount_paid).toBe('30000.00');
    expect(p._assembler_warnings.some(w => w.code === 'WCIS_CNR_BREAKDOWN_MISSING')).toBe(true);
  });

  test('breakdown sum-mismatch → fallback + warning', async () => {
    await supabase.from('settlement_offers').insert({
      id: 'of4', claim_id: 'c1', offer_type: 'cnr',
      cnr_value: 30000, cnr_pd_amount: 10000, cnr_medical_amount: 5000,
      cnr_attorney_fee_amount: 1000, cnr_other_amount: 0,  // sums to 16000, not 30000
      cnr_breakdown_source: 'oacr_final',
    });
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiPy(base, {
      payload_context: { source: 'cnr_settlement', offer_id: 'of4' },
    });
    expect(p.benefit_lines).toHaveLength(1);
    expect(p._assembler_warnings.some(w => w.code === 'WCIS_CNR_BREAKDOWN_MISSING')).toBe(true);
  });
});

describe('SROI PY with stip disbursement', () => {
  beforeEach(async () => { await seedClaim('c1'); });

  test('future_medical=false → 530/500 lines, no warning', async () => {
    await supabase.from('stipulations').insert({ id: 'st1', claim_id: 'c1', future_medical: false });
    await supabase.from('award_disbursements').insert({
      id: 'd1', claim_id: 'c1', stipulation_id: 'st1', award_type: 'stip_f_and_a',
      total_award: 20000, accrued_amount: 5000, scheduled_amount: 12000, aa_fee_amount: 3000,
    });
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiPy(base, {
      payload_context: { source: 'stip_disbursement', disbursement_id: 'd1' },
    });
    expect(p.benefit_lines).toHaveLength(2);
    expect(p.benefit_lines[0].DN85_benefit_type_code).toBe('530');
    expect(p.benefit_lines[0].DN89_gross_weekly_amount_paid).toBe('17000.00');
    expect(p.benefit_lines[1].DN85_benefit_type_code).toBe('500');
    expect(p.benefit_lines[1].DN89_gross_weekly_amount_paid).toBe('3000.00');
    expect(p._assembler_warnings.some(w => w.code === 'WCIS_STIP_FUTURE_MEDICAL_NO_FN')).toBe(false);
  });

  test('future_medical=true → single 530 line + warning', async () => {
    await supabase.from('stipulations').insert({ id: 'st2', claim_id: 'c1', future_medical: true });
    await supabase.from('award_disbursements').insert({
      id: 'd2', claim_id: 'c1', stipulation_id: 'st2', award_type: 'stip_f_and_a',
      total_award: 15000, accrued_amount: 0, scheduled_amount: 15000, aa_fee_amount: 0,
    });
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiPy(base, {
      payload_context: { source: 'stip_disbursement', disbursement_id: 'd2' },
    });
    expect(p._assembler_warnings.some(w => w.code === 'WCIS_STIP_FUTURE_MEDICAL_NO_FN')).toBe(true);
    expect(p.benefit_lines).toHaveLength(1);
  });

  test('default PD-advance PY (no source) emits single 030 line', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiPy(base, {
      event_date: '2025-09-15',
      payload_context: { amount_paid: 500, period_start: '2025-09-15', period_end: '2025-09-21' },
    });
    expect(p.benefit_lines).toHaveLength(1);
    expect(p.benefit_lines[0].DN85_benefit_type_code).toBe('030');
  });
});

describe('SROI remaining assemblers', () => {
  beforeEach(async () => { await seedClaim('c1'); });

  test('_assembleSroi04 emits denial reason', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroi04(base, {
      payload_context: { denial_reason: 'post-termination claim' },
    });
    expect(p._mtc_code).toBe('04');
    expect(p.DN290_denial_reason_narrative).toBe('post-termination claim');
  });
  test('_assembleSroi4p lists denied benefit codes', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroi4p(base, {
      payload_context: { denied_benefit_codes: ['030'], denial_reason: 'not reasonable' },
    });
    expect(p._mtc_code).toBe('4P');
    expect(p.DN_denied_benefit_codes).toEqual(['030']);
  });
  test('_assembleSroiCd carries date_of_death', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiCd(base, {
      payload_context: { date_of_death: '2025-10-01' },
    });
    expect(p._mtc_code).toBe('CD');
    expect(p.DN_date_of_death).toBe('2025-10-01');
  });
  test('_assembleSroi02 lists changed fields', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroi02(base, {
      payload_context: { changed_fields: ['representation'], employee_represented: true,
        representative_name: 'Jane Doe, Esq.' },
    });
    expect(p.DN_employee_represented).toBe('Y');
    expect(p.DN_representative_name).toBe('Jane Doe, Esq.');
  });
  test('_assembleSroiFn with future_medical_only emits DN73=X', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiFn(base, {
      event_date: '2026-01-15',
      payload_context: { future_medical_only: true, closed_date: '2026-01-15' },
    });
    expect(p.DN73_claim_status_code).toBe('X');
  });
  test('_assembleSroiFn without future_medical emits DN73=C', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiFn(base, {
      event_date: '2026-01-15', payload_context: { closed_date: '2026-01-15' },
    });
    expect(p.DN73_claim_status_code).toBe('C');
  });
  test('_assembleSroiFn rejects bad claim_status_code', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    await expect(svc._assembleSroiFn(base, {
      payload_context: { claim_status_code: 'O' },
    })).rejects.toThrow();
  });
  test('_assembleSroiCo links correcting_transaction_id', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiCo(base, {
      payload_context: { correcting_transaction_id: 't1' },
    });
    expect(p._mtc_code).toBe('CO');
    expect(p.DN_correction_of_transaction_id).toBe('t1');
  });
});

describe('scaffolded assemblers', () => {
  beforeEach(async () => { await seedClaim('c1'); });

  test('_assembleSroiRb emits RB with reinstating_after_mtc', async () => {
    const base = await svc._buildBasePayload('c1', 'production');
    const p = await svc._assembleSroiRb(base, {
      event_date: '2025-10-01',
      payload_context: { reinstating_after_mtc: 'S1' },
    });
    expect(p._mtc_code).toBe('RB');
    expect(p.benefit_lines[0].DN_reinstating_after_mtc).toBe('S1');
  });
  test('_assembleSroiUr throws NOT_IMPLEMENTED', async () => {
    await expect(svc._assembleSroiUr(null, null)).rejects.toThrow(/NOT_IMPLEMENTED/);
  });
});
