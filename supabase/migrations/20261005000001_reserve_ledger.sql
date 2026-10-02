-- ═════════════════════════════════════════════════════════════════════════════
-- 20261005000001_reserve_ledger.sql
--
-- Phase 3 — Financial Controls & True Ledgers:
-- Immutable append-only double-entry reserve ledger (reserve_transactions).
--
-- Replaces single-point-in-time reserve snapshots with an immutable audit trail
-- of every reserve change:
--   - initial_reserve: opening allocation
--   - reserve_revision: upward or downward adjuster adjustment
--   - payment_reduction: reduction resulting from disbursed payment
--   - payment_void: reversal of a payment_reduction (paid down, reserve back up)
--   - recovery_subrogation: third-party recovery or refund
--   - closing_reduction: zeroing out upon claim closure
--
-- Formula:
--   Total Incurred = Total Paid to Date + Outstanding Reserves
--
-- Incurred delta rules:
--   - For initial_reserve, reserve_revision, closing_reduction: incurred_delta = amount_delta
--   - For payment_reduction: incurred_delta = 0 (paid increases while reserve decreases)
--   - For payment_void: incurred_delta = 0 (paid decreases while reserve increases)
--   - For recovery_subrogation: incurred_delta = -amount_delta
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS reserve_transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  claim_id            VARCHAR(60) NOT NULL REFERENCES claims(id),
  action_request_id   TEXT REFERENCES action_requests(id),
  category            VARCHAR(20) NOT NULL
                      CONSTRAINT reserve_transactions_category_chk
                      CHECK (category IN ('medical', 'indemnity', 'expense')),
  transaction_type    VARCHAR(40) NOT NULL
                      CONSTRAINT reserve_transactions_type_chk
                      CHECK (transaction_type IN (
                        'initial_reserve',
                        'reserve_revision',
                        'payment_reduction',
                        'payment_void',
                        'recovery_subrogation',
                        'closing_reduction'
                      )),
  amount_delta        NUMERIC(12,2) NOT NULL,
  resulting_balance   NUMERIC(12,2) NOT NULL
                      CONSTRAINT reserve_transactions_balance_chk
                      CHECK (resulting_balance >= 0),
  incurred_delta      NUMERIC(12,2) NOT NULL,
  reason              TEXT,
  source              VARCHAR(20) NOT NULL DEFAULT 'ADJUSTER',
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for lightning-fast balance rollups and history queries
CREATE INDEX IF NOT EXISTS idx_reserve_transactions_tenant_claim_cat
  ON reserve_transactions(tenant_id, claim_id, category, created_at);

CREATE INDEX IF NOT EXISTS idx_reserve_transactions_claim_id
  ON reserve_transactions(claim_id, created_at);

CREATE INDEX IF NOT EXISTS idx_reserve_transactions_action_request
  ON reserve_transactions(action_request_id)
  WHERE action_request_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Append-Only Trigger: Updates and Deletes are Strictly Prohibited
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_reserve_transactions_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- The one exception, as for claim_events (ADR-0007): the demo reset may
  -- remove the ledger rows of synthetic demo claims, inside its own
  -- transaction (app.history_purge = 'demo'). Real claims never.
  IF TG_LEVEL = 'ROW' AND TG_OP = 'DELETE'
     AND current_setting('app.history_purge', true) = 'demo'
     AND EXISTS (SELECT 1 FROM public.claims c
                  WHERE c.id = OLD.claim_id AND c.metadata ->> 'demo' = 'true') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is an immutable financial ledger: % not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000'; -- object_not_in_prerequisite_state
END;
$$;

DROP TRIGGER IF EXISTS trg_reserve_transactions_no_update_delete ON reserve_transactions;
CREATE TRIGGER trg_reserve_transactions_no_update_delete
  BEFORE UPDATE OR DELETE ON reserve_transactions
  FOR EACH ROW
  EXECUTE FUNCTION trg_reserve_transactions_append_only();

DROP TRIGGER IF EXISTS trg_reserve_transactions_no_truncate ON reserve_transactions;
CREATE TRIGGER trg_reserve_transactions_no_truncate
  BEFORE TRUNCATE ON reserve_transactions
  FOR EACH STATEMENT
  EXECUTE FUNCTION trg_reserve_transactions_append_only();

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE reserve_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reserve_transactions FORCE ROW LEVEL SECURITY;

-- Deny by default: no permissive policy, so anon and authenticated read and
-- write nothing. The backend (service role / owner connection) bypasses RLS.
-- The RESTRICTIVE tenant policy keeps any future permissive grant
-- tenant-bound. (Revised before first application: the original policy was
-- PERMISSIVE, TO PUBLIC, and passed whenever app.tenant_id was unset — which
-- it always is on the PostgREST path — so anon could read the ledger.)
DROP POLICY IF EXISTS reserve_transactions_tenant_isolation ON reserve_transactions;
CREATE POLICY reserve_transactions_tenant_isolation ON reserve_transactions
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Append-only, as claim_events (20261003000001): the API roles cannot even try.
REVOKE UPDATE, DELETE, TRUNCATE ON reserve_transactions FROM anon, authenticated, service_role;
REVOKE ALL ON reserve_transactions FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: open the ledger at each claim's CURRENT approved reserves.
-- `reserves` is a history of snapshots (one row per approval, the newest
-- ADJUSTER row is in force — reserveWorksheetService), so only that row opens
-- the ledger. Opening at every historical snapshot would sum them into
-- incurred. Claims that already have ledger rows are skipped.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO reserve_transactions (
  tenant_id,
  claim_id,
  category,
  transaction_type,
  amount_delta,
  resulting_balance,
  incurred_delta,
  reason,
  source,
  created_by,
  created_at
)
SELECT
  c.tenant_id,
  r.claim_id,
  cat.category,
  'initial_reserve' AS transaction_type,
  cat.amount AS amount_delta,
  cat.amount AS resulting_balance,
  cat.amount AS incurred_delta,
  COALESCE(r.reason, 'Historical opening reserve snapshot') AS reason,
  'ADJUSTER' AS source,
  r.approved_by AS created_by,
  COALESCE(r.created_at, NOW())
FROM (
  SELECT DISTINCT ON (claim_id) *
  FROM reserves
  WHERE source = 'ADJUSTER' AND claim_id IS NOT NULL
  ORDER BY claim_id, created_at DESC NULLS LAST, id DESC
) r
JOIN claims c ON c.id = r.claim_id
CROSS JOIN LATERAL (
  VALUES
    ('medical'::VARCHAR(20), COALESCE(r.medical, 0)),
    ('indemnity'::VARCHAR(20), COALESCE(r.indemnity, 0)),
    ('expense'::VARCHAR(20), COALESCE(r.expense, 0))
) AS cat(category, amount)
WHERE cat.amount > 0
  AND NOT EXISTS (
    SELECT 1 FROM reserve_transactions rt
    WHERE rt.claim_id = r.claim_id
  );

COMMIT;
