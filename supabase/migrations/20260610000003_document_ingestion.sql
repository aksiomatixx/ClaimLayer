-- ════════════════════════════════════════════════════════════════════════════
-- Inbound Document Ingestion & Classification (Tier 1)
--
-- Formalizes claim_documents (previously demo-seeded only) and adds the
-- ingestion-pipeline fields: classification confidence, triage state for
-- low-confidence/unmatched documents, inline text content (M2-style;
-- object storage remains a follow-on), and versioning.
--
-- claim_id is NULLABLE by design: a document that cannot be confidently
-- matched to a claim lands in the human triage queue instead of being
-- silently filed — that is the pipeline's core guardrail.
--
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS claim_documents (
  id                        TEXT PRIMARY KEY,
  claim_id                  TEXT REFERENCES claims(id),
  title                     TEXT NOT NULL,
  category                  TEXT NOT NULL DEFAULT 'other',
  source                    TEXT,
  received_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  pages                     INTEGER,
  status                    TEXT NOT NULL DEFAULT 'filed',
  ai_summary                TEXT,
  relevant_to               JSONB,
  content_text              TEXT,
  key_fields                JSONB,
  classification_confidence NUMERIC,
  classification_model      TEXT,
  triage_status             TEXT NOT NULL DEFAULT 'none',
  triage_reason             TEXT,
  version                   INTEGER NOT NULL DEFAULT 1,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT claim_documents_status_chk
    CHECK (status IN ('filed', 'triage', 'rejected', 'superseded')),
  CONSTRAINT claim_documents_triage_status_chk
    CHECK (triage_status IN ('none', 'pending', 'resolved')),
  CONSTRAINT claim_documents_category_chk
    CHECK (category IN ('medical','bill','legal','qme','state_form','rfa',
                        'pharmacy','correspondence','surveillance','wage',
                        'work_status','settlement','other')),
  CONSTRAINT claim_documents_confidence_chk
    CHECK (classification_confidence IS NULL OR
           (classification_confidence >= 0 AND classification_confidence <= 100))
);

CREATE INDEX IF NOT EXISTS claim_documents_claim_idx
  ON claim_documents (claim_id, received_at);
CREATE INDEX IF NOT EXISTS claim_documents_triage_idx
  ON claim_documents (triage_status) WHERE triage_status = 'pending';

COMMIT;
