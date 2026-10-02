-- ═════════════════════════════════════════════════════════════════════════════
-- 20261005000003_staffing_hierarchy_and_loss_funds.sql
--
-- Phase 2 & Phase 3 Milestones:
--   1. Staffing Industry Hierarchy:
--      Staffing Agency -> Host Employer (Client) -> Client Assignment -> Injured Worker -> Claim
--   2. Multi-Axis Claim State:
--      Decouples monolithic status into admin_status, compensability_status, litigation_status
--   3. Claim Body Parts:
--      Per-body-part compensability tracking (accepted, delayed, denied per body part)
--   4. Client Loss Fund & Escrow Accounts:
--      Tracks client escrow balances, automated replenishment alerts, and bank reconciliation
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Staffing Agency Hierarchy
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staffing_agencies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  name            VARCHAR(255) NOT NULL,
  fein            VARCHAR(20),
  license_number  VARCHAR(100),
  contact_email   VARCHAR(255),
  status          VARCHAR(20) NOT NULL DEFAULT 'active'
                  CONSTRAINT staffing_agencies_status_chk
                  CHECK (status IN ('active', 'inactive', 'suspended')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staffing_agencies_tenant
  ON staffing_agencies(tenant_id, name);

CREATE TABLE IF NOT EXISTS host_employers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  agency_id         UUID NOT NULL REFERENCES staffing_agencies(id),
  name              VARCHAR(255) NOT NULL,
  industry_naics    VARCHAR(10),
  worksite_address  VARCHAR(255),
  city              VARCHAR(100),
  state             VARCHAR(2),
  zip_code          VARCHAR(10),
  status            VARCHAR(20) NOT NULL DEFAULT 'active'
                    CONSTRAINT host_employers_status_chk
                    CHECK (status IN ('active', 'inactive')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_host_employers_tenant_agency
  ON host_employers(tenant_id, agency_id);

CREATE TABLE IF NOT EXISTS client_assignments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  agency_id         UUID NOT NULL REFERENCES staffing_agencies(id),
  host_employer_id  UUID NOT NULL REFERENCES host_employers(id),
  employee_id       VARCHAR(60) NOT NULL REFERENCES employees(id),
  job_title         VARCHAR(100),
  class_code        VARCHAR(20),
  hourly_wage       NUMERIC(8,2),
  start_date        DATE NOT NULL,
  end_date          DATE,
  status            VARCHAR(20) NOT NULL DEFAULT 'active'
                    CONSTRAINT client_assignments_status_chk
                    CHECK (status IN ('active', 'completed', 'terminated')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_assignments_lookup
  ON client_assignments(tenant_id, host_employer_id, employee_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Claim Body Parts (Per-body-part compensability)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS claim_body_parts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  claim_id              VARCHAR(60) NOT NULL REFERENCES claims(id),
  body_part_code        VARCHAR(30) NOT NULL,
  body_part_name        VARCHAR(100) NOT NULL,
  side                  VARCHAR(10)
                        CONSTRAINT claim_body_parts_side_chk
                        CHECK (side IS NULL OR side IN ('left', 'right', 'bilateral', 'na')),
  compensability_status VARCHAR(30) NOT NULL DEFAULT 'pending_investigation'
                        CONSTRAINT claim_body_parts_comp_status_chk
                        CHECK (compensability_status IN ('pending_investigation', 'accepted', 'delayed', 'denied')),
  accepted_at           TIMESTAMPTZ,
  delayed_at            TIMESTAMPTZ,
  denied_at             TIMESTAMPTZ,
  denial_reason         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claim_body_parts_claim
  ON claim_body_parts(claim_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Loss Fund Accounts & Ledger
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loss_fund_accounts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL REFERENCES tenants(id),
  employer_id                 VARCHAR(60) NOT NULL REFERENCES employers(id),
  account_number              VARCHAR(50) NOT NULL,
  bank_name                   VARCHAR(100),
  escrow_balance              NUMERIC(14,2) NOT NULL DEFAULT 0,
  minimum_threshold           NUMERIC(14,2) NOT NULL DEFAULT 10000,
  target_replenishment_amount NUMERIC(14,2) NOT NULL DEFAULT 50000,
  status                      VARCHAR(20) NOT NULL DEFAULT 'active'
                              CONSTRAINT loss_fund_accounts_status_chk
                              CHECK (status IN ('active', 'replenishment_needed', 'frozen', 'closed')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loss_fund_accounts_employer
  ON loss_fund_accounts(tenant_id, employer_id);

CREATE TABLE IF NOT EXISTS loss_fund_transactions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id),
  account_id              UUID NOT NULL REFERENCES loss_fund_accounts(id),
  claim_id                VARCHAR(60) REFERENCES claims(id),
  payment_transaction_id  UUID REFERENCES payment_transactions(id),
  transaction_type        VARCHAR(40) NOT NULL
                          CONSTRAINT loss_fund_transactions_type_chk
                          CHECK (transaction_type IN (
                            'client_deposit',
                            'disbursement_debit',
                            'fee_debit',
                            'reimbursement_credit'
                          )),
  amount                  NUMERIC(14,2) NOT NULL,
  resulting_balance       NUMERIC(14,2) NOT NULL,
  reference               VARCHAR(100),
  notes                   TEXT,
  created_by              TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loss_fund_tx_account
  ON loss_fund_transactions(account_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ALTER claims with Staffing Links & Multi-Axis Status
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE claims ADD COLUMN IF NOT EXISTS agency_id         UUID REFERENCES staffing_agencies(id);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS host_employer_id  UUID REFERENCES host_employers(id);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS assignment_id     UUID REFERENCES client_assignments(id);

ALTER TABLE claims ADD COLUMN IF NOT EXISTS admin_status VARCHAR(30) DEFAULT 'open'
  CONSTRAINT claims_admin_status_chk
  CHECK (admin_status IS NULL OR admin_status IN ('intake', 'open', 'reopened', 'closed'));

ALTER TABLE claims ADD COLUMN IF NOT EXISTS compensability_status VARCHAR(30) DEFAULT 'pending_investigation'
  CONSTRAINT claims_compensability_status_chk
  CHECK (compensability_status IS NULL OR compensability_status IN ('pending_investigation', 'accepted', 'delayed', 'denied'));

ALTER TABLE claims ADD COLUMN IF NOT EXISTS litigation_status VARCHAR(30) DEFAULT 'unrepresented'
  CONSTRAINT claims_litigation_status_chk
  CHECK (litigation_status IS NULL OR litigation_status IN ('unrepresented', 'represented', 'application_filed', 'in_settlement', 'awarded'));

CREATE INDEX IF NOT EXISTS idx_claims_host_employer ON claims(host_employer_id) WHERE host_employer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_admin_status  ON claims(admin_status);
CREATE INDEX IF NOT EXISTS idx_claims_comp_status   ON claims(compensability_status);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Backfill multi-axis fields on existing claims
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE claims SET
  admin_status = CASE
    WHEN status IN ('closed') THEN 'closed'
    WHEN status IN ('new_claim', 'intake_complete') THEN 'intake'
    ELSE 'open'
  END,
  compensability_status = CASE
    WHEN status IN ('denied') THEN 'denied'
    WHEN status IN ('accepted', 'active_medical', 'p_and_s', 'pd_evaluation', 'settlement_discussions', 'closed') THEN 'accepted'
    ELSE 'pending_investigation'
  END,
  litigation_status = CASE
    WHEN status = 'litigated' THEN 'application_filed'
    WHEN attorney_represented = TRUE THEN 'represented'
    ELSE 'unrepresented'
  END
WHERE admin_status IS NULL OR compensability_status IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE staffing_agencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE staffing_agencies FORCE ROW LEVEL SECURITY;

ALTER TABLE host_employers ENABLE ROW LEVEL SECURITY;
ALTER TABLE host_employers FORCE ROW LEVEL SECURITY;

ALTER TABLE client_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_assignments FORCE ROW LEVEL SECURITY;

ALTER TABLE claim_body_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_body_parts FORCE ROW LEVEL SECURITY;

ALTER TABLE loss_fund_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE loss_fund_accounts FORCE ROW LEVEL SECURITY;

ALTER TABLE loss_fund_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE loss_fund_transactions FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'staffing_agencies',
    'host_employers',
    'client_assignments',
    'claim_body_parts',
    'loss_fund_accounts',
    'loss_fund_transactions'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = tbl AND policyname = tbl || '_tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL USING (
          tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''信::UUID
          OR current_setting(''app.tenant_id'', true) IS NULL
        ) WITH CHECK (
          tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''信::UUID
          OR current_setting(''app.tenant_id'', true) IS NULL
        );',
        tbl || '_tenant_isolation',
        tbl
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
