-- 20260102000014_ai_decisions.sql
-- AI decision audit trail.
--
-- Logs every Claude API call (compensability, RFA / MTUS, C&R
-- pricing, voice extraction) plus deterministic-but-still-automated
-- gate decisions (MSA screening). Used by the admin "Agents" view
-- to surface model behavior, guardrail enforcement, and human
-- override decisions for an interview-grade observability story.
--
-- DO NOT RUN AUTOMATICALLY. Stage for review per Master_Context rules.

CREATE TABLE IF NOT EXISTS ai_decisions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id            VARCHAR(60) REFERENCES claims(id) ON DELETE CASCADE,
  decision_type       VARCHAR(40) NOT NULL CHECK (decision_type IN (
                        'compensability', 'rfa_mtus', 'cnr_pricing',
                        'msa_screening', 'voice_extract'
                      )),
  prompt_name         VARCHAR(100) NOT NULL,
  model               VARCHAR(60) NOT NULL,
  input_snapshot      JSONB NOT NULL,
  output_parsed       JSONB,
  output_raw          TEXT,
  input_tokens        INT,
  output_tokens       INT,
  latency_ms          INT,
  confidence          NUMERIC(5,2),
  guardrail_actions   JSONB DEFAULT '[]'::jsonb,
  human_reviewer_id   UUID,
  human_decision      VARCHAR(80),
  human_decision_at   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_decisions_claim_created
  ON ai_decisions (claim_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_type_created
  ON ai_decisions (decision_type, created_at DESC);

ALTER TABLE ai_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_decisions_admin ON ai_decisions
  FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));
