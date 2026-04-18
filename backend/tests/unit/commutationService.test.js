'use strict';

/**
 * Unit tests — commutationService (M14.5).
 *
 * All values are verified against docs/regulatory/deu_table1_pv_pd.csv
 * (DEU Table 1, 3% annual discount rate, 1–950 weeks).
 */

const commutation = require('../../src/services/commutationService');

describe('DEU_POLICY constants', () => {
  it('embeds the documented 3% annual discount', () => {
    expect(commutation.DEU_POLICY.INTEREST_RATE_ANNUAL).toBe(0.03);
  });

  it('embeds the LC §5800 10% annual late-payment rate', () => {
    expect(commutation.DEU_POLICY.LATE_PAYMENT_RATE_ANNUAL).toBe(0.10);
  });

  it('caps Table 1 at 950 weeks', () => {
    expect(commutation.DEU_POLICY.TABLE_1_MAX_WEEKS).toBe(950);
  });

  it('documents the regulatory source path', () => {
    expect(commutation.DEU_POLICY.TABLE_1_SOURCE).toBe('docs/regulatory/deu_table1_pv_pd.csv');
  });
});

describe('Table 1 load integrity', () => {
  it('loads exactly 950 rows', () => {
    expect(commutation.DEU_TABLE_1).toHaveLength(950);
  });

  it('row 0 is week 1', () => {
    expect(commutation.DEU_TABLE_1[0].weeks).toBe(1);
  });

  it('last row is week 950', () => {
    expect(commutation.DEU_TABLE_1[949].weeks).toBe(950);
  });
});

describe('getPvForWeeks — integer lookups', () => {
  it('PV(0) = 0 exactly', () => {
    expect(commutation.getPvForWeeks(0)).toBe(0);
  });

  it('PV(1) = 0.9989 (CSV row 1)', () => {
    expect(commutation.getPvForWeeks(1)).toBeCloseTo(0.9989, 4);
  });

  it('PV(100) matches CSV value', () => {
    const row = commutation.DEU_TABLE_1[99]; // week 100
    expect(commutation.getPvForWeeks(100)).toBe(row.pv);
  });

  it('PV(239) = 223.3996 (CSV row 239)', () => {
    expect(commutation.getPvForWeeks(239)).toBeCloseTo(223.3996, 4);
  });

  it('PV(240) = 224.2725 (README-verified)', () => {
    expect(commutation.getPvForWeeks(240)).toBeCloseTo(224.2725, 4);
  });

  it('PV(322) = 294.1718 (README-verified)', () => {
    expect(commutation.getPvForWeeks(322)).toBeCloseTo(294.1718, 4);
  });

  it('PV(500) = 435.1784 (CSV row 500)', () => {
    expect(commutation.getPvForWeeks(500)).toBeCloseTo(435.1784, 4);
  });

  it('PV(950) = 734.2466 (CSV last row)', () => {
    expect(commutation.getPvForWeeks(950)).toBeCloseTo(734.2466, 4);
  });
});

describe('getPvForWeeks — fractional interpolation', () => {
  it('PV(240.5) = midpoint of PV(240) and PV(241)', () => {
    const a = commutation.getPvForWeeks(240);
    const b = commutation.getPvForWeeks(241);
    expect(commutation.getPvForWeeks(240.5)).toBeCloseTo((a + b) / 2, 6);
  });

  it('PV(322.857) interpolates between PV(322) and PV(323)', () => {
    const lo = commutation.getPvForWeeks(322);
    const hi = commutation.getPvForWeeks(323);
    const expected = lo + 0.857 * (hi - lo);
    expect(commutation.getPvForWeeks(322.857)).toBeCloseTo(expected, 6);
  });

  it('PV(239.5) is between PV(239) and PV(240)', () => {
    const v = commutation.getPvForWeeks(239.5);
    expect(v).toBeGreaterThan(223.3996);
    expect(v).toBeLessThan(224.2725);
  });
});

describe('getPvForWeeks — error paths', () => {
  it('throws INVALID_WEEKS for weeks=-1', () => {
    expect(() => commutation.getPvForWeeks(-1)).toThrow('INVALID_WEEKS');
  });

  it('throws INVALID_WEEKS for NaN', () => {
    expect(() => commutation.getPvForWeeks(NaN)).toThrow('INVALID_WEEKS');
  });

  it('throws DEU_RANGE_EXCEEDED for weeks=951', () => {
    expect(() => commutation.getPvForWeeks(951)).toThrow('DEU_RANGE_EXCEEDED');
  });

  it('throws DEU_RANGE_EXCEEDED for weeks=1000', () => {
    expect(() => commutation.getPvForWeeks(1000)).toThrow('DEU_RANGE_EXCEEDED');
  });
});

describe('getWeeksForPv — reverse interpolation', () => {
  it('PV(240.0000) inverts back to week 240', () => {
    const wks = commutation.getWeeksForPv(224.2725);
    expect(wks).toBeCloseTo(240, 2);
  });

  it('PV(0) returns 0', () => {
    expect(commutation.getWeeksForPv(0)).toBe(0);
  });

  it('throws DEU_RANGE_EXCEEDED above PV(950)', () => {
    expect(() => commutation.getWeeksForPv(10_000)).toThrow('DEU_RANGE_EXCEEDED');
  });

  it('interpolated PV inverts to the original week', () => {
    const originalWks = 500;
    const pv = commutation.getPvForWeeks(originalWks);
    expect(commutation.getWeeksForPv(pv)).toBeCloseTo(originalWks, 2);
  });
});

