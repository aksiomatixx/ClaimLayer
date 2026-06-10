-- ════════════════════════════════════════════════════════════════════════════
-- Notice Generation Library (Tier 1) — unified benefit-notice tracking
--
-- benefit_notices is the orchestration-facing ledger for every statutory
-- notice: one row per (notice, recipient, language), tracking generation,
-- delivery method/attempts, and deadline compliance. The M9 `notices`
-- table remains for the five bespoke generators; consolidating the two is
-- a recorded cleanup task.
--
-- Spanish-language rows may exist in status 'blocked_pending_translation'
-- with no document: per the regulatory-data rule, the platform never
-- synthesizes translated statutory text. They unblock when DWC-published
-- Spanish templates (or licensed translations) land in docs/regulatory/.
--
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS benefit_notices (
  id               TEXT PRIMARY KEY,
  claim_id         TEXT NOT NULL REFERENCES claims(id),
  notice_type      TEXT NOT NULL,
  audience         TEXT NOT NULL,
  language         TEXT NOT NULL DEFAULT 'en',
  recipient        JSONB NOT NULL,
  regulatory_cite  TEXT,
  deadline_basis   TEXT,
  due_date         DATE,
  document_id      TEXT REFERENCES claim_documents(id),
  status           TEXT NOT NULL DEFAULT 'generated',
  method           TEXT,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  queued_at        TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT benefit_notices_audience_chk
    CHECK (audience IN ('worker', 'provider', 'attorney')),
  CONSTRAINT benefit_notices_language_chk
    CHECK (language IN ('en', 'es')),
  CONSTRAINT benefit_notices_status_chk
    CHECK (status IN ('generated', 'queued', 'delivering', 'delivered',
                      'failed', 'blocked_pending_translation')),
  CONSTRAINT benefit_notices_method_chk
    CHECK (method IS NULL OR method IN ('mail', 'portal', 'fax', 'electronic'))
);

CREATE INDEX IF NOT EXISTS benefit_notices_claim_idx
  ON benefit_notices (claim_id, created_at);
CREATE INDEX IF NOT EXISTS benefit_notices_undelivered_idx
  ON benefit_notices (status) WHERE status IN ('generated', 'queued', 'failed');

COMMIT;
