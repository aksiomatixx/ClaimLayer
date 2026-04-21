'use strict';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const { supabase } = require('../../src/services/supabase');
const svc = require('../../src/services/wcisPayloadService');
const { CA_DATA_EDITS, REPORTABLE_BENEFIT_CODES } = require('../../src/constants/wcisConstants');

function basePayload(over = {}) {
  return {
    _claim_id: 'c1',
    _mtc_family: 'FROI',
    DN2_jurisdiction: 'CA',
    DN15_claim_admin_claim_number: 'HHW-2026-001',
    DN31_date_of_injury: '2025-06-15',
    DN42_employee_ssn: '555114444',
    DN43_employee_last_name: 'Santos',
    DN44_employee_first_name: 'Maria',
    DN6_insurer_fein: '123456789',
    DN18_claim_administrator_fein: '123456789',
    DN187_employer_fein: '123456789',
    ...over,
  };
}

beforeEach(() => { supabase._resetStore(); });

describe('structural validation', () => {
  test('valid FROI 00 payload passes', async () => {
    const r = await svc.validateCaEdits(basePayload(), '00');
    expect(r.valid).toBe(true);
  });
  test('missing DN2_jurisdiction is fatal', async () => {
    const p = basePayload(); delete p.DN2_jurisdiction;
    const r = await svc.validateCaEdits(p, '00');
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.dn === 'DN2_jurisdiction')).toBe(true);
  });
  test('wrong jurisdiction is fatal', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN2_jurisdiction: 'NY' }), '00');
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.code === 'WRONG_JURISDICTION')).toBe(true);
  });
  test('bad date format is fatal', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN31_date_of_injury: '06/15/2025' }), '00');
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.code === 'BAD_DATE_FORMAT')).toBe(true);
  });
  test('DN15 containing * is fatal', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN15_claim_admin_claim_number: 'HHW*1' }), '00');
    expect(r.errors.some(e => e.code === 'INVALID_DELIMITER_CHAR')).toBe(true);
  });
  test('DN15 containing ~ is fatal', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN15_claim_admin_claim_number: 'HHW~1' }), '00');
    expect(r.errors.some(e => e.code === 'INVALID_DELIMITER_CHAR')).toBe(true);
  });
  test('short FEIN is fatal', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN6_insurer_fein: '12345' }), '00');
    expect(r.errors.some(e => e.code === 'BAD_FEIN_FORMAT')).toBe(true);
  });
  test('non-numeric FEIN is fatal', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN18_claim_administrator_fein: '12345ABCD' }), '00');
    expect(r.errors.some(e => e.code === 'BAD_FEIN_FORMAT')).toBe(true);
  });
  test('missing claim admin claim number is fatal', async () => {
    const p = basePayload(); delete p.DN15_claim_admin_claim_number;
    const r = await svc.validateCaEdits(p, '00');
    expect(r.errors.some(e => e.dn === 'DN15_claim_admin_claim_number')).toBe(true);
  });
});

describe('CA edits — blocklist strings', () => {
  test.each(['unk', 'unknown', 'UNKNOWN', 'DK', "don't know", 'na', 'N/A'])('blocklists %s', async (v) => {
    const r = await svc.validateCaEdits(basePayload({ DN43_employee_last_name: v }), '00');
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.code === 'BLOCKLIST_STRING')).toBe(true);
  });
  test('accepts genuine-looking name', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN43_employee_last_name: 'Smith' }), '00');
    expect(r.valid).toBe(true);
  });
  test('blocklist on employer name', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN186_employer_name: 'N/A' }), '00');
    expect(r.errors.some(e => e.code === 'BLOCKLIST_STRING')).toBe(true);
  });
});

describe('CA edits — SSN rules', () => {
  test('SSN blocklist 123456789 is fatal', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN42_employee_ssn: '123456789' }), '00');
    expect(r.errors.some(e => e.code === 'SSN_BLOCKLISTED')).toBe(true);
  });
  test('SSN blocklist 987654321 is fatal', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN42_employee_ssn: '987654321' }), '00');
    expect(r.errors.some(e => e.code === 'SSN_BLOCKLISTED')).toBe(true);
  });
  test('SSN all-same-digit 111111111 is fatal', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN42_employee_ssn: '111111111' }), '00');
    expect(r.errors.some(e => e.code === 'SSN_ALL_SAME_DIGIT')).toBe(true);
  });
  test('SSN all-same-digit 444444444 is fatal', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN42_employee_ssn: '444444444' }), '00');
    expect(r.errors.some(e => e.code === 'SSN_ALL_SAME_DIGIT')).toBe(true);
  });
  test('SSN with non-digits normalized', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN42_employee_ssn: '555-11-4444' }), '00');
    expect(r.valid).toBe(true);
  });
  test('short SSN fatal', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN42_employee_ssn: '1234' }), '00');
    expect(r.errors.some(e => e.code === 'BAD_SSN_LENGTH')).toBe(true);
  });
});

