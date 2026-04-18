-- M14.5: Award Response, Disbursement Queue & Advance Cap Retrofit
--
-- Builds on M13 (pd_advances, stipulations), M19 (settlement_offers) and
-- M14 (settlement_offers workflow columns).
--
-- New tables:
--   pd_advance_payments     — per-week PD disbursement tracking
--   award_disbursements     — computed payout bundles awaiting adjuster approval
--   deferred_penalty_flags  — TEMPORARY bridge table for M17A penalty scope
--
-- ALTERs:
--   pd_advances  — cap-override + denominator columns
--   stipulations — award_service_date (§5814 service clock)
--   claims       — p_and_s_date + source/confirmedBy/confirmedAt
--
-- DO NOT RUN AUTOMATICALLY. Review and apply manually via:
--   supabase db push
-- or
--   psql -f supabase/migrations/20260101000011_m14_5_disbursement.sql
--
-- All new CHECK constraints are explicitly named per project convention:
--   {table}_{column}_chk
-- For the existing pd_advances.status CHECK (unnamed default from M13), we
-- lookup pg_constraint before swapping to preserve idempotency.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════════
-- 1.1 pd_advance_payments — per-week disbursement tracking
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pd_advance_payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pd_advance_id     UUID NOT NULL REFERENCES pd_advances(id),
  claim_id          VARCHAR(60) NOT NULL REFERENCES claims(id),
  week_start_date   DATE NOT NULL,
  week_end_date     DATE NOT NULL,
  amount_paid       NUMERIC(10,2) NOT NULL,
  paid_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_by           UUID,
  reference         VARCHAR(100),
  status            VARCHAR(20) NOT NULL DEFAULT 'paid'
                    CONSTRAINT pd_advance_payments_status_chk
                    CHECK (status IN ('paid', 'voided')),
  void_reason       TEXT,
  voided_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pd_advance_payments_claim
  ON pd_advance_payments(claim_id);
CREATE INDEX IF NOT EXISTS idx_pd_advance_payments_advance
  ON pd_advance_payments(pd_advance_id);

ALTER TABLE pd_advance_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY pd_advance_payments_admin ON pd_advance_payments FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));

-- ═════════════════════════════════════════════════════════════════════════════
-- 1.2 ALTER pd_advances — cap infrastructure + denominator
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE pd_advances ADD COLUMN IF NOT EXISTS cap_overridden           BOOLEAN DEFAULT FALSE;
ALTER TABLE pd_advances ADD COLUMN IF NOT EXISTS cap_override_pct         NUMERIC(4,3);
ALTER TABLE pd_advances ADD COLUMN IF NOT EXISTS cap_override_by          UUID;
ALTER TABLE pd_advances ADD COLUMN IF NOT EXISTS cap_override_reason      TEXT;

-- Post-apportionment total PD dollars at time of advance initiation.
-- Apportionment reduces weeks owed, not weekly rate. This denominator
-- is the dollar ceiling against which the cap applies.
-- Priority: adjusted_total_value > pd_total_value (fallback pre-QME).
ALTER TABLE pd_advances ADD COLUMN IF NOT EXISTS estimated_pd_denominator NUMERIC(10,2);

ALTER TABLE pd_advances ADD COLUMN IF NOT EXISTS denominator_source       VARCHAR(20)
  CONSTRAINT pd_advances_denominator_source_chk
  CHECK (denominator_source IS NULL OR denominator_source IN (
    'qme_rated', 'pr_4', 'pre_qme'
  ));

ALTER TABLE pd_advances ADD COLUMN IF NOT EXISTS notes                    TEXT;

-- ═════════════════════════════════════════════════════════════════════════════
-- 1.3 ALTER stipulations — award service date (§5814 clock)
-- ═════════════════════════════════════════════════════════════════════════════
-- award_service_date is when the WCAB served the F&A (starts LC §5814
-- 10-day clock). Distinct from eams_filed_at (when TPA filed with WCAB).
ALTER TABLE stipulations ADD COLUMN IF NOT EXISTS award_service_date DATE;
ALTER TABLE stipulations ADD COLUMN IF NOT EXISTS award_served_by    TEXT;

-- ═════════════════════════════════════════════════════════════════════════════
-- 1.4 ALTER claims — P&S date as first-class column
-- ═════════════════════════════════════════════════════════════════════════════
-- Drives TD termination (LC §4650), PD advance start (LC §4650(b)),
-- 104-week TD cap evaluation, MMI/PR-4 workflow, settlement gating, and
-- M14.5 accrued-start-date. Source priority for overwrite (highest first):
--   qme_report > pr_4 > treating_physician > award_document > adjuster_entry
-- Lower-priority sources do not overwrite higher-priority existing values.
--
-- Backfill: intentionally NULL for existing claims. New claims get
-- populated via pdService.setPAndSDate write-through helper (§5.1.7).
ALTER TABLE claims ADD COLUMN IF NOT EXISTS p_and_s_date         DATE;

ALTER TABLE claims ADD COLUMN IF NOT EXISTS p_and_s_source       VARCHAR(20)
  CONSTRAINT claims_p_and_s_source_chk
  CHECK (p_and_s_source IS NULL OR p_and_s_source IN (
    'qme_report', 'pr_4', 'treating_physician',
    'award_document', 'adjuster_entry'
  ));

