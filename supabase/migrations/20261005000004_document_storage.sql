-- 20261005000004_document_storage.sql
-- Phase 7 / Enterprise Document Architecture:
-- Adds multi-tenant object storage metadata, cryptographic SHA-256 integrity checksums,
-- and Anti-Virus / CDR scanning status to claim_documents.

BEGIN;

-- 1. Add storage metadata columns to claim_documents
ALTER TABLE claim_documents
    ADD COLUMN IF NOT EXISTS storage_provider  TEXT NOT NULL DEFAULT 'inline',
    ADD COLUMN IF NOT EXISTS storage_bucket    TEXT DEFAULT 'claim-documents',
    ADD COLUMN IF NOT EXISTS storage_key       TEXT,
    ADD COLUMN IF NOT EXISTS sha256_checksum   TEXT,
    ADD COLUMN IF NOT EXISTS file_size_bytes   BIGINT,
    ADD COLUMN IF NOT EXISTS mime_type         TEXT DEFAULT 'application/pdf',
    ADD COLUMN IF NOT EXISTS av_scan_status    TEXT NOT NULL DEFAULT 'clean',
    ADD COLUMN IF NOT EXISTS av_scanned_at     TIMESTAMPTZ DEFAULT now();

-- 2. Constraints for storage providers and AV statuses
ALTER TABLE claim_documents DROP CONSTRAINT IF EXISTS claim_documents_storage_provider_chk;
ALTER TABLE claim_documents ADD CONSTRAINT claim_documents_storage_provider_chk
    CHECK (storage_provider IN ('inline', 'supabase', 's3', 'gcs', 'local'));

ALTER TABLE claim_documents DROP CONSTRAINT IF EXISTS claim_documents_av_scan_status_chk;
ALTER TABLE claim_documents ADD CONSTRAINT claim_documents_av_scan_status_chk
    CHECK (av_scan_status IN ('pending', 'clean', 'infected', 'quarantined'));

-- 3. Indexes for rapid storage key resolution
CREATE INDEX IF NOT EXISTS idx_claim_documents_storage_key
    ON claim_documents(storage_key) WHERE storage_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claim_documents_checksum
    ON claim_documents(sha256_checksum) WHERE sha256_checksum IS NOT NULL;

COMMIT;
