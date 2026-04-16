-- M13: Stipulation + PD Closure + PD Advances
-- Creates pdrs_lookup, pd_evaluations, pd_advances, stipulations tables.
-- Seeds 5 representative PDRS rows for testing.
--
-- DO NOT RUN AUTOMATICALLY. Review and apply manually via:
--   supabase db push
-- or
--   psql -f supabase/migrations/20260101000008_m13_pd.sql

-- ── PDRS Lookup Table (2005 PDRS — CA WC standard) ──────────────────────────
CREATE TABLE IF NOT EXISTS pdrs_lookup (
  wpi_percent      NUMERIC(5,2) NOT NULL,
  age_factor       NUMERIC(5,3) NOT NULL DEFAULT 1.0,
  occupation_group SMALLINT NOT NULL DEFAULT 1,
  pd_percent       NUMERIC(5,2) NOT NULL,
  weekly_pd_weeks  NUMERIC(7,2) NOT NULL,
  PRIMARY KEY (wpi_percent, age_factor, occupation_group)
);

-- ── PD Evaluations ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pd_evaluations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              VARCHAR(60) REFERENCES claims(id),
  pr4_id                UUID REFERENCES pr4_solicitations(id),
  wpi                   NUMERIC(5,2) NOT NULL,
  age_at_doi            SMALLINT,
  occupation_group      SMALLINT DEFAULT 1,
  pd_percent            NUMERIC(5,2),
  pd_weeks              NUMERIC(7,2),
  pd_weekly_rate        NUMERIC(8,2),
  pd_total_value        NUMERIC(10,2),
  apportionment_percent NUMERIC(5,2) DEFAULT 0,
  adjusted_pd_percent   NUMERIC(5,2),
  adjusted_total_value  NUMERIC(10,2),
  calculated_at         TIMESTAMPTZ DEFAULT NOW(),
  calculated_by         UUID,
  notes                 TEXT
);

-- ── PD Advances ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pd_advances (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id          VARCHAR(60) REFERENCES claims(id),
  pd_evaluation_id  UUID REFERENCES pd_evaluations(id),
  td_end_date       DATE NOT NULL,
  advance_due_date  DATE NOT NULL,  -- td_end_date + 14 calendar days
  weekly_rate       NUMERIC(8,2) NOT NULL,
  first_payment_at  TIMESTAMPTZ,
  status            VARCHAR(20) DEFAULT 'pending'
                    CHECK (status IN ('pending', 'active', 'completed', 'waived')),
  waived_reason     TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── Stipulations ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stipulations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              VARCHAR(60) REFERENCES claims(id),
  pd_evaluation_id      UUID REFERENCES pd_evaluations(id),
  pd_percent            NUMERIC(5,2) NOT NULL,
  pd_total_value        NUMERIC(10,2) NOT NULL,
  future_medical        BOOLEAN DEFAULT FALSE,
  future_medical_desc   TEXT,
  body_parts_accepted   TEXT[],
  worker_signed_at      TIMESTAMPTZ,
  adjuster_signed_at    TIMESTAMPTZ,
  eams_package_ready    BOOLEAN DEFAULT FALSE,
  eams_filed_at         DATE,         -- manual entry by adjuster
  status                VARCHAR(30) DEFAULT 'draft'
                        CHECK (status IN (
                          'draft', 'sent_to_worker', 'worker_signed',
                          'adjuster_signed', 'eams_ready', 'filed', 'closed'
                        )),
  created_by            UUID,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pd_eval_claim  ON pd_evaluations(claim_id);
CREATE INDEX IF NOT EXISTS idx_pd_adv_claim   ON pd_advances(claim_id);
CREATE INDEX IF NOT EXISTS idx_pd_adv_status  ON pd_advances(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_stip_claim     ON stipulations(claim_id);
CREATE INDEX IF NOT EXISTS idx_stip_status    ON stipulations(status) WHERE status != 'closed';

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE pdrs_lookup    ENABLE ROW LEVEL SECURITY;
ALTER TABLE pd_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pd_advances    ENABLE ROW LEVEL SECURITY;
ALTER TABLE stipulations   ENABLE ROW LEVEL SECURITY;

CREATE POLICY pdrs_read ON pdrs_lookup FOR SELECT TO authenticated USING (true);
CREATE POLICY pd_eval_admin ON pd_evaluations FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));
CREATE POLICY pd_adv_admin ON pd_advances FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));
CREATE POLICY stip_admin ON stipulations FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));

-- ── Seed PDRS data (2005 PDRS, age_factor 1.0, occupation_group 1) ──────────
-- Realistic values per 2005 PDRS schedule. PD% derived from standard formula.
INSERT INTO pdrs_lookup (wpi_percent, age_factor, occupation_group, pd_percent, weekly_pd_weeks) VALUES
  (5.00,   1.000, 1,  8.00,   24.00),    -- 5% WPI → 8% PD → 24 weeks
  (10.00,  1.000, 1, 16.00,   48.00),    -- 10% WPI → 16% PD → 48 weeks
  (15.00,  1.000, 1, 24.00,   72.75),    -- 15% WPI → 24% PD → 72.75 weeks
  (25.00,  1.000, 1, 40.00,  137.50),    -- 25% WPI → 40% PD → 137.5 weeks
  (50.00,  1.000, 1, 70.00,  344.75)     -- 50% WPI → 70% PD → 344.75 weeks
ON CONFLICT DO NOTHING;
