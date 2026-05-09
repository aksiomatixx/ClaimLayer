/**
 * Smoke test placeholder — Benefits tab.
 *
 * SKIPPED: frontend has no test runner configured (no vitest / jest /
 * @testing-library/react in frontend/package.json devDependencies; the
 * npm test script just exits 1, and there are no existing *.test.jsx
 * files). Per the milestone's "if no pattern exists, skip with a
 * one-line note" rule, this file is a placeholder documenting the
 * smoke checks that should be wired once a frontend test runner is
 * added.
 *
 * MANUAL SMOKE CHECKLIST (verify before each release):
 *   1. Open admin console → All Claims → click any claim → drawer opens.
 *   2. Click "Benefits" tab.
 *   3. With NO td_periods on the claim:
 *        - TdSummaryCard renders "None Active" / "0 weeks paid" / "0 / 104".
 *        - "Start TD Period" button is visible top-right.
 *        - Empty-state placeholder "No TD periods recorded." is visible.
 *        - TdTimeline + TdPeriodsTable are NOT rendered.
 *   4. Click "Start TD Period" → modal opens with TTD default,
 *      start_date=today, weekly_rate prefilled from claim.tdRate.
 *   5. Submit → row appears in TdPeriodsTable, summary card updates,
 *      timeline renders the new period bar.
 *   6. Open another period → warning banner appears in modal,
 *      previous period auto-closes effective new start - 1 day.
 *
 * Pure-helper coverage already exists at the backend layer via
 * tests/unit/tdPeriodsService.test.js (summary math, cap math).
 */

describe.skip('Benefits tab smoke (placeholder — no frontend test runner configured)', () => {
  it('placeholder — see file header for the manual smoke checklist', () => {});
});
