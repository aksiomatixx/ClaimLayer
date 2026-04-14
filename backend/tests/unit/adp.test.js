'use strict';

/**
 * Unit tests for services/adp.js
 * Points at the mock ADP server (port 8001).
 */

const adp = require('../../src/services/adp');

beforeEach(() => {
  adp._resetTokenCache();
});

describe('getAccessToken / OAuth2', () => {
  it('fetches a token from mock ADP', async () => {
    const token = await adp._resetTokenCache() || true;
    // Call getEmployee which internally fetches a token
    const emp = await adp.getEmployee('BC-001');
    expect(emp).toBeDefined(); // if no error, token was acquired
  });
});

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

describe('getPayStatements', () => {
  it('returns up to 26 pay periods for BC-001', async () => {
    const statements = await adp.getPayStatements('aoid-bc-001');
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.length).toBeLessThanOrEqual(26);

    // Each statement should have numeric grossPay (not an object)
    statements.forEach(ps => {
      expect(typeof ps.grossPay).toBe('number');
      expect(ps.grossPay).toBeGreaterThanOrEqual(0);
      expect(ps.periodStart).toBeDefined();
      expect(ps.periodEnd).toBeDefined();
    });
  });

  it('returns fewer periods for new hire HH-003', async () => {
    const statements = await adp.getPayStatements('aoid-hh-003');
    // HH-003 was hired ~3 weeks ago — should have 1–2 pay periods
    expect(statements.length).toBeGreaterThanOrEqual(1);
    expect(statements.length).toBeLessThan(5);
  });
});

describe('calculateTDRate — California 2026 rules', () => {
  const TD_MIN = 252.03;
  const TD_MAX = 1680.29;

  it('calculates a standard TD rate within CA bounds', () => {
    // Each statement covers 2 weeks (biweekly). $1,500 gross per period = $750/wk AWW → TD ≈ $500
    const statements = Array(26).fill({ grossPay: 1500, periodStart: '2025-01-01', periodEnd: '2025-01-13' });
    const result = adp.calculateTDRate(statements);

    expect(result.aww).toBeCloseTo(750, 0);
    expect(result.tdRate).toBeCloseTo(500, 0);
    expect(result.tdRate).toBeGreaterThanOrEqual(TD_MIN);
    expect(result.tdRate).toBeLessThanOrEqual(TD_MAX);
  });

  it('applies TD minimum floor for part-time worker (CW-007 scenario)', () => {
    // $16.90/hr × 18 hrs/wk × 2 weeks = ~$608 gross per biweekly period
    // AWW = $304, TD raw = $202.67 → must floor at $252.03
    const statements = Array(26).fill({ grossPay: 608, periodStart: '2025-01-01', periodEnd: '2025-01-13' });
    const result = adp.calculateTDRate(statements);
    expect(result.tdRate).toBe(TD_MIN);
  });

  it('applies TD maximum ceiling for high earner (BC-099 scenario)', () => {
    // $65/hr × 40 hrs/wk × 2 weeks = $5,200 gross per period
    // AWW = $2,600, TD raw = $1,733.33 → must cap at $1,680.29
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

describe('getEmployeeWithFinancials', () => {
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

const TD_MIN = 252.03;
const TD_MAX = 1680.29;
