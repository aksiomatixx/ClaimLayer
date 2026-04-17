-- M14: Compromise and Release (no-MSA only) — additive workflow columns on settlement_offers.
--
-- Builds on M19 (msa_screenings, settlement_offers). No new tables.
-- C&R is blocked when MSA is required — see backend/src/services/cnrService.js and
-- the pre-pricing MSA gate added in backend/src/services/pdPricingService.js.
--
-- DO NOT RUN AUTOMATICALLY. Review and apply manually via:
--   supabase db push
-- or
--   psql -f supabase/migrations/20260101000010_m14_cnr.sql
--
-- Ordering (enforced in service, not DB):
--   draft → offered → accepted → signed → eams_ready → filed → oacr_received → paid
--   draft   → rejected | withdrawn (terminal)
--   offered → rejected | withdrawn (terminal)

-- ═════════════════════════════════════════════════════════════════════════════
-- Additive workflow columns
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS offered_at           TIMESTAMPTZ;
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS offered_to           VARCHAR(10)
  CHECK (offered_to IS NULL OR offered_to IN ('worker', 'attorney'));
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS worker_signed_at     TIMESTAMPTZ;
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS adjuster_signed_at   TIMESTAMPTZ;
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS adjuster_signed_by   UUID;
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS rejected_at          TIMESTAMPTZ;
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS rejected_reason      TEXT;
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS withdrawn_at         TIMESTAMPTZ;
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS withdrawn_reason     TEXT;
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS cnr_document_id      UUID;
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS eams_package_ready   BOOLEAN DEFAULT FALSE;
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS eams_filed_at        DATE;
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS eams_filed_by        UUID;
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS wcab_oacr_received_at DATE;
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS payment_due_date     DATE;
ALTER TABLE settlement_offers ADD COLUMN IF NOT EXISTS paid_at              DATE;

-- ═════════════════════════════════════════════════════════════════════════════
-- Expand the status CHECK constraint
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE settlement_offers DROP CONSTRAINT IF EXISTS settlement_offers_status_check;
ALTER TABLE settlement_offers ADD CONSTRAINT settlement_offers_status_check
  CHECK (status IN (
    'draft', 'offered', 'accepted', 'rejected', 'withdrawn',
    'signed', 'eams_ready', 'filed', 'oacr_received', 'paid'
  ));

-- ═════════════════════════════════════════════════════════════════════════════
-- Index for offers awaiting EAMS/OACR action
-- ═════════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_settlement_pending_filing
  ON settlement_offers(status) WHERE status IN ('eams_ready', 'filed');

-- RLS: existing settlement_admin policy (M19) covers the new columns — no change.
