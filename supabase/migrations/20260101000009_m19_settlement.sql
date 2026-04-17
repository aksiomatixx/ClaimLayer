-- M19: Settlement Foundation — MSA Screening, PDRS Extension, Settlement Offers
--
-- Extends pdrs_lookup from M13 with body-part-specific ranges and adjustment factors.
-- Adds msa_screenings and settlement_offers tables.
--
-- DO NOT RUN AUTOMATICALLY. Review and apply manually.
-- NOTE: PDRS seed data below is derived from the 2005 PDRS schedule.
--       Akash MUST review all seed values before applying.

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

-- ═════════════════════════════════════════════════════════════════════════════
-- Extended PDRS seed data (2005 schedule, body-part-specific)
-- *** AKASH: REVIEW ALL VALUES BEFORE APPLYING ***
-- Age adjustment JSON: keys are age brackets, values are multipliers
-- Occupation adjustment JSON: keys are occupation groups (1-15), values are multipliers
-- ═════════════════════════════════════════════════════════════════════════════

-- Spine (Lumbar) — most common home health injury
UPDATE pdrs_lookup SET
  body_part = 'Lumbar Spine',
  wpi_min = 0, wpi_max = 28,
  base_rating = 1.4,
  age_adjustment_json = '{"25-29":0.94,"30-34":0.97,"35-39":1.00,"40-44":1.04,"45-49":1.07,"50-54":1.11,"55-59":1.15,"60-64":1.19}',
  occupation_adjustment_json = '{"1":1.00,"2":1.04,"3":1.07,"4":1.10,"5":1.13,"6":1.16,"7":1.19,"8":1.22}'
WHERE wpi_percent = 5.00 AND age_factor = 1.000 AND occupation_group = 1;

UPDATE pdrs_lookup SET
  body_part = 'Lumbar Spine',
  wpi_min = 0, wpi_max = 28,
  base_rating = 1.4,
  age_adjustment_json = '{"25-29":0.94,"30-34":0.97,"35-39":1.00,"40-44":1.04,"45-49":1.07,"50-54":1.11,"55-59":1.15,"60-64":1.19}',
  occupation_adjustment_json = '{"1":1.00,"2":1.04,"3":1.07,"4":1.10,"5":1.13,"6":1.16,"7":1.19,"8":1.22}'
WHERE wpi_percent = 10.00 AND age_factor = 1.000 AND occupation_group = 1;

UPDATE pdrs_lookup SET
  body_part = 'Lumbar Spine',
  wpi_min = 0, wpi_max = 28,
  base_rating = 1.4,
  age_adjustment_json = '{"25-29":0.94,"30-34":0.97,"35-39":1.00,"40-44":1.04,"45-49":1.07,"50-54":1.11,"55-59":1.15,"60-64":1.19}',
  occupation_adjustment_json = '{"1":1.00,"2":1.04,"3":1.07,"4":1.10,"5":1.13,"6":1.16,"7":1.19,"8":1.22}'
WHERE wpi_percent = 15.00 AND age_factor = 1.000 AND occupation_group = 1;

UPDATE pdrs_lookup SET
  body_part = 'Lumbar Spine',
  wpi_min = 0, wpi_max = 28,
  base_rating = 1.4,
  age_adjustment_json = '{"25-29":0.94,"30-34":0.97,"35-39":1.00,"40-44":1.04,"45-49":1.07,"50-54":1.11,"55-59":1.15,"60-64":1.19}',
  occupation_adjustment_json = '{"1":1.00,"2":1.04,"3":1.07,"4":1.10,"5":1.13,"6":1.16,"7":1.19,"8":1.22}'
WHERE wpi_percent = 25.00 AND age_factor = 1.000 AND occupation_group = 1;

UPDATE pdrs_lookup SET
  body_part = 'Lumbar Spine',
  wpi_min = 0, wpi_max = 28,
  base_rating = 1.4,
  age_adjustment_json = '{"25-29":0.94,"30-34":0.97,"35-39":1.00,"40-44":1.04,"45-49":1.07,"50-54":1.11,"55-59":1.15,"60-64":1.19}',
  occupation_adjustment_json = '{"1":1.00,"2":1.04,"3":1.07,"4":1.10,"5":1.13,"6":1.16,"7":1.19,"8":1.22}'
WHERE wpi_percent = 50.00 AND age_factor = 1.000 AND occupation_group = 1;

