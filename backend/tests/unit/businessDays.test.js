'use strict';

const { addBusinessDays, getCaliforniaHolidays } = require('../../src/utils/businessDays');

describe('addBusinessDays', () => {
  test('skips weekends', () => {
    // Friday April 10 2026 + 1 business day = Monday April 13
    const friday = new Date('2026-04-10T00:00:00Z');
    const result = addBusinessDays(friday, 1);
    expect(result.toISOString().split('T')[0]).toBe('2026-04-13');
  });

  test("skips New Year's Day — DOI Dec 30, 1 business day deadline", () => {
    // Dec 30 2025 is Tuesday. +1 business day = Dec 31 (Wednesday, not a holiday).
    const dec30 = new Date('2025-12-30T00:00:00Z');
    const result = addBusinessDays(dec30, 1);
    expect(result.toISOString().split('T')[0]).toBe('2025-12-31');
  });

  test("skips New Year's Day — DOI Dec 31, 1 business day deadline", () => {
    // Dec 31 2025 is Wednesday. +1 business day → Jan 1 (holiday) → skip → Jan 2.
    const dec31 = new Date('2025-12-31T00:00:00Z');
    const result = addBusinessDays(dec31, 1);
    expect(result.toISOString().split('T')[0]).toBe('2026-01-02');
  });

  test('skips Friday before a Monday holiday', () => {
    // Memorial Day 2026 = Monday May 25.
    // Friday May 22 + 1 business day → May 23 (Sat, skip) → May 24 (Sun, skip) →
    // May 25 (Memorial Day, skip) → May 26.
    const friday = new Date('2026-05-22T00:00:00Z');
    const result = addBusinessDays(friday, 1);
    expect(result.toISOString().split('T')[0]).toBe('2026-05-26');
  });

  test('César Chávez Day March 31 observed correctly', () => {
    // March 31 2026 is a Tuesday (actual holiday).
    // March 30 + 1 business day → March 31 (holiday, skip) → April 1.
    const march30 = new Date('2026-03-30T00:00:00Z');
    const result = addBusinessDays(march30, 1);
    expect(result.toISOString().split('T')[0]).toBe('2026-04-01');
  });

  test('holiday observed on Monday when falls on Sunday', () => {
    // Juneteenth (June 19) 2023 fell on a Monday because June 18 was Sunday.
    // June 16 (Friday) + 1 business day:
    //   June 17 = Saturday (skip)
    //   June 18 = Sunday   (skip)
    //   June 19 = observed Juneteenth (skip)
    //   June 20 = Tuesday  ✓
    const june16 = new Date('2023-06-16T00:00:00Z');
    const result = addBusinessDays(june16, 1);
    expect(result.toISOString().split('T')[0]).toBe('2023-06-20');
  });
});

describe('getCaliforniaHolidays', () => {
  test('returns correct Memorial Day for 2026 (last Monday May)', () => {
    const holidays = getCaliforniaHolidays(2026);
    expect(holidays.has('2026-05-25')).toBe(true);
  });

  test('returns correct Thanksgiving for 2026 (4th Thursday November)', () => {
    const holidays = getCaliforniaHolidays(2026);
    expect(holidays.has('2026-11-26')).toBe(true);
  });

  test('New Year\'s Day observed on Monday when Jan 1 falls on Sunday', () => {
    // Jan 1 2023 was a Sunday → observed Jan 2 (Monday)
    const holidays = getCaliforniaHolidays(2023);
    expect(holidays.has('2023-01-02')).toBe(true);
    expect(holidays.has('2023-01-01')).toBe(false);
  });
});
