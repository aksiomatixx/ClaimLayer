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
--   - recovery_subrogation: third-party recovery or refund
--   - closing_reduction: zeroing out upon claim closure
--
-- Formula:
--   Total Incurred = Total Paid to Date + Outstanding Reserves
--
-- Incurred delta rules:
--   - For initial_reserve, reserve_revision, closing_reduction: incurred_delta = amount_delta
--   - For payment_reduction: incurred_delta = 0 (paid increases while reserve decreases)
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
AS $$
BEGIN
  RAISE EXCEPTION 'reserve_transactions is an immutable financial ledger: % not permitted', TG_OP
    USING ERRCODE = '55000'; -- object_not_in_prerequisite_state
END;
$$;

DROP TRIGGER IF EXISTS trg_reserve_transactions_no_update_delete ON reserve_transactions;
CREATE TRIGGER trg_reserve_transactions_no_update_delete
  BEFORE UPDATE OR DELETE ON reserve_transactions
  FOR EACH ROW
  EXECUTE FUNCTION trg_reserve_transactions_append_only();

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE reserve_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reserve_transactions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'reserve_transactions'
      AND policyname = 'reserve_transactions_tenant_isolation'
  ) THEN
    CREATE POLICY reserve_transactions_tenant_isolation ON reserve_transactions
      FOR ALL
      USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::UUID
        OR current_setting('app.tenant_id', true) IS NULL
      )
      WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::UUID
        OR current_setting('app.tenant_id', true) IS NULL
      );
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill initial reserve_transactions from existing reserves snapshot rows
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
  COALESCE(r.source, 'ADJUSTER') AS source,
  r.approved_by AS created_by,
  r.created_at
FROM reserves r
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
