-- ════════════════════════════════════════════════════════════════════════════
-- Production Hardening — schema for the June 2026 hardening pass.
--
-- DEPLOYMENT ORDER: apply this migration BEFORE deploying the matching
-- backend. The code writes every column added here (and TEXT ids into
-- diaries/claim_events); deploying code first would fail at runtime.
-- The migration itself is backward-compatible with the PRIOR backend
-- (only additive columns, widened id types, and new tables), so the
-- safe order is always: migrate → deploy.
--
-- 1. SCHEMA TRUTH — columns the backend already writes that no
--    migration ever created:
--      diaries: TEXT ids ('diy_*'), completion/decision fields,
--               source_document_id; claim_events: TEXT ids ('evt_*');
--      claim_documents: package_kind, pdf_buffer_b64;
--      documents.upload_confirmed_at; appointments.confirmation_number.
-- 2. Aftermath atomicity/idempotency: diaries.parent_diary_id +
--    idempotency_key (unique), statutory_deadline (Finding 6 ceilings).
-- 3. Truthful notice delivery: per-channel tracking table
--    (benefit_notice_channels), notice locks + submitted state +
--    source_diary_id/idempotency_key, webhook_events dedupe table.
-- 4. Transactional outbox for external side effects (integration_outbox).
-- 5. Triage resolution audit fields + 'resolving' state.
--
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1a. diaries: TEXT ids + decision/completion/idempotency columns ─────────
ALTER TABLE diaries ALTER COLUMN id DROP DEFAULT;
ALTER TABLE diaries ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE diaries ALTER COLUMN id SET DEFAULT (gen_random_uuid()::text);

ALTER TABLE diaries ADD COLUMN IF NOT EXISTS completed_at        TIMESTAMPTZ;
ALTER TABLE diaries ADD COLUMN IF NOT EXISTS completed_by        VARCHAR(200);
ALTER TABLE diaries ADD COLUMN IF NOT EXISTS decision_action     VARCHAR(50);
ALTER TABLE diaries ADD COLUMN IF NOT EXISTS decision_note       TEXT;
ALTER TABLE diaries ADD COLUMN IF NOT EXISTS source_document_id  TEXT;
ALTER TABLE diaries ADD COLUMN IF NOT EXISTS parent_diary_id     TEXT;
ALTER TABLE diaries ADD COLUMN IF NOT EXISTS idempotency_key     TEXT;
ALTER TABLE diaries ADD COLUMN IF NOT EXISTS statutory_deadline  DATE;

-- Crashed-and-retried aftermath runs must not duplicate successors.
CREATE UNIQUE INDEX IF NOT EXISTS diaries_idempotency_key_uq
  ON diaries (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS diaries_parent_idx
  ON diaries (parent_diary_id) WHERE parent_diary_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS diaries_source_document_idx
  ON diaries (source_document_id) WHERE source_document_id IS NOT NULL;

-- ── 1b. claim_events: TEXT ids (code supplies 'evt_*' for rollback
--        tracking inside the aftermath unit) ─────────────────────────────────
ALTER TABLE claim_events ALTER COLUMN id DROP DEFAULT;
ALTER TABLE claim_events ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE claim_events ALTER COLUMN id SET DEFAULT (gen_random_uuid()::text);

-- ── 1c. claim_documents: generation + triage-resolution fields ──────────────
ALTER TABLE claim_documents ADD COLUMN IF NOT EXISTS package_kind     TEXT;
ALTER TABLE claim_documents ADD COLUMN IF NOT EXISTS pdf_buffer_b64   TEXT;
ALTER TABLE claim_documents ADD COLUMN IF NOT EXISTS superseded_by    TEXT REFERENCES claim_documents(id);
ALTER TABLE claim_documents ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE claim_documents ADD COLUMN IF NOT EXISTS resolved_by      TEXT;
ALTER TABLE claim_documents ADD COLUMN IF NOT EXISTS resolved_at      TIMESTAMPTZ;

-- Atomic triage claiming introduces the transient 'resolving' state.
ALTER TABLE claim_documents DROP CONSTRAINT IF EXISTS claim_documents_triage_status_chk;
ALTER TABLE claim_documents ADD CONSTRAINT claim_documents_triage_status_chk
  CHECK (triage_status IN ('none', 'pending', 'resolving', 'resolved'));

CREATE INDEX IF NOT EXISTS claim_documents_package_kind_idx
  ON claim_documents (claim_id, package_kind) WHERE package_kind IS NOT NULL;

-- diaries.source_document_id FK (added after claim_documents exists).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'diaries_source_document_fk'
                   AND conrelid = 'diaries'::regclass) THEN
    ALTER TABLE diaries ADD CONSTRAINT diaries_source_document_fk
      FOREIGN KEY (source_document_id) REFERENCES claim_documents(id);
  END IF;