describe('CA edits — date ordering', () => {
  test('DOI after disability_began is fatal', async () => {
    const r = await svc.validateCaEdits(
      basePayload({ DN31_date_of_injury: '2025-07-01', DN34_date_disability_began: '2025-06-15' }),
      '00',
    );
    expect(r.errors.some(e => e.code === 'DATE_DISABILITY_BEFORE_INJURY')).toBe(true);
  });
  test('DOI before disability_began is ok', async () => {
    const r = await svc.validateCaEdits(
      basePayload({ DN31_date_of_injury: '2025-06-15', DN34_date_disability_began: '2025-06-15' }),
      '00',
    );
    expect(r.valid).toBe(true);
  });
});

describe('CA edits — DN85 deprecation', () => {
  test('always-deprecated 410 rejected on FROI 00', async () => {
    const p = basePayload({ benefit_lines: [{ DN85_benefit_type_code: '410' }] });
    const r = await svc.validateCaEdits(p, '00');
    expect(r.errors.some(e => e.code === 'DN85_ALWAYS_DEPRECATED')).toBe(true);
  });
  test('always-deprecated 541 rejected on FROI AU', async () => {
    const p = basePayload({
      benefit_lines: [{ DN85_benefit_type_code: '541' }],
      payload_context: { acquired_claim_has_pre_2005_p_and_s: true },
    });
    const r = await svc.validateCaEdits(p, 'AU');
    expect(r.errors.some(e => e.code === 'DN85_ALWAYS_DEPRECATED')).toBe(true);
  });
  test('deprecated 040 rejected on new-origin FROI 00', async () => {
    const p = basePayload({ benefit_lines: [{ DN85_benefit_type_code: '040' }] });
    const r = await svc.validateCaEdits(p, '00');
    expect(r.errors.some(e => e.code === 'DN85_DEPRECATED_ON_NEW_ORIGIN')).toBe(true);
  });
  test('deprecated 040 allowed on AU with override', async () => {
    const p = basePayload({
      benefit_lines: [{ DN85_benefit_type_code: '040' }],
      payload_context: { acquired_claim_has_pre_2005_p_and_s: true },
    });
    const r = await svc.validateCaEdits(p, 'AU');
    expect(r.valid).toBe(true);
  });
  test('deprecated 040 rejected on AU without override', async () => {
    const p = basePayload({ benefit_lines: [{ DN85_benefit_type_code: '040' }] });
    const r = await svc.validateCaEdits(p, 'AU');
    expect(r.errors.some(e => e.code === 'DN85_DEPRECATED_AU_NO_OVERRIDE')).toBe(true);
  });
  test('active 050 TT accepted', async () => {
    const p = basePayload({ benefit_lines: [{ DN85_benefit_type_code: '050' }] });
    const r = await svc.validateCaEdits(p, '00');
    expect(r.valid).toBe(true);
  });
});

describe('CA edits — DN35/36/37/73 not-validated warnings', () => {
  test('attaches WCIS_CODE_LIST_NOT_VALIDATED warning on DN35', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN35_nature_of_injury: 'LACERATION' }), '00');
    expect(r.warnings.some(w => w.code === 'WCIS_CODE_LIST_NOT_VALIDATED' && w.dns.includes('DN35_nature_of_injury'))).toBe(true);
  });
  test('warning on DN36 body part', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN36_body_part: 'LUMBAR' }), '00');
    expect(r.warnings.some(w => w.code === 'WCIS_CODE_LIST_NOT_VALIDATED' && w.dns.includes('DN36_body_part'))).toBe(true);
  });
  test('warning on DN37 cause', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN37_cause_of_injury: 'LIFTING' }), '00');
    expect(r.warnings.some(w => w.code === 'WCIS_CODE_LIST_NOT_VALIDATED' && w.dns.includes('DN37_cause_of_injury'))).toBe(true);
  });
  test('blocklist STILL applies on DN35 (overrides warning)', async () => {
    const r = await svc.validateCaEdits(basePayload({ DN35_nature_of_injury: 'unknown' }), '00');
    expect(r.errors.some(e => e.dn === 'DN35_nature_of_injury' && e.code === 'BLOCKLIST_STRING')).toBe(true);
  });
});

