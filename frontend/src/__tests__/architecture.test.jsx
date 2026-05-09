/**
 * Smoke test placeholder — Architecture page.
 *
 * SKIPPED: frontend has no test runner configured (no vitest / jest /
 * @testing-library/react in frontend/package.json devDependencies; the
 * npm test script just exits 1, and there are no executing *.test.jsx
 * files). Per the milestone's "if no pattern exists, skip with a
 * one-line note" rule, this file is a placeholder documenting the
 * smoke checks that should be wired once a frontend test runner is
 * added.
 *
 * MANUAL SMOKE CHECKLIST (verify before each release):
 *   1. Open admin console → top nav → click "Architecture".
 *   2. Page header renders with the headline sentence + "Download as PDF" button.
 *   3. Lifecycle SVG renders 11 boxes (new_claim … closed) with
 *      green / amber / blue color coding and arrow connectors.
 *   4. Agent Registry shows 5 cards (Compensability Analyst,
 *      RFA / MTUS Evaluator, C&R Pricing Engine, MSA Screening Gate,
 *      Voice Intake Extractor). Each card shows live "30d" decision
 *      count from /api/v1/ai-decisions/stats and an override %.
 *   5. Click "View prompt →" on the Compensability Analyst card →
 *      modal opens with prompt text loaded from
 *      /api/v1/prompts/compensability_analysis.
 *   6. Guardrail Catalog shows ≥12 rows (Rule / Where / Why columns).
 *   7. Human-in-the-Loop Checkpoints shows ≥9 rows.
 *   8. Regulatory Data Sources reads from docs/regulatory/sources.json
 *      and renders ≥12 rows.
 *   9. Each section's chevron toggles open/closed when clicked.
 *  10. Click "Download as PDF" → window.print() fires; the print
 *      stylesheet hides chevrons + the print button itself, applies
 *      white background, and forces sections to be all-open.
 *
 * Backend coverage (which DOES run): the /ai-decisions/stats and
 * /prompts/:name routes that this page consumes are tested in
 * backend/tests/integration/ai-decisions.test.js (16 tests including
 * stats shape + path-traversal rejection).
 */

describe.skip('Architecture page smoke (placeholder — no frontend test runner configured)', () => {
  it('placeholder — see file header for the manual smoke checklist', () => {});
});
