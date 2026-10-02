-- ═════════════════════════════════════════════════════════════════════════════
-- 20261005000005_settlement_offers_updated_at.sql
-- Add updated_at column to settlement_offers for mutation tracking and audit compliance.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE settlement_offers
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

COMMIT;
