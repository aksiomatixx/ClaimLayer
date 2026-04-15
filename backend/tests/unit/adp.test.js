'use strict';

/**
 * Unit tests for services/adp.js
 *
 * Uses jest.mock('axios') to intercept HTTP calls — no external server required.
 */

// ── Axios mock ────────────────────────────────────────────────────────────────
jest.mock('axios', () => {
  // ADP wire-format employee records (keyed by internal employee ID)
  const MOCK_WORKERS = {
    'BC-001': {
      associateOID: 'aoid-bc-001',
      person: {
        legalName:   { givenName: 'Maria', familyName: 'Santos' },
        birthDate:   '1981-03-15',
        homeAddress: {
          lineOne: '1234 Main St',
          cityName: 'Los Angeles',
          countrySubdivisionLevel1: { codeValue: 'CA' },
          postalCode: '90057',
        },
      },
      businessCommunication: { landlines: [{ formattedNumber: '(213) 555-1001' }] },
      jobCode:     { shortName: 'Home Health Aide II' },
      workerDates: { originalHireDate: '2019-06-01' },
    },
    'CF-014': {
      associateOID: 'aoid-cf-014',
      person: {
        legalName:   { givenName: 'James', familyName: 'Okonkwo' },
        birthDate:   '1975-08-20',
        homeAddress: { lineOne: '500 Oak Ave', cityName: 'Oakland', countrySubdivisionLevel1: { codeValue: 'CA' }, postalCode: '94601' },
      },
      businessCommunication: {},
      jobCode:     { shortName: 'Care Facilitator' },
      workerDates: { originalHireDate: '2018-03-01' },
    },
  };

  // Pay statement wire-format (grossPay wrapped in ADP { amount, currencyCode })
  function makeStmts(count, grossPer) {
    return Array.from({ length: count }, (_, i) => ({
      grossPay:           { amount: String(grossPer), currencyCode: 'USD' },
      payPeriodStartDate: `2025-${String(Math.floor(i / 2) + 1).padStart(2, '0')}-01`,
      payPeriodEndDate:   `2025-${String(Math.floor(i / 2) + 1).padStart(2, '0')}-14`,
      earnings:           [],
    }));
  }

  // BC-001: AWW = 26 × 1501.50 / 52 = 750.75 → TD = 500.50 (within CA bounds)
  // HH-003: 2 periods only (new hire)
  const MOCK_PAY = {
    'aoid-bc-001': makeStmts(26, 1501.50),
    'aoid-cf-014': makeStmts(26, 1200),
    'aoid-hh-003': makeStmts(2, 800),
  };

  // Fake axios instance returned by axios.create(...)
  const mockGet = jest.fn((path, config) => {
    // GET /hr/v2/workers?$filter=...eq 'BC-001'
    if (path === '/hr/v2/workers') {
      const filter = config?.params?.$filter || '';
      const m      = filter.match(/eq '([^']+)'/);
      const id     = m?.[1];
      const worker = id ? MOCK_WORKERS[id] : null;
      if (!worker) return Promise.resolve({ data: { workers: [] } });
      return Promise.resolve({ data: { workers: [worker] } });
    }

    // GET /payroll/v1/workers/:oid/pay-statements
    const psMatch = path.match(/\/payroll\/v1\/workers\/([^/]+)\/pay-statements/);
    if (psMatch) {
      const aoid  = psMatch[1];
      const stmts = MOCK_PAY[aoid] || [];
      return Promise.resolve({ data: { payStatements: stmts } });
    }

    return Promise.reject(new Error(`ADP mock: unexpected GET ${path}`));
  });

  const mockCreate = jest.fn(() => ({ get: mockGet }));

  const mockPost = jest.fn(() =>
    Promise.resolve({ data: { access_token: 'mock-adp-token', expires_in: 3600 } })
  );

  return { create: mockCreate, post: mockPost };
});

// ── Service under test ────────────────────────────────────────────────────────
const adp = require('../../src/services/adp');

beforeEach(() => {
  adp._resetTokenCache();
});