describe('referential validation', () => {
  async function seedClaimState(claimId, overrides = {}) {
    await supabase.from('claims').insert({ id: claimId, claim_number: 'X' });
    await supabase.from('wcis_claim_state').insert({
      claim_id: claimId, claim_admin_claim_number: 'X',
      ...overrides,
    });
  }

  test('SROI without JCN is fatal', async () => {
    await seedClaimState('c1');
    const p = { ...basePayload(), _claim_id: 'c1', _mtc_family: 'SROI', DN5_jcn_or_null: null,
      benefit_lines: [{ DN85_benefit_type_code: '050' }] };
    const r = await svc.validateCaEdits(p, 'PY');
    expect(r.errors.some(e => e.code === 'SROI_REQUIRES_JCN')).toBe(true);
  });
  test('SROI with JCN on state is valid', async () => {
    await seedClaimState('c1', { jcn: 'STUB-2026-000001' });
    const p = { ...basePayload(), _claim_id: 'c1', _mtc_family: 'SROI',
      benefit_lines: [{ DN85_benefit_type_code: '050' }] };
    const r = await svc.validateCaEdits(p, 'PY');
    expect(r.valid).toBe(true);
  });

  test('FN with DN73=C is valid', async () => {
    await seedClaimState('c1', { jcn: 'J1' });
    const p = { ...basePayload(), _claim_id: 'c1', _mtc_family: 'SROI',
      DN73_claim_status_code: 'C' };
    const r = await svc.validateCaEdits(p, 'FN');
    expect(r.valid).toBe(true);
  });
  test('FN with DN73=X (future medical) is valid', async () => {
    await seedClaimState('c1', { jcn: 'J1' });
    const p = { ...basePayload(), _claim_id: 'c1', _mtc_family: 'SROI',
      DN73_claim_status_code: 'X' };
    const r = await svc.validateCaEdits(p, 'FN');
    expect(r.valid).toBe(true);
  });
  test('FN with DN73=O is fatal (C7 rule)', async () => {
    await seedClaimState('c1', { jcn: 'J1' });
    const p = { ...basePayload(), _claim_id: 'c1', _mtc_family: 'SROI',
      DN73_claim_status_code: 'O' };
    const r = await svc.validateCaEdits(p, 'FN');
    expect(r.errors.some(e => e.code === 'FN_REQUIRES_DN73_C_OR_X')).toBe(true);
  });
  test('FN missing DN73 is fatal', async () => {
    await seedClaimState('c1', { jcn: 'J1' });
    const p = { ...basePayload(), _claim_id: 'c1', _mtc_family: 'SROI' };
    const r = await svc.validateCaEdits(p, 'FN');
    expect(r.errors.some(e => e.code === 'FN_REQUIRES_DN73_C_OR_X')).toBe(true);
  });

  test('CB to already-open benefit is fatal', async () => {
    await seedClaimState('c1', { jcn: 'J', open_benefit_codes: ['030'] });
    const p = { ...basePayload(), _claim_id: 'c1', _mtc_family: 'SROI',
      DN5_jcn_or_null: 'J', benefit_lines: [{ DN85_benefit_type_code: '030' }],
      payload_context: { to_benefit_code: '030' } };
    const r = await svc.validateCaEdits(p, 'CB');
    expect(r.errors.some(e => e.code === 'CB_BENEFIT_ALREADY_OPEN')).toBe(true);
  });
  test('CB to new benefit is valid', async () => {
    await seedClaimState('c1', { jcn: 'J', open_benefit_codes: ['050'] });
    const p = { ...basePayload(), _claim_id: 'c1', _mtc_family: 'SROI',
      DN5_jcn_or_null: 'J', benefit_lines: [{ DN85_benefit_type_code: '030' }],
      payload_context: { to_benefit_code: '030' } };
    const r = await svc.validateCaEdits(p, 'CB');
    expect(r.valid).toBe(true);
  });

  test('FN with open benefits still open → warning (not fatal)', async () => {
    await seedClaimState('c1', { jcn: 'J', open_benefit_codes: ['030'] });
    const p = { ...basePayload(), _claim_id: 'c1', _mtc_family: 'SROI',
      DN5_jcn_or_null: 'J', DN73_claim_status_code: 'C' };
    const r = await svc.validateCaEdits(p, 'FN');
    expect(r.valid).toBe(true);
    expect(r.warnings.some(w => w.code === 'WCIS_FN_WITH_OPEN_BENEFITS')).toBe(true);
  });
});

describe('short-circuit + warning accumulation', () => {
  test('stops on first fatal layer', async () => {
    const p = basePayload({ DN2_jurisdiction: 'NY', DN42_employee_ssn: '123456789' });
    const r = await svc.validateCaEdits(p, '00');
    // structural wrong jurisdiction fires first; CA SSN block does not
    expect(r.valid).toBe(false);
    expect(r.errors.every(e => e.code !== 'SSN_BLOCKLISTED')).toBe(true);
  });
  test('warnings accumulate when valid', async () => {
    const r = await svc.validateCaEdits(
      basePayload({ DN35_nature_of_injury: 'X', DN36_body_part: 'Y', DN37_cause_of_injury: 'Z' }),
      '00',
    );
    expect(r.valid).toBe(true);
    const notValidated = r.warnings.find(w => w.code === 'WCIS_CODE_LIST_NOT_VALIDATED');
    expect(notValidated.dns.length).toBe(3);
  });
});
