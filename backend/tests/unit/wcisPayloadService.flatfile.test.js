'use strict';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const svc = require('../../src/services/wcisPayloadService');

function payloadFroi00() {
  return {
    _mtc_family: 'FROI', _mtc_code: '00',
    DN2_jurisdiction: 'CA',
    DN5_jcn_or_null: null,
    DN15_claim_admin_claim_number: 'HHW-2026-042',
    DN6_insurer_fein: '123456789',
    DN18_claim_administrator_fein: '123456789',
    DN42_employee_ssn: '555114444',
    DN43_employee_last_name: 'Santos',
    DN44_employee_first_name: 'Maria',
    DN31_date_of_injury: '2025-06-15',
    DN35_nature_of_injury: 'SPRAIN',
    DN36_body_part: 'LUMBAR',
    DN37_cause_of_injury: 'LIFTING',
    DN186_employer_name: 'BrightCare',
    DN187_employer_fein: '123456789',
    DN41_date_claim_administrator_had_knowledge: '2025-06-16',
  };
}

function payloadSroiIp() {
  return {
    _mtc_family: 'SROI', _mtc_code: 'IP',
    DN2_jurisdiction: 'CA',
    DN5_jcn_or_null: 'STUB-2026-000001',
    DN15_claim_admin_claim_number: 'HHW-2026-042',
    DN6_insurer_fein: '123456789',
    DN18_claim_administrator_fein: '123456789',
    DN31_date_of_injury: '2025-06-15',
    DN34_date_disability_began: '2025-06-16',
    benefit_lines: [{
      DN85_benefit_type_code: '050',
      DN87_benefit_period_start: '2025-06-16',
      DN88_benefit_period_end: '2025-06-22',
      DN86_benefit_weekly_amount: '500',
      DN89_gross_weekly_amount_paid: '500',
    }],
  };
}

beforeEach(() => { supabase._resetStore(); });

describe('_renderFlatFileFromPayload', () => {
  test('FROI 00 header carries family/code/jurisdiction', () => {
    const out = svc._renderFlatFileFromPayload(payloadFroi00());
    expect(out.split('\n')[0]).toMatch(/^IAIABC_R1\|FROI\|00\|CA\|/);
  });
  test('FROI 00 header includes DN15 after empty JCN', () => {
    const out = svc._renderFlatFileFromPayload(payloadFroi00());
    expect(out.split('\n')[0]).toContain('||HHW-2026-042');
  });
  test('FROI 00 body includes employee SSN / names', () => {
    const out = svc._renderFlatFileFromPayload(payloadFroi00());
    expect(out).toContain('DN42_employee_ssn=555114444');
    expect(out).toContain('DN43_employee_last_name=Santos');
    expect(out).toContain('DN44_employee_first_name=Maria');
  });
  test('FROI 00 body includes injury facts', () => {
    const out = svc._renderFlatFileFromPayload(payloadFroi00());
    expect(out).toContain('DN31_date_of_injury=2025-06-15');
    expect(out).toContain('DN36_body_part=LUMBAR');
  });
  test('FROI 00 ends with END', () => {
    const out = svc._renderFlatFileFromPayload(payloadFroi00());
    expect(out.trim().endsWith('END')).toBe(true);
  });
  test('SROI IP header carries JCN', () => {
    const out = svc._renderFlatFileFromPayload(payloadSroiIp());
    expect(out.split('\n')[0]).toMatch(/SROI\|IP\|CA\|STUB-2026-000001/);
  });
  test('SROI IP body emits benefit line BL1 with fields', () => {
    const out = svc._renderFlatFileFromPayload(payloadSroiIp());
    const bl1 = out.split('\n').find(l => l.startsWith('BL1'));
    expect(bl1).toBeTruthy();
    expect(bl1).toContain('DN85_benefit_type_code=050');
    expect(bl1).toContain('DN89_gross_weekly_amount_paid=500');
  });
  test('omits null/undefined DNs from body', () => {
    const p = payloadFroi00();
    delete p.DN37_cause_of_injury;
    const out = svc._renderFlatFileFromPayload(p);
    expect(out).not.toContain('DN37_cause_of_injury');
  });
  test('multi-line benefit payload emits BL1 + BL2', () => {
    const p = { ...payloadSroiIp(), benefit_lines: [
      { DN85_benefit_type_code: '530', DN89_gross_weekly_amount_paid: '18000.00' },
      { DN85_benefit_type_code: '501', DN89_gross_weekly_amount_paid: '8000.00' },
    ]};
    const out = svc._renderFlatFileFromPayload(p);
    expect(out).toContain('BL1|DN85_benefit_type_code=530');
    expect(out).toContain('BL2|DN85_benefit_type_code=501');
  });
  test('SROI IP body includes disability_began date', () => {
    const out = svc._renderFlatFileFromPayload(payloadSroiIp());
    expect(out).toContain('DN34_date_disability_began=2025-06-16');
  });
  test('empty benefit_lines renders no BL lines', () => {
    const p = payloadFroi00();
    const out = svc._renderFlatFileFromPayload(p);
    expect(out).not.toMatch(/^BL\d+/m);
  });
  test('body lines pipe-delimited', () => {
    const out = svc._renderFlatFileFromPayload(payloadFroi00());
    const bodyLine = out.split('\n')[1];
    expect(bodyLine.split('|').length).toBeGreaterThan(5);
  });
});

describe('renderFlatFile (DB-backed)', () => {
  test('reads transaction payload and renders', async () => {
    await supabase.from('wcis_transactions').insert({
      id: 't1', claim_id: 'c1', mtc_family: 'FROI', mtc_code: '00',
      mtc_date: '2025-06-15', environment: 'test',
      payload: payloadFroi00(), payload_hash: 'abc',
      adapter_used: 'stub', status: 'generated',
    });
    const out = await svc.renderFlatFile('t1');
    expect(out).toMatch(/^IAIABC_R1\|FROI\|00\|CA\|/);
  });
  test('throws on missing transaction', async () => {
    await expect(svc.renderFlatFile('no-such')).rejects.toThrow(/not found/);
  });
});

describe('header always starts with IAIABC_R1 marker', () => {
  test.each(['FROI', 'SROI'])('%s emits IAIABC_R1 header', (family) => {
    const p = { _mtc_family: family, _mtc_code: '00', DN2_jurisdiction: 'CA',
      DN15_claim_admin_claim_number: 'X' };
    expect(svc._renderFlatFileFromPayload(p).split('\n')[0].startsWith('IAIABC_R1')).toBe(true);
  });
});
