-- ============================================================
-- M22A Prebuild — Employers FEIN / insurer identity columns
--
-- Architectural decision (Option A, minimal modeling): insurer
-- information lives on the employers table for now, single-
-- insurer-per-employer assumption. Proper multi-policy modeling
-- deferred to a dedicated "Carrier & Policy Modeling" milestone
-- after M22A.
--
-- Format validation (9 digits, no placeholders) lives in the
-- application layer at employer creation/update — not in schema.
-- ============================================================

BEGIN;

ALTER TABLE employers ADD COLUMN IF NOT EXISTS insurer_fein VARCHAR(9);
ALTER TABLE employers ADD COLUMN IF NOT EXISTS insurer_name VARCHAR(200);
ALTER TABLE employers ADD COLUMN IF NOT EXISTS self_insured BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