ALTER TABLE claims ADD COLUMN IF NOT EXISTS p_and_s_confirmed_by UUID;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS p_and_s_confirmed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_claims_p_and_s
  ON claims(p_and_s_date) WHERE p_and_s_date IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- 1.5 award_disbursements — computed payout bundles awaiting approval
-- ═════════════════════════════════════════════════════════════════════════════
-- Allowed `flags` values (stored as TEXT[] for forward compatibility):
--   LIEN_PRESENT_ADJUSTER_REVIEW
--   OVERPAYMENT_RECOVERABLE
--   ADVANCE_CAP_RETROACTIVELY_EXCEEDED
--   DEU_RANGE_EXCEEDED
--   APPORTIONMENT_MISMATCH
--   AA_FEE_UNUSUAL
--   INTEREST_OWED_LATE_PAYMENT
--   SERVICE_DATE_MISSING
--   P_AND_S_DISCREPANCY
CREATE TABLE IF NOT EXISTS award_disbursements (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id                   VARCHAR(60) NOT NULL REFERENCES claims(id),
  stipulation_id             UUID REFERENCES stipulations(id),
  settlement_offer_id        UUID REFERENCES settlement_offers(id),
  award_type                 VARCHAR(20) NOT NULL
                             CONSTRAINT award_disbursements_award_type_chk
                             CHECK (award_type IN ('stip_f_and_a', 'cnr_oacr')),
  award_document_id          UUID,
  award_date                 DATE NOT NULL,
  award_service_date         DATE NOT NULL,
  accrued_start_date         DATE NOT NULL,
  total_award                NUMERIC(10,2) NOT NULL,
  apportionment_pct          NUMERIC(5,2),
  weekly_rate                NUMERIC(8,2),
  accrued_weeks              NUMERIC(8,4),
  accrued_amount             NUMERIC(10,2),
  scheduled_weeks            NUMERIC(8,4),
  scheduled_amount           NUMERIC(10,2),
  aa_fee_pct                 NUMERIC(5,2),
  aa_fee_amount              NUMERIC(10,2),
  aa_fee_commuted            BOOLEAN DEFAULT FALSE,
  aa_fee_weeks_eliminated    NUMERIC(8,4),
  aa_fee_pv_at_commutation   NUMERIC(10,2),
  advances_paid_to_date      NUMERIC(10,2) NOT NULL DEFAULT 0,
  advances_offset_applied    NUMERIC(10,2) NOT NULL DEFAULT 0,
  net_to_worker_now          NUMERIC(10,2),
  net_to_worker_scheduled    NUMERIC(10,2),
  interest_owed              NUMERIC(10,2) DEFAULT 0,
  flags                      TEXT[] DEFAULT '{}',
  status                     VARCHAR(20) NOT NULL DEFAULT 'proposed'
                             CONSTRAINT award_disbursements_status_chk
                             CHECK (status IN (
                               'proposed', 'approved', 'disbursed',
                               'superseded', 'rejected'
                             )),
  approved_by                UUID,
  approved_at                TIMESTAMPTZ,
  approval_notes             TEXT,
  rejected_reason            TEXT,
  disbursed_at               TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT award_disbursements_xor_link_chk CHECK (
    (stipulation_id IS NOT NULL AND settlement_offer_id IS NULL) OR
    (stipulation_id IS NULL AND settlement_offer_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_award_disbursements_claim
  ON award_disbursements(claim_id);
CREATE INDEX IF NOT EXISTS idx_award_disbursements_pending
  ON award_disbursements(status) WHERE status = 'proposed';

ALTER TABLE award_disbursements ENABLE ROW LEVEL SECURITY;
CREATE POLICY award_disbursements_admin ON award_disbursements FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));

-- ═════════════════════════════════════════════════════════════════════════════
-- 1.6 deferred_penalty_flags — TEMPORARY M17A bridge table
-- ═════════════════════════════════════════════════════════════════════════════
-- TEMPORARY — M17A will migrate these into the penalty_exposures table and
-- drop this table. Do not build features against this table beyond M14.5.
CREATE TABLE IF NOT EXISTS deferred_penalty_flags (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id          VARCHAR(60) NOT NULL REFERENCES claims(id),
  source_type       VARCHAR(50) NOT NULL,
  source_id         UUID,
  statute           VARCHAR(30) NOT NULL DEFAULT 'LC_5814',
  event_date        DATE NOT NULL,
  deadline_date     DATE NOT NULL,
  amount_at_risk    NUMERIC(10,2),
  penalty_estimate  NUMERIC(10,2),
  notes             TEXT,
  consumed_by_m17a  BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deferred_penalty_unconsumed
  ON deferred_penalty_flags(claim_id) WHERE consumed_by_m17a = FALSE;

ALTER TABLE deferred_penalty_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY deferred_penalty_flags_admin ON deferred_penalty_flags FOR ALL TO authenticated
  USING ((SELECT role FROM users WHERE id = auth.uid()) IN ('admin', 'adjuster'));

COMMIT;
