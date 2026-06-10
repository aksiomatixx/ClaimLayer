-- ════════════════════════════════════════════════════════════════════════════
-- PDF Intake (Tier 1.5 #1) — real document files enter the pipeline.
--
-- claim_documents gains:
--   extraction_method — how the text was obtained:
--     'text_layer'      — extracted locally from the PDF's text layer
--     'document_vision' — scanned/image PDF classified via a Claude
--                         document block (no usable text layer)
--     NULL              — text-channel ingestion (no file)
--   channel_metadata  — channel envelope (email from/subject/message-id)
--
-- DEPLOYMENT ORDER: apply before deploying the PDF-intake backend
-- (migrate → deploy, always).
--
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE claim_documents ADD COLUMN IF NOT EXISTS extraction_method TEXT;
ALTER TABLE claim_documents ADD COLUMN IF NOT EXISTS channel_metadata  JSONB;

ALTER TABLE claim_documents DROP CONSTRAINT IF EXISTS claim_documents_extraction_method_chk;
ALTER TABLE claim_documents ADD CONSTRAINT claim_documents_extraction_method_chk
  CHECK (extraction_method IS NULL OR extraction_method IN ('text_layer', 'document_vision'));

COMMIT;
