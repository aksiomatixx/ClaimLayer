-- ════════════════════════════════════════════════════════════════════════════
-- Hardening sweep (Codex review): schema truth for two existing write shapes
--
--   1. audit_log.actor — services (diary actions, document ingestion,
--      supervisor alerts) record the acting user's email as `actor`;
--      the column did not exist, so every such insert failed on real
--      PostgreSQL. The mock client masked it. user_id stays the UUID FK
--      for authenticated Supabase users; actor is the human-readable
--      identity the app actually has today.
--   2. webhook_events.processed_at — webhook processing must be marked
--      complete only AFTER the local updates succeed, so provider
--      retries of a failed application are reprocessed instead of being
--      skipped by the dedupe row.
--
-- DEPLOYMENT ORDER: apply before deploying the sweep backend
-- (migrate → deploy, always).
--
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE audit_log      ADD COLUMN IF NOT EXISTS actor        TEXT;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

COMMIT;