END $$;

-- ── 1d. media documents + appointments columns the code writes ──────────────
ALTER TABLE documents    ADD COLUMN IF NOT EXISTS upload_confirmed_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS confirmation_number VARCHAR(100);

-- ── 3a. benefit_notices: truthful states, locks, idempotency ────────────────
ALTER TABLE benefit_notices ADD COLUMN IF NOT EXISTS source_diary_id  TEXT;
ALTER TABLE benefit_notices ADD COLUMN IF NOT EXISTS idempotency_key  TEXT;
ALTER TABLE benefit_notices ADD COLUMN IF NOT EXISTS locked_by        TEXT;
ALTER TABLE benefit_notices ADD COLUMN IF NOT EXISTS locked_at        TIMESTAMPTZ;
ALTER TABLE benefit_notices ADD COLUMN IF NOT EXISTS submitted_at     TIMESTAMPTZ;

-- 'submitted' = handed to the provider, delivery NOT yet confirmed.
ALTER TABLE benefit_notices DROP CONSTRAINT IF EXISTS benefit_notices_status_chk;
ALTER TABLE benefit_notices ADD CONSTRAINT benefit_notices_status_chk
  CHECK (status IN ('generated', 'queued', 'delivering', 'submitted', 'delivered',
                    'failed', 'blocked_pending_translation'));

CREATE UNIQUE INDEX IF NOT EXISTS benefit_notices_idempotency_key_uq
  ON benefit_notices (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS benefit_notices_source_diary_idx
  ON benefit_notices (source_diary_id) WHERE source_diary_id IS NOT NULL;

-- ── 3b. per-channel delivery tracking ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS benefit_notice_channels (
  id            TEXT PRIMARY KEY,
  notice_id     TEXT NOT NULL REFERENCES benefit_notices(id) ON DELETE CASCADE,
  claim_id      TEXT REFERENCES claims(id),
  channel       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  provider_ref  TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  last_event    TEXT,
  submitted_at  TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT benefit_notice_channels_channel_chk
    CHECK (channel IN ('mail', 'portal', 'fax', 'electronic')),
  CONSTRAINT benefit_notice_channels_status_chk
    CHECK (status IN ('pending', 'submitted', 'delivered', 'failed')),
  CONSTRAINT benefit_notice_channels_notice_channel_uq UNIQUE (notice_id, channel)
);
CREATE INDEX IF NOT EXISTS benefit_notice_channels_provider_ref_idx
  ON benefit_notice_channels (provider_ref) WHERE provider_ref IS NOT NULL;

-- ── 3c. webhook event dedupe (duplicate deliveries are acknowledged,
--        never reprocessed) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_events (
  id                 TEXT PRIMARY KEY,
  provider           TEXT NOT NULL,
  provider_event_id  TEXT NOT NULL,
  event_type         TEXT,
  payload            JSONB,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT webhook_events_provider_event_uq UNIQUE (provider, provider_event_id)
);

-- ── 4. transactional outbox for external side effects ───────────────────────
CREATE TABLE IF NOT EXISTS integration_outbox (
  id               TEXT PRIMARY KEY,
  target           TEXT NOT NULL,
  operation        TEXT NOT NULL,
  claim_id         TEXT REFERENCES claims(id),
  payload          JSONB NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  locked_by        TEXT,
  locked_at        TIMESTAMPTZ,
  next_attempt_at  TIMESTAMPTZ,
  succeeded_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_outbox_status_chk
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed'))
);
CREATE INDEX IF NOT EXISTS integration_outbox_due_idx
  ON integration_outbox (status, next_attempt_at) WHERE status = 'pending';

COMMIT;
