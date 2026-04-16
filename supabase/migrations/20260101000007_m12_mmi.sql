-- M12: MMI Management + PR-4 Solicitation
-- Creates mmi_evaluations and pr4_solicitations tables.
--
-- DO NOT RUN AUTOMATICALLY. Review and apply manually via:
--   supabase db push
-- or
--   psql -f supabase/migrations/20260101000007_m12_mmi.sql

-- ── MMI Evaluations ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mmi_evaluations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id          VARCHAR(60) REFERENCES claims(id),
  evaluated_at      TIMESTAMPTZ DEFAULT NOW(),
  signals           JSONB NOT NULL,   -- array of signal objects: {type, description, weight}
  signal_count      SMALLINT NOT NULL,
  recommendation    VARCHAR(30) NOT NULL CHECK (recommendation IN (
                      'no_action', 'monitor', 'solicit_pr4'
                    )),
  rationale         TEXT,
  adjuster_action   VARCHAR(30) CHECK (adjuster_action IN (
                      'dismissed', 'pr4_solicited', 'monitoring'
                    )),
  adjuster_id       UUID,
  adjuster_note     TEXT,
  acted_at          TIMESTAMPTZ
);

-- ── PR-4 Solicitations ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pr4_solicitations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              VARCHAR(60) REFERENCES claims(id),
  mmi_evaluation_id     UUID REFERENCES mmi_evaluations(id),
  solicitation_date     DATE NOT NULL,
  response_due_date     DATE NOT NULL,   -- 30 calendar days from solicitation
  physician_name        VARCHAR(200),
  physician_fax         VARCHAR(30),
  physician_address     TEXT,
  method                VARCHAR(20) DEFAULT 'lob' CHECK (method IN ('lob', 'fax', 'email')),
  lob_letter_id         VARCHAR(100),
  response_received_at  TIMESTAMPTZ,
  wpi                   NUMERIC(5,2),   -- whole person impairment %
  work_restrictions     TEXT,
  future_medical        TEXT,
  apportionment_noted   BOOLEAN DEFAULT FALSE,
  status                VARCHAR(30) DEFAULT 'sent'
                        CHECK (status IN ('sent', 'received', 'overdue', 'closed')),
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mmi_claim  ON mmi_evaluations(claim_id);
CREATE INDEX IF NOT EXISTS idx_pr4_claim  ON pr4_solicitations(claim_id);
CREATE INDEX IF NOT EXISTS idx_pr4_status ON pr4_solicitations(status) WHERE status != 'closed';

ALTER TABLE mmi_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr4_solicitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY mmi_admin ON mmi_evaluations FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));
CREATE POLICY pr4_admin ON pr4_solicitations FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));
