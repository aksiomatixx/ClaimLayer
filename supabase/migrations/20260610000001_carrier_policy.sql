-- ════════════════════════════════════════════════════════════════════════════
-- Carrier & Policy Modeling (Tier 1)
--
-- Supersedes the M22A-prebuild "Option A" minimal insurer modeling
-- (insurer_fein / insurer_name / self_insured on employers — those columns
-- remain as fallback). Adds first-class insurers + policies so that:
--   * an employer can change carriers mid-policy-year,
--   * claims resolve their policy by employer_id + date-of-injury,
--   * WCIS payloads draw insurer data from the policy, not the employer row.
--
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS insurers (
  id          TEXT PRIMARY KEY,
  fein        TEXT NOT NULL,
  name        TEXT NOT NULL,
  naic_code   TEXT,
  address     JSONB,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT insurers_fein_chk CHECK (fein ~ '^[0-9]{9}$')
);

CREATE INDEX IF NOT EXISTS insurers_fein_idx ON insurers (fein);

CREATE TABLE IF NOT EXISTS policies (
  id              TEXT PRIMARY KEY,
  employer_id     TEXT NOT NULL REFERENCES employers(id),
  insurer_id      TEXT REFERENCES insurers(id),   -- NULL when self-insured
  policy_number   TEXT NOT NULL,
  effective_date  DATE NOT NULL,
  expiration_date DATE,                            -- NULL = open-ended
  self_insured    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT policies_dates_chk
    CHECK (expiration_date IS NULL OR expiration_date >= effective_date),
  -- A policy is either self-insured (no carrier) or carried (insurer set).
  CONSTRAINT policies_carrier_chk
    CHECK (self_insured = TRUE OR insurer_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS policies_employer_idx
  ON policies (employer_id, effective_date);

ALTER TABLE claims ADD COLUMN IF NOT EXISTS policy_id TEXT REFERENCES policies(id);

CREATE INDEX IF NOT EXISTS claims_policy_idx ON claims (policy_id);

COMMIT;
