-- ════════════════════════════════════════════════════════════════════════════
-- Claim Linking (CL-DEMO2)
--
-- claim_links relates two claims (initially: a prior claim for the
-- same worker). Links are SYMMETRIC — one row, surfaced on both
-- claims. The service normalizes the pair ordering before insert, so
-- the UNIQUE constraint also blocks reversed duplicates.
--
-- DEPLOYMENT ORDER: apply before deploying the claim-linking backend
-- (migrate → deploy, always).
--
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS claim_links (
  id            TEXT PRIMARY KEY,
  claim_id_a    VARCHAR(60) NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  claim_id_b    VARCHAR(60) NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL DEFAULT 'prior_claim_same_worker',
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT claim_links_relation_type_chk
    CHECK (relation_type IN ('prior_claim_same_worker')),
  CONSTRAINT claim_links_distinct_chk
    CHECK (claim_id_a <> claim_id_b),
  CONSTRAINT claim_links_pair_uq UNIQUE (claim_id_a, claim_id_b)
);

CREATE INDEX IF NOT EXISTS claim_links_a_idx ON claim_links (claim_id_a);
CREATE INDEX IF NOT EXISTS claim_links_b_idx ON claim_links (claim_id_b);

COMMIT;
