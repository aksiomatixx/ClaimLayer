-- 20260102000012_td_periods.sql
-- TD Period Tracking — first-class temporary disability benefit periods.
-- Captures TTD / TPD / salary continuation history per claim, including
-- start/end, weekly rate, suspensions, and reinstatements. Replaces the
-- scalar claims.td_rate / claims.aww snapshot as the source of truth for
-- "is this worker currently receiving TD and how much remains under the
-- 104-week statutory cap (LC §4656(c)(2))".
--
-- WCIS triggers (SROI IP / CA / CB / Sx / Px / RB / RE / FS) are NOT wired
-- in this migration — they will be wired in the full tdService milestone.
--
-- DO NOT RUN AUTOMATICALLY. Stage for review per Master_Context rules.

CREATE TABLE IF NOT EXISTS td_periods (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id                  VARCHAR(60) NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  benefit_type              VARCHAR(20) NOT NULL
                            CHECK (benefit_type IN ('TTD', 'TPD', 'salary_continuation')),
  start_date                DATE NOT NULL,
  end_date                  DATE,                       -- NULL = active
  weekly_rate               DECIMAL(10,2) NOT NULL,
  -- e.g. 'initial_disability', 'reinstatement', 'rate_change',
  -- 'benefit_type_change'
  reason_started            VARCHAR(50) NOT NULL,
  -- e.g. 'rtw_full', 'rtw_modified', 'mmi_reached',
  -- 'max_weeks_exhausted', 'suspended_by_adjuster', 'settled', 'death',
  -- 'rate_change', 'benefit_type_change', 'other'
  reason_ended              VARCHAR(50),
  -- WCIS-aligned suspension reason code. Stored as free-text VARCHAR for
  -- now; the full tdService milestone will constrain this to the WCIS
  -- code list (S1/S2/S3/S7/P1/P2/P3 etc. — see backend/src/constants/
  -- wcisConstants.js TRIGGER_EVENT_TO_MTC).
  suspension_reason_code    VARCHAR(20),
  reinstated_from_period_id UUID REFERENCES td_periods(id),
  notes                     TEXT,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  created_by                VARCHAR(200),               -- adjuster email
  updated_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_td_periods_claim
  ON td_periods (claim_id, start_date DESC);

CREATE INDEX IF NOT EXISTS idx_td_periods_active
  ON td_periods (claim_id) WHERE end_date IS NULL;

-- Database-enforced invariant: at most one active period per claim.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_td_active_per_claim
  ON td_periods (claim_id) WHERE end_date IS NULL;

-- Row-level security — only adjusters may read/write TD periods.
ALTER TABLE td_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY td_periods_admin ON td_periods
  FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));
