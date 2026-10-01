-- ════════════════════════════════════════════════════════════════════════════
-- Trust Foundation (Sprint 1) — schema truth
--
-- 1. ai_decisions reconciliation (finding D-1).
--    20260101000004 created ai_decisions with the M5 column set; the later
--    20260102000014 `CREATE TABLE IF NOT EXISTS ai_decisions` was therefore a
--    no-op on every database built from this chain. aiDecisionsService (the
--    REQUIRED audit path for compensability, RFA and document
--    classification) writes prompt_name / model / latency_ms /
--    guardrail_actions / human_* — columns that never existed, so every
--    regulated AI call failed on real PostgreSQL. This adds them, widens
--    confidence to what the code writes, and relaxes output_raw NOT NULL
--    (deterministic gates such as MSA screening have no raw model text).
--    Both writer shapes (aiDecisionsService and the M5-shape writers in
--    disbursementService / pdService / awardExtractionService) are then valid.
--    The 20260102000014 decision_type CHECK, where it exists, omitted
--    doc_classification / award_extraction / disbursement_approval /
--    pd_advance_cap_override, all of which the code writes — it is dropped.
--
-- 2. RLS deny-by-default on the 11 public tables created without it
--    (finding S-3). Supabase's default privileges grant anon/authenticated
--    table access in `public`; with RLS off these tables were readable via
--    PostgREST with the publishable anon key. No policies are added, so only
--    the service role (BYPASSRLS — the backend) can read or write them.
--    Backend behavior is unchanged.
--
-- 3. users.active — identity resolution (finding S-1) now reads role /
--    tenant / employer from this server-controlled table instead of
--    Supabase user_metadata; deactivating a user must revoke login.
--
-- Additive and backward-compatible with the prior backend. Apply BEFORE
-- deploying the matching backend (migrate → deploy, always).
--
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1. ai_decisions reconciliation ──────────────────────────────────────────
ALTER TABLE ai_decisions ADD COLUMN IF NOT EXISTS prompt_name       VARCHAR(100);
ALTER TABLE ai_decisions ADD COLUMN IF NOT EXISTS model             VARCHAR(100);
ALTER TABLE ai_decisions ADD COLUMN IF NOT EXISTS latency_ms        INTEGER;
ALTER TABLE ai_decisions ADD COLUMN IF NOT EXISTS guardrail_actions JSONB DEFAULT '[]'::jsonb;
ALTER TABLE ai_decisions ADD COLUMN IF NOT EXISTS human_reviewer_id UUID;
ALTER TABLE ai_decisions ADD COLUMN IF NOT EXISTS human_decision    VARCHAR(80);
ALTER TABLE ai_decisions ADD COLUMN IF NOT EXISTS human_decision_at TIMESTAMPTZ;
-- Present only in the M5 shape; added so both shapes are uniform.
ALTER TABLE ai_decisions ADD COLUMN IF NOT EXISTS system_prompt_hash VARCHAR(64);

ALTER TABLE ai_decisions ALTER COLUMN output_raw DROP NOT NULL;

DO $$
BEGIN
  -- SMALLINT (M5 shape) → NUMERIC(5,2): lossless widening; the code writes
  -- fractional confidences.
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'ai_decisions'
         AND column_name = 'confidence') = 'smallint' THEN
    ALTER TABLE ai_decisions ALTER COLUMN confidence TYPE NUMERIC(5,2);
  END IF;
END $$;

ALTER TABLE ai_decisions DROP CONSTRAINT IF EXISTS ai_decisions_decision_type_check;

CREATE INDEX IF NOT EXISTS idx_ai_decisions_claim_created
  ON ai_decisions (claim_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_type_created
  ON ai_decisions (decision_type, created_at DESC);

-- ── 2. RLS deny-by-default on unprotected tables ────────────────────────────
ALTER TABLE benefit_notice_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE benefit_notices         ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_documents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_links             ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurers                ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_outbox      ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies                ENABLE ROW LEVEL SECURITY;
ALTER TABLE reserve_line_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE supervisor_alerts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events          ENABLE ROW LEVEL SECURITY;

-- ── 3. users.active ─────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS active       BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(200);

COMMIT;

-- ── ROLLBACK (manual; not executed) ─────────────────────────────────────────
-- The reconciliation columns are additive; rolling back means dropping them
-- only if no rows depend on them:
--   ALTER TABLE ai_decisions DROP COLUMN IF EXISTS prompt_name, ...;
--   ALTER TABLE <each table above> DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE users DROP COLUMN IF EXISTS active, DROP COLUMN IF EXISTS display_name;
-- Re-disabling RLS re-opens finding S-3 and is not recommended.
