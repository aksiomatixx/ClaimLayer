-- ════════════════════════════════════════════════════════════════════════════
-- Sprint 2 (increment 2a) — claim_events is append-only
--
-- claim_events is the claim's operational timeline. With every workflow now a
-- unit of work (ADR-0006), no code path corrects history by deleting or
-- rewriting events any more: a failed unit rolls back, and a correction is a
-- new event. The database now enforces that:
--
--   * BEFORE UPDATE / DELETE row triggers and a BEFORE TRUNCATE statement
--     trigger raise (SQLSTATE 42501).
--   * UPDATE, DELETE and TRUNCATE privileges are revoked from every API role,
--     so the supabase-js (PostgREST) path cannot mutate events at all.
--
-- One narrow exception — the synthetic demo seed. A transaction that sets
--   SELECT set_config('app.history_purge', 'demo', true)
-- may DELETE events of claims flagged metadata.demo = true (the demo reset,
-- backend/src/scripts/seedDemo.js, over a direct DATABASE_URL connection).
-- Real claims are never purgeable. As with audit_ledger, a database owner can
-- still disable triggers; the immutable, hash-chained record of consequential
-- actions remains audit_ledger (ADR-0003).
--
-- Idempotent: safe to re-apply.
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.claim_events_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_LEVEL = 'ROW' AND TG_OP = 'DELETE'
     AND current_setting('app.history_purge', true) = 'demo'
     AND EXISTS (SELECT 1 FROM public.claims c
                  WHERE c.id = OLD.claim_id AND c.metadata ->> 'demo' = 'true') THEN
    RETURN OLD;   -- synthetic demo history only
  END IF;
  RAISE EXCEPTION 'claim_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = '42501',
          HINT = 'Record a correction as a new event instead.';
END $$;

DROP TRIGGER IF EXISTS claim_events_no_update ON claim_events;
CREATE TRIGGER claim_events_no_update
  BEFORE UPDATE ON claim_events
  FOR EACH ROW EXECUTE FUNCTION app.claim_events_reject_mutation();

DROP TRIGGER IF EXISTS claim_events_no_delete ON claim_events;
CREATE TRIGGER claim_events_no_delete
  BEFORE DELETE ON claim_events
  FOR EACH ROW EXECUTE FUNCTION app.claim_events_reject_mutation();

DROP TRIGGER IF EXISTS claim_events_no_truncate ON claim_events;
CREATE TRIGGER claim_events_no_truncate
  BEFORE TRUNCATE ON claim_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.claim_events_reject_mutation();

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON claim_events FROM %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;

-- ── ROLLBACK (manual; not executed) ─────────────────────────────────────────
-- Re-opens history to rewrites; not recommended.
--   DROP TRIGGER claim_events_no_update ON claim_events;
--   DROP TRIGGER claim_events_no_delete ON claim_events;
--   DROP TRIGGER claim_events_no_truncate ON claim_events;
--   DROP FUNCTION app.claim_events_reject_mutation();
--   GRANT UPDATE, DELETE ON claim_events TO service_role;
