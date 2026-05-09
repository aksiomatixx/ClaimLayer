-- 20260102000013_claims_metadata.sql
-- Add a generic JSONB metadata column to claims.
--
-- Used initially by the demo seed (metadata.demo = true) so the
-- demo-reset endpoint can wipe just the seeded rows without
-- touching real claim data. Free-form by design — additional keys
-- (origin tags, A/B flags, demo persona slugs) can be added later
-- without further migrations.
--
-- DO NOT RUN AUTOMATICALLY. Stage for review per Master_Context rules.

ALTER TABLE claims ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Index just the demo-flag predicate — cheap and lets the
-- demo-reset endpoint locate seeded rows in O(seeded) instead of
-- a full table scan.
CREATE INDEX IF NOT EXISTS idx_claims_metadata_demo
  ON claims ((metadata->>'demo'))
  WHERE metadata ? 'demo';
