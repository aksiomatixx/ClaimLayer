-- ============================================================
-- M22A — C&R settlement breakdown columns
--
-- Extends settlement_offers with PD/medical/attorney-fee/other
-- breakdown for C&R settlements. Required by M22A WCIS SROI PY
-- transactions (DN85 5xx compromised codes per guide Section M).
-- Also usable by DEU Form 110 generation in future milestones.
--
-- Breakdown has two states tracked by cnr_breakdown_source:
--   'estimate'   — captured at offer finalization, pre-OACR
--   'oacr_final' — confirmed/updated after WCAB judge approval
--
-- At recordPayment time, SROI PY uses final breakdown if present
-- and sum-matches cnr_value. Otherwise falls back to single-line
-- DN85 500 (unspecified) for full amount with data quality warning.
-- ============================================================

BEGIN;

ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS
  cnr_pd_amount NUMERIC(10,2);
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS
  cnr_medical_amount NUMERIC(10,2);
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS
  cnr_attorney_fee_amount NUMERIC(10,2);
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS
  cnr_other_amount NUMERIC(10,2);
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS
  cnr_breakdown_source VARCHAR(20)
    CONSTRAINT settlement_offers_cnr_breakdown_source_chk
    CHECK (cnr_breakdown_source IS NULL OR
           cnr_breakdown_source IN ('estimate','oacr_final'));

COMMIT;
