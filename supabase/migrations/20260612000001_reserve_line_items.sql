-- ════════════════════════════════════════════════════════════════════════════
-- Itemized Reserve Worksheets (CL-RSV1)
--
-- reserve_line_items replaces flat reserve numbers with an itemized
-- worksheet per claim. Three line shapes:
--   'quantity'   — quantity × unit_amount       (e.g. 5 PTP visits × $250)
--   'weeks_rate' — quantity(weeks) × unit_amount(weekly rate)
--                  (e.g. TD: 6 weeks × claims.td_rate)
--   'flat'       — flat_amount                  (e.g. estimated PD dollars)
-- total is computed server-side from the shape and stored; basis_note
-- carries the human explanation (e.g. "PTP visits per PR-1 treatment
-- plan"). Statutory rate values are never synthesized here — weekly
-- rates come from the claim record, PD dollars from the M13 services.
--
-- Worksheets FEED the M3 reserve approval workflow; they never bypass
-- it. Category subtotals roll up into a PROPOSED reserve change that
-- requires the same adjuster approval (approveReserves) it does today.
--
-- DEPLOYMENT ORDER: apply before deploying the worksheet backend
-- (migrate → deploy, always).
--
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS reserve_line_items (
  id           TEXT PRIMARY KEY,
  claim_id     VARCHAR(60) NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  label        TEXT NOT NULL,
  shape        TEXT NOT NULL DEFAULT 'quantity',
  quantity     NUMERIC(10,2),
  unit_amount  NUMERIC(12,2),
  flat_amount  NUMERIC(12,2),
  total        NUMERIC(12,2) NOT NULL,
  basis_note   TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reserve_line_items_category_chk
    CHECK (category IN ('medical', 'indemnity', 'expense')),
  CONSTRAINT reserve_line_items_shape_chk
    CHECK (shape IN ('quantity', 'weeks_rate', 'flat')),
  CONSTRAINT reserve_line_items_total_chk
    CHECK (total >= 0),
  CONSTRAINT reserve_line_items_shape_fields_chk
    CHECK (
      (shape IN ('quantity', 'weeks_rate') AND quantity IS NOT NULL AND unit_amount IS NOT NULL)
      OR (shape = 'flat' AND flat_amount IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS reserve_line_items_claim_idx
  ON reserve_line_items (claim_id, category);

COMMIT;
