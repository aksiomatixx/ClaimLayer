-- ═════════════════════════════════════════════════════════════════════════════
-- 20261005000002_payment_ledger_and_payees.sql
--
-- Phase 3 — Financial Controls & True Ledgers:
-- Payee Registry (Vault) & Immutable Payment Ledger (payment_transactions).
--
-- Features:
--   - Tokenized / encrypted PII storage for tax IDs (FEIN / SSN) and bank details.
--   - Automated duplicate payment detection with SHA-256 duplicate_hash.
--   - Links payments directly to action_requests, award_disbursements,
--     and pd_advance_payments.
--   - Automated reserve offset synchronization.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. payees: Tokenized Payee Registry
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payees (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       UUID NOT NULL REFERENCES tenants(id),
  payee_type                      VARCHAR(30) NOT NULL
                                  CONSTRAINT payees_type_chk
                                  CHECK (payee_type IN (
                                    'injured_worker',
                                    'medical_provider',
                                    'attorney',
                                    'vendor',
                                    'lien_claimant'
                                  )),
  name                            VARCHAR(255) NOT NULL,
  tax_id_encrypted                TEXT,
  tax_id_last4                    VARCHAR(4),
  payment_method                  VARCHAR(20) NOT NULL DEFAULT 'check'
                                  CONSTRAINT payees_payment_method_chk
                                  CHECK (payment_method IN ('check', 'ach', 'digital_card')),
  bank_routing_number_encrypted   TEXT,
  bank_account_number_encrypted   TEXT,
  bank_account_last4              VARCHAR(4),
  address_line1                   VARCHAR(255),
  address_line2                   VARCHAR(255),
  city                            VARCHAR(100),
  state                           VARCHAR(2),
  zip_code                        VARCHAR(10),
  status                          VARCHAR(20) NOT NULL DEFAULT 'active'
                                  CONSTRAINT payees_status_chk
                                  CHECK (status IN ('active', 'suspended', 'archived')),
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payees_tenant_name
  ON payees(tenant_id, name);

CREATE INDEX IF NOT EXISTS idx_payees_type
  ON payees(tenant_id, payee_type);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. payment_transactions: Authoritative Payment Ledger
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_transactions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id),
  claim_id                VARCHAR(60) NOT NULL REFERENCES claims(id),
  payee_id                UUID REFERENCES payees(id),
  category                VARCHAR(20) NOT NULL
                          CONSTRAINT payment_transactions_category_chk
                          CHECK (category IN ('indemnity', 'medical', 'expense')),
  payment_type            VARCHAR(40) NOT NULL
                          CONSTRAINT payment_transactions_type_chk
                          CHECK (payment_type IN (
                            'td_temporary_disability',
                            'pd_advance',
                            'stip_award',
                            'cnr_settlement',
                            'medical_treatment',
                            'legal_expense',
                            'bill_review_fee'
                          )),
  amount                  NUMERIC(12,2) NOT NULL
                          CONSTRAINT payment_transactions_amount_chk
                          CHECK (amount > 0),
  status                  VARCHAR(20) NOT NULL DEFAULT 'issued'
                          CONSTRAINT payment_transactions_status_chk
                          CHECK (status IN (
                            'pending_approval',
                            'approved',
                            'issued',
                            'cleared',
                            'voided',
                            'rejected'
                          )),
  method                  VARCHAR(20) NOT NULL DEFAULT 'check'
                          CONSTRAINT payment_transactions_method_chk
                          CHECK (method IN ('check', 'ach', 'digital_card')),
  check_number            VARCHAR(50),
  memo                    TEXT,
  period_start            DATE,
  period_end              DATE,
  action_request_id       TEXT REFERENCES action_requests(id),
  disbursement_id         UUID REFERENCES award_disbursements(id),
  pd_advance_payment_id   UUID REFERENCES pd_advance_payments(id),
  duplicate_hash          VARCHAR(64),
  cleared_at              TIMESTAMPTZ,
  voided_at               TIMESTAMPTZ,
  void_reason             TEXT,
  created_by              TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_tenant_claim
  ON payment_transactions(tenant_id, claim_id, created_at);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_claim_id
  ON payment_transactions(claim_id, created_at);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_payee
  ON payment_transactions(payee_id);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_duplicate
  ON payment_transactions(tenant_id, duplicate_hash);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE payees ENABLE ROW LEVEL SECURITY;
ALTER TABLE payees FORCE ROW LEVEL SECURITY;

ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_transactions FORCE ROW LEVEL SECURITY;

-- Deny by default: no permissive policy, so anon and authenticated read and
-- write nothing (payees hold encrypted tax ids and bank accounts). The backend
-- (service role / owner connection) bypasses RLS. The RESTRICTIVE tenant
-- policy keeps any future permissive grant tenant-bound. (Revised before
-- first application: the original policies were PERMISSIVE, TO PUBLIC, and
-- passed whenever app.tenant_id was unset — always, on the PostgREST path.)
DROP POLICY IF EXISTS payees_tenant_isolation ON payees;
CREATE POLICY payees_tenant_isolation ON payees
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS payment_transactions_tenant_isolation ON payment_transactions;
CREATE POLICY payment_transactions_tenant_isolation ON payment_transactions
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON payees, payment_transactions FROM anon;
-- Payments are voided, never deleted.
REVOKE DELETE, TRUNCATE ON payment_transactions FROM authenticated, service_role;

COMMIT;
