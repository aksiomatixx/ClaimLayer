'use strict';

jest.mock('../../src/services/supabase', () => require('../__mocks__/supabaseClient'));

const svc = require('../../src/services/wcisPayloadService');
const { CODE_LIST_VALIDATION_STATUS } = require('../../src/constants/wcisConstants');

describe('CSV loaders', () => {
  test('DN77 codes loaded (>= 20)', () => {
    expect(svc._loaders.DN77_CODES.size).toBeGreaterThanOrEqual(20);
  });
  test('DN77 includes L1 (No excuse)', () => {
    expect(svc._loaders.DN77_CODES.has('L1')).toBe(true);
  });
  test('DN77 includes C1 (Coverage Lack of Information)', () => {
    expect(svc._loaders.DN77_CODES.has('C1')).toBe(true);
  });
  test('DN85 codes loaded (>= 25)', () => {
    expect(svc._loaders.DN85_CODES.size).toBeGreaterThanOrEqual(25);
  });
  test('DN85 includes 050 TT / 070 TP / 030 PD / 020 PT / 010 Fatal', () => {
    expect(svc._loaders.DN85_CODES.has('050')).toBe(true);
    expect(svc._loaders.DN85_CODES.has('070')).toBe(true);
    expect(svc._loaders.DN85_CODES.has('030')).toBe(true);
    expect(svc._loaders.DN85_CODES.has('020')).toBe(true);
    expect(svc._loaders.DN85_CODES.has('010')).toBe(true);
  });
  test('DN85 compromised pairs 500/501/530 present', () => {
    expect(svc._loaders.DN85_CODES.has('500')).toBe(true);
    expect(svc._loaders.DN85_CODES.has('501')).toBe(true);
    expect(svc._loaders.DN85_CODES.has('530')).toBe(true);
  });
  test('DN85 deprecated set includes 410, 541 (voc rehab)', () => {
    expect(svc._loaders.DN85_DEPRECATED.has('410')).toBe(true);
    expect(svc._loaders.DN85_DEPRECATED.has('541')).toBe(true);
  });
  test('DN85 deprecated set includes 040 (post-2005 PD unsched)', () => {
    expect(svc._loaders.DN85_DEPRECATED.has('040')).toBe(true);
  });
  test('DN95 expanded count after range expansion is larger than raw row count', () => {
    // raw = 23 rows including two ranges (600-624 = 25, 650-674 = 25)
    // expanded = 23 - 2 + 25 + 25 = 71
    expect(svc._loaders.DN95_CODES.size).toBeGreaterThan(60);
  });
  test('DN95 range 600-624 expanded to include 600', () => {
    expect(svc._loaders.DN95_CODES.has('600')).toBe(true);
  });
  test('DN95 range 600-624 expanded to include 612', () => {
    expect(svc._loaders.DN95_CODES.has('612')).toBe(true);
  });
  test('DN95 range 600-624 expanded to include 624', () => {
    expect(svc._loaders.DN95_CODES.has('624')).toBe(true);
  });
  test('DN95 range 600-624 does NOT include 625', () => {
    expect(svc._loaders.DN95_CODES.has('625')).toBe(false);
  });
  test('DN95 range 650-674 expanded to include 650, 662, 674', () => {
    expect(svc._loaders.DN95_CODES.has('650')).toBe(true);
    expect(svc._loaders.DN95_CODES.has('662')).toBe(true);
    expect(svc._loaders.DN95_CODES.has('674')).toBe(true);
  });
  test('DN95 includes non-range codes (300, 390, 800)', () => {
    expect(svc._loaders.DN95_CODES.has('300')).toBe(true);
    expect(svc._loaders.DN95_CODES.has('390')).toBe(true); // SJDB
    expect(svc._loaders.DN95_CODES.has('800')).toBe(true);
  });
});

describe('CODE_LIST_VALIDATION_STATUS', () => {
  test('DN35 not validated (WCIO source pending)', () => {
    expect(CODE_LIST_VALIDATION_STATUS.DN35).toMatch(/NOT_VALIDATED/);
  });
  test('DN36 not validated (WCIO source pending)', () => {
    expect(CODE_LIST_VALIDATION_STATUS.DN36).toMatch(/NOT_VALIDATED/);
  });
  test('DN37 not validated (WCIO source pending)', () => {
    expect(CODE_LIST_VALIDATION_STATUS.DN37).toMatch(/NOT_VALIDATED/);
  });
  test('DN73 not validated (IAIABC source pending)', () => {
    expect(CODE_LIST_VALIDATION_STATUS.DN73).toMatch(/NOT_VALIDATED/);
  });
  test('DN77 validated', () => {
    expect(CODE_LIST_VALIDATION_STATUS.DN77).toBe('VALIDATED');
  });
  test('DN85 validated', () => {
    expect(CODE_LIST_VALIDATION_STATUS.DN85).toBe('VALIDATED');
  });
  test('DN95 validated', () => {
    expect(CODE_LIST_VALIDATION_STATUS.DN95).toBe('VALIDATED');
  });
});

describe('_internal helpers', () => {
  test('_parseCsvLine handles quoted commas', () => {
    const cols = svc._internal._parseCsvLine('a,"b,c",d');
    expect(cols).toEqual(['a', 'b,c', 'd']);
  });
  test('_parseCsvLine handles escaped quote', () => {
    const cols = svc._internal._parseCsvLine('a,"b""c",d');
    expect(cols).toEqual(['a', 'b"c', 'd']);
  });
  test('_expandDn95Ranges expands 100-102', () => {
    const exp = svc._internal._expandDn95Ranges([
      { code: '100-102', description: 'Test' },
    ]);
    expect(exp).toHaveLength(3);
    expect(exp.map(r => r.code)).toEqual(['100', '101', '102']);
    expect(exp[0].description).toBe('Test');
  });
  test('_expandDn95Ranges leaves non-ranges unchanged', () => {
    const exp = svc._internal._expandDn95Ranges([{ code: '300', description: 'X' }]);
    expect(exp).toHaveLength(1);
    expect(exp[0].code).toBe('300');
  });
});
