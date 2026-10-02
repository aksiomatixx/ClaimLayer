'use strict';

const { toCents, fromCents, assertCents, formatCents } = require('../../src/utils/money');

describe('toCents', () => {
  test.each([
    [0, 0], [1, 100], [1.005, 101], [0.1 + 0.2, 30], [1680.29, 168029],
    [-1.005, -101], ['252.03', 25203], [19.999, 2000], [-0.001, 0],
  ])('%p dollars → %p cents', (dollars, cents) => {
    expect(toCents(dollars)).toBe(cents);
  });

  test('null and empty pass through as null', () => {
    expect(toCents(null)).toBeNull();
    expect(toCents('')).toBeNull();
  });

  test('non-finite input throws rather than producing NaN money', () => {
    for (const bad of ['abc', NaN, Infinity]) expect(() => toCents(bad)).toThrow(/finite/);
  });

  test('never returns negative zero', () => {
    expect(Object.is(toCents(-0.001), -0)).toBe(false);
  });
});

describe('assertCents / fromCents / formatCents', () => {
  test('assertCents accepts safe non-negative integers only', () => {
    expect(assertCents(0)).toBe(0);
    expect(assertCents(123456)).toBe(123456);
    for (const bad of [-1, 1.5, '100', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => assertCents(bad, 'medical_cents')).toThrow(/medical_cents/);
    }
  });

  test('fromCents round-trips', () => {
    expect(fromCents(168029)).toBe(1680.29);
    expect(fromCents(null)).toBeNull();
  });

  test('formatCents renders USD', () => {
    expect(formatCents(2500000)).toBe('$25,000.00');
    expect(formatCents(null)).toBe('n/a');
  });
});
