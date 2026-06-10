-- ════════════════════════════════════════════════════════════════════════════
-- M17B remainder — attorney representation as first-class claim data
--
-- Consolidates the four-field representation OR-chain (attorney_represented /
-- attorneyName / attorney_name / representedBy — only the first was ever a
-- real column; the rest lived in ad-hoc payloads) onto explicit columns.
-- utils/representation.js keeps the legacy chain as fallback during the
-- transition, with attorney_represented as the authoritative source.
--
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE claims ADD COLUMN IF NOT EXISTS attorney_represented BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS attorney_name  TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS attorney_firm  TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS attorney_email TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS attorney_phone TEXT;

-- Backfill: any row that already carries an attorney name (from earlier
-- ad-hoc writes) is represented.
UPDATE claims SET attorney_represented = TRUE
 WHERE attorney_represented = FALSE AND attorney_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS claims_attorney_represented_idx
  ON claims (attorney_represented) WHERE attorney_represented = TRUE;

COMMIT;
