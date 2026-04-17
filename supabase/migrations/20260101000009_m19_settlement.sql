-- M19: Settlement Foundation — MSA Screening, PDRS Extension, Settlement Offers
--
-- Extends pdrs_lookup from M13 with body-part-specific ranges and adjustment factors.
-- Adds msa_screenings and settlement_offers tables.
--
-- DO NOT RUN AUTOMATICALLY. Review and apply manually.
--
-- PDRS SEED DATA intentionally excluded from this migration.
-- Must be seeded from official DWC 2005 PDRS schedule before settlement
-- functionality is used against live claims.
-- See [TODO: seed script path] for seeding instructions.

-- ═════════════════════════════════════════════════════════════════════════════
-- Extend pdrs_lookup with body-part context and adjustment factors
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE pdrs_lookup ADD COLUMN IF NOT EXISTS body_part       VARCHAR(100);
ALTER TABLE pdrs_lookup ADD COLUMN IF NOT EXISTS wpi_min         NUMERIC(5,2);
ALTER TABLE pdrs_lookup ADD COLUMN IF NOT EXISTS wpi_max         NUMERIC(5,2);
ALTER TABLE pdrs_lookup ADD COLUMN IF NOT EXISTS base_rating     NUMERIC(5,2);
ALTER TABLE pdrs_lookup ADD COLUMN IF NOT EXISTS age_adjustment_json        JSONB;
ALTER TABLE pdrs_lookup ADD COLUMN IF NOT EXISTS occupation_adjustment_json JSONB;

-- ═════════════════════════════════════════════════════════════════════════════
-- MSA Screenings
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS msa_screenings (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id                  VARCHAR(60) REFERENCES claims(id),
  screened_at               TIMESTAMPTZ DEFAULT NOW(),
  medicare_eligible         BOOLEAN NOT NULL,
  medicare_eligibility_reason TEXT,
  age_at_screening          SMALLINT,
  ssdi_receiving            BOOLEAN DEFAULT FALSE,
  projected_settlement_value NUMERIC(10,2),
  msa_required              BOOLEAN NOT NULL,
  msa_required_reason       TEXT,
  screened_by               UUID
);

CREATE INDEX IF NOT EXISTS idx_msa_claim ON msa_screenings(claim_id);

ALTER TABLE msa_screenings ENABLE ROW LEVEL SECURITY;
CREATE POLICY msa_admin ON msa_screenings FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));

-- ═════════════════════════════════════════════════════════════════════════════
-- Settlement Offers
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS settlement_offers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id            VARCHAR(60) REFERENCES claims(id),
  offer_type          VARCHAR(10) NOT NULL CHECK (offer_type IN ('stip', 'cnr')),
  stip_value          NUMERIC(10,2),
  cnr_value           NUMERIC(10,2),
  cnr_premium_pct     NUMERIC(5,2),
  priced_at           TIMESTAMPTZ DEFAULT NOW(),
  pricing_method      VARCHAR(30),  -- 'pdrs_deterministic' | 'claude_ai'
  msa_screening_id    UUID REFERENCES msa_screenings(id),
  status              VARCHAR(20) DEFAULT 'draft'
                      CHECK (status IN ('draft', 'offered', 'accepted', 'rejected', 'withdrawn')),
  created_by          UUID,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlement_claim  ON settlement_offers(claim_id);
CREATE INDEX IF NOT EXISTS idx_settlement_status ON settlement_offers(status) WHERE status NOT IN ('accepted', 'rejected', 'withdrawn');

ALTER TABLE settlement_offers ENABLE ROW LEVEL SECURITY;
CREATE POLICY settlement_admin ON settlement_offers FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));