-- Additional body parts (new rows — common home health injuries)
INSERT INTO pdrs_lookup (wpi_percent, age_factor, occupation_group, pd_percent, weekly_pd_weeks, body_part, wpi_min, wpi_max, base_rating, age_adjustment_json, occupation_adjustment_json) VALUES
  -- Shoulder
  (5.00,  1.000, 1,  7.00,  21.00, 'Shoulder', 0, 24, 1.4,
   '{"25-29":0.94,"30-34":0.97,"35-39":1.00,"40-44":1.04,"45-49":1.07,"50-54":1.11,"55-59":1.15,"60-64":1.19}',
   '{"1":1.00,"2":1.04,"3":1.07,"4":1.10,"5":1.13}'),
  (10.00, 1.000, 1, 14.00,  42.00, 'Shoulder', 0, 24, 1.4,
   '{"25-29":0.94,"30-34":0.97,"35-39":1.00,"40-44":1.04,"45-49":1.07,"50-54":1.11,"55-59":1.15,"60-64":1.19}',
   '{"1":1.00,"2":1.04,"3":1.07,"4":1.10,"5":1.13}'),
  (15.00, 1.000, 1, 22.00,  66.00, 'Shoulder', 0, 24, 1.4,
   '{"25-29":0.94,"30-34":0.97,"35-39":1.00,"40-44":1.04,"45-49":1.07,"50-54":1.11,"55-59":1.15,"60-64":1.19}',
   '{"1":1.00,"2":1.04,"3":1.07,"4":1.10,"5":1.13}'),

  -- Knee
  (5.00,  1.000, 1,  7.00,  21.00, 'Knee', 0, 35, 1.4,
   '{"25-29":0.94,"30-34":0.97,"35-39":1.00,"40-44":1.04,"45-49":1.07,"50-54":1.11,"55-59":1.15,"60-64":1.19}',
   '{"1":1.00,"2":1.04,"3":1.07,"4":1.10,"5":1.13}'),
  (10.00, 1.000, 1, 14.00,  42.00, 'Knee', 0, 35, 1.4,
   '{"25-29":0.94,"30-34":0.97,"35-39":1.00,"40-44":1.04,"45-49":1.07,"50-54":1.11,"55-59":1.15,"60-64":1.19}',
   '{"1":1.00,"2":1.04,"3":1.07,"4":1.10,"5":1.13}'),
  (25.00, 1.000, 1, 38.00, 131.00, 'Knee', 0, 35, 1.4,
   '{"25-29":0.94,"30-34":0.97,"35-39":1.00,"40-44":1.04,"45-49":1.07,"50-54":1.11,"55-59":1.15,"60-64":1.19}',
   '{"1":1.00,"2":1.04,"3":1.07,"4":1.10,"5":1.13}'),

  -- Wrist / Hand
  (5.00,  1.000, 1,  7.00,  21.00, 'Wrist / Hand', 0, 18, 1.4,
   '{"25-29":0.94,"30-34":0.97,"35-39":1.00,"40-44":1.04,"45-49":1.07,"50-54":1.11,"55-59":1.15,"60-64":1.19}',
   '{"1":1.00,"2":1.04,"3":1.07,"4":1.10,"5":1.13}'),
  (10.00, 1.000, 1, 14.00,  42.00, 'Wrist / Hand', 0, 18, 1.4,
   '{"25-29":0.94,"30-34":0.97,"35-39":1.00,"40-44":1.04,"45-49":1.07,"50-54":1.11,"55-59":1.15,"60-64":1.19}',
   '{"1":1.00,"2":1.04,"3":1.07,"4":1.10,"5":1.13}'),

  -- Cervical Spine / Neck
  (5.00,  1.000, 1,  8.00,  24.00, 'Cervical Spine', 0, 28, 1.4,
   '{"25-29":0.94,"30-34":0.97,"35-39":1.00,"40-44":1.04,"45-49":1.07,"50-54":1.11,"55-59":1.15,"60-64":1.19}',
   '{"1":1.00,"2":1.04,"3":1.07,"4":1.10,"5":1.13}'),
  (10.00, 1.000, 1, 16.00,  48.00, 'Cervical Spine', 0, 28, 1.4,
   '{"25-29":0.94,"30-34":0.97,"35-39":1.00,"40-44":1.04,"45-49":1.07,"50-54":1.11,"55-59":1.15,"60-64":1.19}',
   '{"1":1.00,"2":1.04,"3":1.07,"4":1.10,"5":1.13}'),
  (15.00, 1.000, 1, 24.00,  72.75, 'Cervical Spine', 0, 28, 1.4,
   '{"25-29":0.94,"30-34":0.97,"35-39":1.00,"40-44":1.04,"45-49":1.07,"50-54":1.11,"55-59":1.15,"60-64":1.19}',
   '{"1":1.00,"2":1.04,"3":1.07,"4":1.10,"5":1.13}')

ON CONFLICT DO NOTHING;
