-- M11: QME/AME Process Management
-- Creates qme_panels table for tracking QME panel and AME processes.
-- Also adds no_snooze column to diaries for CRITICAL strike deadlines.
--
-- DO NOT RUN AUTOMATICALLY. Review and apply manually via:
--   supabase db push
-- or
--   psql -f supabase/migrations/20260101000006_m11_qme.sql

-- ── Add no_snooze flag to diaries ────────────────────────────────────────────
-- Strike deadlines and certain CRITICAL diaries cannot be snoozed.
ALTER TABLE diaries ADD COLUMN IF NOT EXISTS no_snooze BOOLEAN DEFAULT FALSE;

-- ── QME Panels ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qme_panels (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              VARCHAR(60) REFERENCES claims(id),
  specialty             VARCHAR(100) NOT NULL,
  track                 VARCHAR(20) NOT NULL CHECK (track IN ('qme', 'ame')),
  panel_issued_date     DATE,
  strike_deadline       DATE,        -- 10 calendar days from panel_issued_date
  doctor_1_name         VARCHAR(200),
  doctor_1_npi          VARCHAR(20),
  doctor_1_address      TEXT,
  doctor_2_name         VARCHAR(200),
  doctor_2_npi          VARCHAR(20),
  doctor_2_address      TEXT,
  doctor_3_name         VARCHAR(200),
  doctor_3_npi          VARCHAR(20),
  doctor_3_address      TEXT,
  strike_1_npi          VARCHAR(20),  -- first doctor struck
  strike_2_npi          VARCHAR(20),  -- second doctor struck
  selected_npi          VARCHAR(20),  -- remaining doctor = selected
  selected_name         VARCHAR(200),
  selected_address      TEXT,
  appointment_date      DATE,
  appointment_confirmed BOOLEAN DEFAULT FALSE,
  report_due_date       DATE,         -- 30 calendar days after appointment per CCR §35
  report_received_at    TIMESTAMPTZ,
  status                VARCHAR(30) DEFAULT 'panel_requested'
                        CHECK (status IN (
                          'panel_requested', 'panel_issued', 'strikes_pending',
                          'doctor_selected', 'appointment_scheduled',
                          'report_pending', 'report_received', 'closed'
                        )),
  ame_doctor_name       VARCHAR(200), -- AME track only
  ame_doctor_npi        VARCHAR(20),
  ame_agreed_date       DATE,
  created_by            UUID,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qme_claim  ON qme_panels(claim_id);
CREATE INDEX IF NOT EXISTS idx_qme_status ON qme_panels(status) WHERE status NOT IN ('closed');

ALTER TABLE qme_panels ENABLE ROW LEVEL SECURITY;
CREATE POLICY qme_admin ON qme_panels
  FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));