// ═════════════════════════════════════════════════════════════════════════════
describe('getAccessToken / OAuth2', () => {
  it('fetches a token from mock ADP', async () => {
    adp._resetTokenCache();
    const emp = await adp.getEmployee('BC-001');
    expect(emp).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('getEmployee', () => {
  it('returns Maria Santos for BC-001', async () => {
    const emp = await adp.getEmployee('BC-001');
    expect(emp.firstName).toBe('Maria');
    expect(emp.lastName).toBe('Santos');
    expect(emp.dob).toBe('1981-03-15');
    expect(emp.associateOID).toBe('aoid-bc-001');
    expect(emp.address.state).toBe('CA');
    expect(emp.address.zip).toBe('90057');
  });

  it('returns James Okonkwo for CF-014', async () => {
    const emp = await adp.getEmployee('CF-014');
    expect(emp.firstName).toBe('James');
    expect(emp.lastName).toBe('Okonkwo');
    expect(emp.associateOID).toBe('aoid-cf-014');
  });

  it('throws for unknown employee ID', async () => {
    await expect(adp.getEmployee('FAKE-999')).rejects.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('getPayStatements', () => {
  it('returns up to 26 pay periods for BC-001', async () => {
    const statements = await adp.getPayStatements('aoid-bc-001');
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.length).toBeLessThanOrEqual(26);

    statements.forEach(ps => {
      expect(typeof ps.grossPay).toBe('number');
      expect(ps.grossPay).toBeGreaterThanOrEqual(0);
      expect(ps.periodStart).toBeDefined();
      expect(ps.periodEnd).toBeDefined();
    });
  });

  it('returns fewer periods for new hire HH-003', async () => {
    const statements = await adp.getPayStatements('aoid-hh-003');
    expect(statements.length).toBeGreaterThanOrEqual(1);
    expect(statements.length).toBeLessThan(5);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('calculateTDRate — California 2026 rules', () => {
  const TD_MIN = 252.03;
  const TD_MAX = 1680.29;

  it('calculates a standard TD rate within CA bounds', () => {
    const statements = Array(26).fill({ grossPay: 1500, periodStart: '2025-01-01', periodEnd: '2025-01-13' });
    const result = adp.calculateTDRate(statements);

    expect(result.aww).toBeCloseTo(750, 0);
    expect(result.tdRate).toBeCloseTo(500, 0);
    expect(result.tdRate).toBeGreaterThanOrEqual(TD_MIN);
    expect(result.tdRate).toBeLessThanOrEqual(TD_MAX);
  });

  it('applies TD minimum floor for part-time worker (CW-007 scenario)', () => {
    const statements = Array(26).fill({ grossPay: 608, periodStart: '2025-01-01', periodEnd: '2025-01-13' });
    const result = adp.calculateTDRate(statements);
    expect(result.tdRate).toBe(TD_MIN);
  });

  it('applies TD maximum ceiling for high earner (BC-099 scenario)', () => {
    const statements = Array(26).fill({ grossPay: 5200, periodStart: '2025-01-01', periodEnd: '2025-01-13' });
    const result = adp.calculateTDRate(statements);
    expect(result.tdRate).toBe(TD_MAX);
  });

  it('throws when no pay statements provided', () => {
    expect(() => adp.calculateTDRate([])).toThrow();
  });

  it('returns correct week count', () => {
    const statements = Array(13).fill({ grossPay: 1000 });
    const result = adp.calculateTDRate(statements);
    expect(result.weeksCalculated).toBe(13);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('getEmployeeWithFinancials', () => {
  const TD_MIN = 252.03;
  const TD_MAX = 1680.29;

  it('returns merged employee + financial data for BC-001', async () => {
    const result = await adp.getEmployeeWithFinancials('BC-001');

    expect(result.firstName).toBe('Maria');
    expect(result.aww).toBeGreaterThan(0);
    expect(result.tdRate).toBeGreaterThanOrEqual(TD_MIN);
    expect(result.tdRate).toBeLessThanOrEqual(TD_MAX);
    expect(result.payStatements).toBeInstanceOf(Array);
    expect(result.payStatements.length).toBeGreaterThan(0);
  }, 10_000);
});
