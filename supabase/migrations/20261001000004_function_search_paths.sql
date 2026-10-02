-- ════════════════════════════════════════════════════════════════════════════
-- Trust Foundation (Sprint 1) — pin function search paths
--
-- Supabase's security advisor (lint 0011, function_search_path_mutable)
-- flags functions whose search_path is inherited from the caller: a caller
-- who controls search_path could shadow objects the function resolves
-- unqualified.
--
--   app.audit_ledger_reject_mutation — introduced by 20261001000002; only
--     raises, so not exploitable, but pinned for consistency with the other
--     ledger functions.
--   public.next_claim_number         — pre-existing (20260101000001);
--     resolves claim_number_seq unqualified, so it keeps public on its path.
--
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

ALTER FUNCTION app.audit_ledger_reject_mutation() SET search_path = pg_catalog;
ALTER FUNCTION public.next_claim_number()        SET search_path = public, pg_temp;

COMMIT;

-- ── ROLLBACK (manual; not executed) ─────────────────────────────────────────
--   ALTER FUNCTION app.audit_ledger_reject_mutation() RESET search_path;
--   ALTER FUNCTION public.next_claim_number()        RESET search_path;
