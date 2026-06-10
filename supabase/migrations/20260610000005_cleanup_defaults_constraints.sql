-- ════════════════════════════════════════════════════════════════════════════
-- Cleanup Commits (Tier 2) — deferred from M14.5 + legacy constraint
-- naming normalization.
--
-- 1. stipulations.future_medical DEFAULT FALSE → TRUE. A Stipulations
--    with Request for Award conventionally leaves future medical OPEN —
--    that is its structural difference from a C&R. The FALSE default was
--    an M13 oversight; explicit per-stip values are unaffected.
--
-- 2. Constraint naming normalization to the {table}_{column}_chk
--    convention (M14.5). Renames are wrapped in existence checks via
--    pg_constraint so the migration is safe whether or not the legacy
--    names are present (per the house pre-apply-lookup rule).
--
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

-- 1. future_medical default flip
ALTER TABLE stipulations ALTER COLUMN future_medical SET DEFAULT TRUE;

-- 2a. claims.valid_status (M1 convention, no suffix) → claims_status_chk
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valid_status'
             AND conrelid = 'claims'::regclass) THEN
    ALTER TABLE claims RENAME CONSTRAINT valid_status TO claims_status_chk;
  END IF;
END $$;

-- 2b. claims subrogation_status inline CHECK (M6, Postgres default name)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_subrogation_status_check'
             AND conrelid = 'claims'::regclass) THEN
    ALTER TABLE claims RENAME CONSTRAINT claims_subrogation_status_check
      TO claims_subrogation_status_chk;
  END IF;
END $$;

-- 2c. settlement_offers *_check (M19, Postgres default names) → _chk
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'settlement_offers'::regclass
      AND contype = 'c'
      AND conname LIKE '%\_check' ESCAPE '\'
  LOOP
    EXECUTE format('ALTER TABLE settlement_offers RENAME CONSTRAINT %I TO %I',
                   r.conname, regexp_replace(r.conname, '_check$', '_chk'));
  END LOOP;
END $$;

COMMIT;