describe('computeLateInterest (LC §5800)', () => {
  it('0 days late → 0 interest', () => {
    expect(commutation.computeLateInterest(10_000, '2026-05-01', '2026-05-01')).toBe(0);
  });

  it('negative days (paid before deadline) → 0 interest', () => {
    expect(commutation.computeLateInterest(10_000, '2026-05-10', '2026-05-01')).toBe(0);
  });

  it('365 days late → exactly amount × 0.10', () => {
    expect(commutation.computeLateInterest(10_000, '2026-01-01', '2027-01-01')).toBe(1000);
  });

  it('scales linearly — 73 days ≈ amount × 0.02', () => {
    const interest = commutation.computeLateInterest(10_000, '2026-01-01', '2026-03-15');
    expect(interest).toBeCloseTo(10_000 * 73 * 0.10 / 365, 2);
  });

  it('zero amount → zero interest regardless of days', () => {
    expect(commutation.computeLateInterest(0, '2026-01-01', '2027-01-01')).toBe(0);
  });
});

describe('commutePdOffFarEnd — DEU Template B', () => {
  // Self-consistent worked example at weeklyRate=$290, 200 weeks remaining,
  // $10,000 commuted off the far end.
  const base = {
    weeklyRate:          290,
    weeksRemainingAtDoc: 200,
    amountToCommute:     10_000,
    docDate:             '2026-05-01',
    actualPayDate:       '2026-05-01',
  };

  it('step 2g: pvRemainingAtDoc = weeklyRate × PV(200)', () => {
    const r = commutation.commutePdOffFarEnd(base);
    const expected = Math.round(290 * commutation.getPvForWeeks(200) * 100) / 100;
    expect(r.pvRemainingAtDoc).toBe(expected);
  });

  it('step 3c: commutedValueAllPd = nominal weeks × rate', () => {
    const r = commutation.commutePdOffFarEnd(base);
    expect(r.commutedValueAllPd).toBe(58_000); // 200 × 290
  });

  it('step 8c: weeksEliminated = amountToCommute / weeklyRate', () => {
    const r = commutation.commutePdOffFarEnd(base);
    expect(r.weeksEliminated).toBeCloseTo(10_000 / 290, 4);
  });

  it('step 6j: weeksRemainingAfterCommutation = weeksRemaining − weeksEliminated', () => {
    const r = commutation.commutePdOffFarEnd(base);
    expect(r.weeksRemainingAfterCommutation).toBeCloseTo(200 - 10_000 / 290, 4);
  });

  it('step 5c: pvRemainingAfterCommutation = rate × PV(weeksAfter)', () => {
    const r = commutation.commutePdOffFarEnd(base);
    const wksAfter = r.weeksRemainingAfterCommutation;
    const expected = Math.round(290 * commutation.getPvForWeeks(wksAfter) * 100) / 100;
    expect(r.pvRemainingAfterCommutation).toBe(expected);
  });

  it('step 4c: pvOfAmountToCommute = pvRemainingAtDoc − pvRemainingAfterCommutation', () => {
    const r = commutation.commutePdOffFarEnd(base);
    expect(r.pvOfAmountToCommute).toBeCloseTo(r.pvRemainingAtDoc - r.pvRemainingAfterCommutation, 2);
  });

  it('step 7c: pdStillOwedAfterDoc = weeksAfter × weeklyRate', () => {
    const r = commutation.commutePdOffFarEnd(base);
    expect(r.pdStillOwedAfterDoc).toBeCloseTo(r.weeksRemainingAfterCommutation * 290, 1);
  });

  it('step 9: interestOwed = 0 when actualPayDate === docDate', () => {
    const r = commutation.commutePdOffFarEnd(base);
    expect(r.interestOwed).toBe(0);
  });

  it('step 9: interestOwed > 0 when actualPayDate > docDate', () => {
    const r = commutation.commutePdOffFarEnd({ ...base, actualPayDate: '2026-07-01' });
    expect(r.interestOwed).toBeGreaterThan(0);
  });

  it('PV(far-end portion) < PV(near-end equivalent) — discount visible', () => {
    // The $10k commuted off the FAR end has lower PV than the same
    // nominal amount coming from the near end, because further-away
    // payments are discounted more.
    const r = commutation.commutePdOffFarEnd(base);
    expect(r.pvOfAmountToCommute).toBeLessThan(10_000);
  });

  it('throws COMMUTE_AMOUNT_EXCEEDS_REMAINING_PD when amount > total owed', () => {
    expect(() => commutation.commutePdOffFarEnd({
      ...base, amountToCommute: 60_000, // > 58_000 nominal
    })).toThrow('COMMUTE_AMOUNT_EXCEEDS_REMAINING_PD');
  });

  it('throws INVALID_WEEKLY_RATE on zero rate', () => {
    expect(() => commutation.commutePdOffFarEnd({ ...base, weeklyRate: 0 })).toThrow('INVALID_WEEKLY_RATE');
  });

  it('throws DEU_RANGE_EXCEEDED when weeksRemainingAtDoc > 950', () => {
    expect(() => commutation.commutePdOffFarEnd({ ...base, weeksRemainingAtDoc: 1000 })).toThrow('DEU_RANGE_EXCEEDED');
  });
});
