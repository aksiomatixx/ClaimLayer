'use strict';

/**
 * California state holidays per Government Code §6700.
 * Returns a Set of YYYY-MM-DD strings for the given year.
 */
function getCaliforniaHolidays(year) {
  const holidays = new Set();

  const fmt = (d) => d.toISOString().split('T')[0];

  const fixed = (month, day) => {
    const date = new Date(Date.UTC(year, month - 1, day));
    // If Saturday → observe Friday; if Sunday → observe Monday
    if (date.getUTCDay() === 6) return new Date(Date.UTC(year, month - 1, day - 1));
    if (date.getUTCDay() === 0) return new Date(Date.UTC(year, month - 1, day + 1));
    return date;
  };

  const nthWeekday = (month, weekday, n) => {
    // weekday: 0=Sun, 1=Mon ... 6=Sat
    // n: 1-based positive (first, second...) or -1 (last)
    if (n > 0) {
      const first = new Date(Date.UTC(year, month - 1, 1));
      const diff = (weekday - first.getUTCDay() + 7) % 7;
      return new Date(Date.UTC(year, month - 1, 1 + diff + (n - 1) * 7));
    } else {
      // last weekday of month
      const last = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day of this month
      const diff = (last.getUTCDay() - weekday + 7) % 7;
      return new Date(Date.UTC(year, month, -diff));
    }
  };

  // Fixed holidays (with Saturday/Sunday observation shift)
  holidays.add(fmt(fixed(1,  1)));   // New Year's Day
  holidays.add(fmt(fixed(3,  31)));  // César Chávez Day
  holidays.add(fmt(fixed(6,  19)));  // Juneteenth
  holidays.add(fmt(fixed(7,  4)));   // Independence Day
  holidays.add(fmt(fixed(11, 11)));  // Veterans Day
  holidays.add(fmt(fixed(12, 25)));  // Christmas Day

  // Floating holidays
  holidays.add(fmt(nthWeekday(1,  1, 3)));  // MLK Jr. Day      — 3rd Monday January
  holidays.add(fmt(nthWeekday(2,  1, 3)));  // Presidents' Day  — 3rd Monday February
  holidays.add(fmt(nthWeekday(5,  1, -1))); // Memorial Day     — last Monday May
  holidays.add(fmt(nthWeekday(9,  1, 1)));  // Labor Day        — 1st Monday September
  holidays.add(fmt(nthWeekday(10, 1, 2)));  // Indigenous Peoples Day — 2nd Monday October (DWC observes)
  holidays.add(fmt(nthWeekday(11, 4, 4)));  // Thanksgiving     — 4th Thursday November

  return holidays;
}

// Year-keyed cache — populated on first use
const _cache = {};
function _getCachedHolidays(year) {
  if (!_cache[year]) _cache[year] = getCaliforniaHolidays(year);
  return _cache[year];
}

/**
 * Add n business days to a date, skipping weekends and CA state holidays.
 *
 * NOTE: Do NOT use this for LC §5402 compensability deadlines — those are
 * calendar days. Use plain date arithmetic for those.
 *
 * @param {Date|string} startDate  ISO date string or Date object.
 * @param {number}      days       Number of business days to add.
 * @returns {Date}
 */
function addBusinessDays(startDate, days) {
  // Parse ISO strings as UTC midnight to avoid timezone drift
  let current = typeof startDate === 'string'
    ? new Date(startDate + (startDate.includes('T') ? '' : 'T00:00:00Z'))
    : new Date(startDate);

  let added = 0;
  while (added < days) {
    current = new Date(current.getTime() + 86400000); // +1 day in ms
    const dow     = current.getUTCDay();
    const dateStr = current.toISOString().split('T')[0];
    const year    = current.getUTCFullYear();

    if (dow !== 0 && dow !== 6 && !_getCachedHolidays(year).has(dateStr)) {
      added++;
    }
  }

  return current;
}

module.exports = { addBusinessDays, getCaliforniaHolidays };
