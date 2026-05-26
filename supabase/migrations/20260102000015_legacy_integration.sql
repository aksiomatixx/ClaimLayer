-- 20260102000015_legacy_integration.sql
-- Legacy claims integration — pluggable adapter layer.
--
-- Lets ClaimLayer run as a system-of-engagement on top of a customer's
-- existing claims system-of-record (Origami Risk / Guidewire / Sapiens /
-- A1 Tracker / FileHandler / JW Software). Adds source-tracking columns
-- to claims, and provisions mock_legacy_* tables that stand in for an
-- external customer system during the demo so the full ingest +
-- write-back round trip is observable end-to-end.
--
-- Companion code:
--   backend/src/services/legacy/LegacyClaimsAdapter.js (base interface)
--   backend/src/services/legacy/A1TrackerAdapter.js    (wraps filehandler)
--   backend/src/services/legacy/MockLegacyAdapter.js   (uses these tables)
--   backend/src/services/legacy/adapterRegistry.js
--   backend/src/services/legacyMigrationService.js
--
-- FUTURE WORK (out of scope here, in scope per Master_Context backlog):
--   - Real Origami / Guidewire / Sapiens adapters
--   - Two-way continuous reconciliation
--   - Field-level source-of-truth arbitration
--
-- DO NOT RUN AUTOMATICALLY. Stage for review per Master_Context rules.

-- ── Source-tracking columns on claims ────────────────────────────────────────
ALTER TABLE claims ADD COLUMN IF NOT EXISTS source_system     VARCHAR(40) DEFAULT 'native';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS external_claim_id VARCHAR(120);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS last_synced_at    TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS sync_status       VARCHAR(20) DEFAULT 'native';

-- sync_status values:
--   native        — claim was created in this platform; no legacy peer
--   migrated      — pulled in from a legacy system; not yet written back
--   synced        — last write-back to legacy system succeeded
--   sync_pending  — write-back enqueued / in-flight
--   sync_failed   — last write-back failed; see claim_events for detail
DO $$ BEGIN
  ALTER TABLE claims ADD CONSTRAINT claims_sync_status_check
    CHECK (sync_status IN ('native', 'migrated', 'synced', 'sync_pending', 'sync_failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Partial index — only non-native claims need fast lookup by source system.
CREATE INDEX IF NOT EXISTS idx_claims_source
  ON claims (source_system)
  WHERE source_system <> 'native';

-- External-claim-id lookup for the migration idempotency check.
CREATE INDEX IF NOT EXISTS idx_claims_external_id
  ON claims (source_system, external_claim_id)
  WHERE external_claim_id IS NOT NULL;

-- ── Mock legacy system tables ────────────────────────────────────────────────
-- These simulate a customer's external claims system. The MockLegacyAdapter
-- reads from legacy_claims to ingest, and writes to legacy_updates /
-- legacy_diaries / legacy_documents to demonstrate write-back. None of these
-- carry real WC data — they exist so the round trip is demonstrable in demo.

CREATE TABLE IF NOT EXISTS legacy_claims (
  external_id    VARCHAR(120) PRIMARY KEY,
  raw            JSONB        NOT NULL DEFAULT '{}'::jsonb,
  claimant_name  VARCHAR(200),
  employer_name  VARCHAR(200),
  doi            DATE,
  body_part      VARCHAR(80),
  status         VARCHAR(40),
  created_at     TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS legacy_diaries (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_claim_id  VARCHAR(120) NOT NULL REFERENCES legacy_claims(external_id) ON DELETE CASCADE,
  type               VARCHAR(80),
  due_date           DATE,
  notes              TEXT,
  pushed_at          TIMESTAMPTZ  DEFAULT NOW(),
  created_at         TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS legacy_documents (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_claim_id  VARCHAR(120) NOT NULL REFERENCES legacy_claims(external_id) ON DELETE CASCADE,
  doc_type           VARCHAR(60),
  title              VARCHAR(200),
  summary            TEXT,
  pushed_at          TIMESTAMPTZ  DEFAULT NOW(),
  created_at         TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS legacy_updates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_claim_id  VARCHAR(120) NOT NULL REFERENCES legacy_claims(external_id) ON DELETE CASCADE,
  field              VARCHAR(80),
  old_value          TEXT,
  new_value          TEXT,
  pushed_at          TIMESTAMPTZ  DEFAULT NOW(),
  created_at         TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_legacy_diaries_claim   ON legacy_diaries   (external_claim_id, pushed_at DESC);
CREATE INDEX IF NOT EXISTS idx_legacy_documents_claim ON legacy_documents (external_claim_id, pushed_at DESC);
CREATE INDEX IF NOT EXISTS idx_legacy_updates_claim   ON legacy_updates   (external_claim_id, pushed_at DESC);

-- ── RLS — admin-only, matching existing table conventions ───────────────────
ALTER TABLE legacy_claims    ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_diaries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_updates   ENABLE ROW LEVEL SECURITY;

CREATE POLICY legacy_claims_admin    ON legacy_claims    FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));
CREATE POLICY legacy_diaries_admin   ON legacy_diaries   FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));
CREATE POLICY legacy_documents_admin ON legacy_documents FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));
CREATE POLICY legacy_updates_admin   ON legacy_updates   FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));
