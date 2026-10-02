'use strict';

const statutory = require('../../src/services/statutoryCalculators');

describe('statutoryCalculators (Phase 4 — D-3 & D-4 Fixes)', () => {
  describe('AWW calculations (Labor Code §4453, D-3)', () => {
    test('computes AWW correctly for weekly pay statements without halving', () => {
      // 4 weekly statements of $800 each
      const payStatements = [
        { grossPay: 800 },
        { grossPay: 800 },
        { grossPay: 800 },
        { grossPay: 800 },
      ];

      const res = statutory.calculateAWW({
        payStatements,
        payFrequency: 'weekly',
      });

      expect(res.totalGross).toBe(3200);
      expect(res.aww).toBe(800); // Prior bug divided by 8 instead of 4, yielding $400!
    });

    test('computes AWW correctly for biweekly pay statements', () => {
      const payStatements = [
        { grossPay: 1600 },
        { grossPay: 1600 },
      ];

      const res = statutory.calculateAWW({
        payStatements,
        payFrequency: 'biweekly',
      });

      expect(res.totalGross).toBe(3200);
      expect(res.aww).toBe(800); // 3200 / 4 weeks = 800
    });

    test('aggregates concurrent multiple employment wages under LC §4453(c)(2)', () => {
      const payStatements = [{ grossPay: 1600 }]; // $800/wk base
      const concurrent = [{ weeklyWage: 250 }]; // Second job pays $250/wk

      const res = statutory.calculateAWW({
        payStatements,
        payFrequency: 'biweekly',
        concurrentEmployments: concurrent,
      });

      expect(res.baseAWW).toBe(800);
      expect(res.concurrentAWW).toBe(250);
      expect(res.aww).toBe(1050);
    });
  });

  describe('TD Rate calculations by Date of Injury (D-4)', () => {
    test('applies 2026 statutory rates for 2026 injury', () => {
      const res = statutory.calculateTDRate({
        aww: 1200,
        dateOfInjury: '2026-03-15',
      });

      expect(res.statutoryYear).toBe(2026);
      expect(res.statutoryMin).toBe(252.03);
      expect(res.statutoryMax).toBe(1680.29);
      expect(res.tdRate).toBe(800); // 1200 * 2/3 = 800
    });

    test('caps at statutory maximum for high earners', () => {
      const res = statutory.calculateTDRate({
        aww: 3000,
        dateOfInjury: '2026-03-15',
      });

      expect(res.tdRate).toBe(1680.29); // 2026 maximum cap
    });

    test('applies 2022 historical statutory rates for 2022 injury', () => {
      const res = statutory.calculateTDRate({
        aww: 2500,
        dateOfInjury: '2022-05-10',
      });

      expect(res.statutoryYear).toBe(2022);
      expect(res.statutoryMax).toBe(1539.71); // 2022 cap
      expect(res.tdRate).toBe(1539.71);
    });

    test('reads the DOI year from the date itself, not the server time zone', () => {
      const tz = process.env.TZ;
      process.env.TZ = 'America/Los_Angeles';
      try {
        expect(statutory.getTDSchedule('2026-01-01').year).toBe(2026);
        expect(statutory.getTDSchedule('2026-01-01T00:00:00Z').year).toBe(2026);
      } finally {
        process.env.TZ = tz;
      }
    });

    test('a DOI outside the table is refused, not priced with another year', () => {
      expect(() => statutory.getTDSchedule('2018-06-01')).toThrow(/TD_SCHEDULE_UNAVAILABLE/);
      expect(() => statutory.calculateTDRate({ aww: 1000, dateOfInjury: '2031-02-01' })).toThrow(/TD_SCHEDULE_UNAVAILABLE/);
    });

    test('only the corroborated year is reported as verified (REGULATORY-PENDING rows say so)', () => {
      expect(statutory.calculateTDRate({ aww: 1200, dateOfInjury: '2026-03-15' }).statutoryScheduleVerified).toBe(true);
      expect(statutory.calculateTDRate({ aww: 1200, dateOfInjury: '2022-05-10' }).statutoryScheduleVerified).toBe(false);
    });

    test('awards 100% of actual earnings if below statutory minimum (LC §4453(a))', () => {
      const res = statutory.calculateTDRate({
        aww: 180.00,
        dateOfInjury: '2026-01-01',
      });

      expect(res.tdRate).toBe(180.00);
    });
  });

  describe('2005 PDRS Permanent Disability Formula', () => {
    test('calculates rating from WPI through FEC, Occupational Variant, and Age', () => {
      const rating = statutory.calculatePDRating({
        wpi: 15,
        bodySystem: 'spine',
        occupationalVariant: 'G',
        ageAtInjury: 48,
      });

      expect(rating.wpi).toBe(15);
      expect(rating.breakdown.step2_fec_multiplier).toBe(1.40);
      expect(rating.breakdown.step2_post_fec).toBe(21); // 15 * 1.4 = 21
      expect(rating.breakdown.step3_variant).toBe('G');
      expect(rating.breakdown.step3_occ_delta).toBe(2);
      expect(rating.breakdown.step3_post_occ).toBe(23); // 21 + 2 = 23
      expect(rating.breakdown.step4_age_delta).toBe(2); // Age 48 = +2
      expect(rating.finalPD).toBe(25); // 23 + 2 = 25%
      expect(rating.weeksPD).toBeGreaterThan(0);
      expect(rating.statutoryTotal).toBeGreaterThan(0);
    });
  });
});
