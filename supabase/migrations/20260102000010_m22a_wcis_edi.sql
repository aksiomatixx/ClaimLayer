-- ============================================================
-- M22A — California WCIS EDI (FROI + SROI) infrastructure
--
-- Four new tables and one claims-column retrofit support the
-- FROI/SROI transmission pipeline:
--
--   wcis_trigger_queue   — events awaiting MTC assembly
--   wcis_transactions    — assembled MTC payloads
--   wcis_transmissions   — batched transmissions to WCIS
--   wcis_claim_state     — per-claim EDI state (JCN, open BTCs, etc.)
--
-- Plus:
--   ALTER claims ADD wcis_enabled / insurer_fein / employer_fein /
--     claim_administrator_fein / wcis_suppress_reason
--   SEQUENCE wcis_stub_jcn_seq (stubAdapter-synthesized JCNs)
--
-- Authority:
--   LC §138.6 (WCIS establishment)
--   8 CCR §§9700-9704 (WCIS reporting rules)
--   CA EDI Implementation Guide for FROI/SROI v3.1 (Mar 27, 2018)
--
-- All CHECK constraints are explicitly named using the pattern
-- {table}_{column}_chk per build constraint #4.
-- ============================================================

BEGIN;

-- ── wcis_trigger_queue ──────────────────────────────────────────────────────
-- Events that MAY produce a WCIS transaction are enqueued here by
-- service-layer hooks (claimService, pdService, cnrService, etc.).
-- wcisPayloadService drains the queue and assembles MTC payloads.
CREATE TABLE IF NOT EXISTS wcis_trigger_queue (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id                  VARCHAR(60) NOT NULL REFERENCES claims(id),
    trigger_event             VARCHAR(60) NOT NULL,
    source_service            VARCHAR(40) NOT NULL,
    source_record_id          UUID,
    mtc_family                VARCHAR(10) NOT NULL
        CONSTRAINT wcis_trigger_queue_mtc_family_chk
        CHECK (mtc_family IN ('FROI','SROI')),
    mtc_code                  VARCHAR(3) NOT NULL,
    event_date                DATE NOT NULL,
    deadline_date             DATE NOT NULL,
    deadline_type             VARCHAR(25) NOT NULL
        CONSTRAINT wcis_trigger_queue_deadline_type_chk
        CHECK (deadline_type IN (
            'business_days_10',
            'business_days_15',
            'calendar_days_60',
            'next_submission')),
    status                    VARCHAR(20) NOT NULL DEFAULT 'pending'
        CONSTRAINT wcis_trigger_queue_status_chk
        CHECK (status IN ('pending','processing','generated','suppressed','failed')),
    suppression_reason        TEXT,
    payload_context           JSONB,
    notes                     TEXT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at              TIMESTAMPTZ,
    generated_transaction_id  UUID
);

CREATE INDEX IF NOT EXISTS idx_wcis_trigger_queue_pending
    ON wcis_trigger_queue(deadline_date)
    WHERE status IN ('pending','processing');

CREATE INDEX IF NOT EXISTS idx_wcis_trigger_queue_claim
    ON wcis_trigger_queue(claim_id);

ALTER TABLE wcis_trigger_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wcis_trigger_queue_admin ON wcis_trigger_queue;
CREATE POLICY wcis_trigger_queue_admin ON wcis_trigger_queue
    FOR ALL USING (
        EXISTS (SELECT 1 FROM users u
                WHERE u.id = auth.uid() AND u.role = 'admin')
    );

-- ── wcis_transactions ───────────────────────────────────────────────────────
-- Assembled MTC payloads. One row per MTC (FROI 00, SROI IP, etc.).
-- flatfile_rendered is the IAIABC Release 1 flat-file body.
-- ack_type/ack_error_codes/ack_raw populated by wcisAckPoller.
CREATE TABLE IF NOT EXISTS wcis_transactions (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id             VARCHAR(60) NOT NULL REFERENCES claims(id),
    trigger_queue_id     UUID REFERENCES wcis_trigger_queue(id),
    transmission_id      UUID,
    mtc_family           VARCHAR(10) NOT NULL
        CONSTRAINT wcis_transactions_mtc_family_chk
        CHECK (mtc_family IN ('FROI','SROI')),
    mtc_code             VARCHAR(3) NOT NULL,
    mtc_date             DATE NOT NULL,
    jcn_at_submission    VARCHAR(30),
    environment          VARCHAR(20) NOT NULL
        CONSTRAINT wcis_transactions_environment_chk
        CHECK (environment IN ('test','pilot','production')),
    payload              JSONB NOT NULL,
    payload_hash         VARCHAR(64) NOT NULL,
    flatfile_rendered    TEXT,
    validation_warnings  JSONB DEFAULT '[]',
    status               VARCHAR(25) NOT NULL DEFAULT 'generated'
        CONSTRAINT wcis_transactions_status_chk
        CHECK (status IN ('generated','batched','transmitted',
            'accepted','accepted_with_error','rejected',
            'superseded','abandoned','stub_transmitted')),
    ack_type             VARCHAR(10)
        CONSTRAINT wcis_transactions_ack_type_chk
        CHECK (ack_type IS NULL OR ack_type IN ('997','AK1','824')),
    ack_error_codes      JSONB,
    ack_raw              TEXT,
    ack_received_at      TIMESTAMPTZ,
    adapter_used         VARCHAR(30) NOT NULL,
    vendor_reference     VARCHAR(100),
    transmitted_at       TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wcis_transactions_claim
    ON wcis_transactions(claim_id);

CREATE INDEX IF NOT EXISTS idx_wcis_transactions_status
    ON wcis_transactions(status);

CREATE INDEX IF NOT EXISTS idx_wcis_transactions_awaiting_ack
    ON wcis_transactions(transmitted_at)
    WHERE status IN ('transmitted','stub_transmitted')
      AND ack_received_at IS NULL;

ALTER TABLE wcis_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wcis_transactions_admin ON wcis_transactions;
CREATE POLICY wcis_transactions_admin ON wcis_transactions
    FOR ALL USING (
        EXISTS (SELECT 1 FROM users u
                WHERE u.id = auth.uid() AND u.role = 'admin')
    );

-- ── wcis_transmissions ──────────────────────────────────────────────────────
-- One row per batch file sent to WCIS. In M22A every transmission
-- goes through stubAdapter (status = 'stub_transmitted').
-- file_sequence is the per-environment sequence number (needed for
-- IAIABC Release 1 header).
CREATE TABLE IF NOT EXISTS wcis_transmissions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    environment             VARCHAR(20) NOT NULL
        CONSTRAINT wcis_transmissions_environment_chk
        CHECK (environment IN ('test','pilot','production')),
    mtc_family              VARCHAR(10) NOT NULL
        CONSTRAINT wcis_transmissions_mtc_family_chk
        CHECK (mtc_family IN ('FROI','SROI')),
    file_name               VARCHAR(80),
    file_sequence           INTEGER NOT NULL,
    transaction_count       INTEGER NOT NULL,
    adapter_used            VARCHAR(30) NOT NULL,
    sftp_remote_path        VARCHAR(200),
    vendor_reference        VARCHAR(100),
    status                  VARCHAR(25) NOT NULL DEFAULT 'queued'
        CONSTRAINT wcis_transmissions_status_chk
        CHECK (status IN ('queued','building','transmitting','transmitted',
            'ack_997_received','ack_824_received','completed',
            'failed','stub_transmitted')),
    ack_997_received_at     TIMESTAMPTZ,
    ack_824_received_at     TIMESTAMPTZ,
    ack_summary             JSONB,
    transmitted_at          TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    error_message           TEXT
);

CREATE INDEX IF NOT EXISTS idx_wcis_transmissions_awaiting_ack
    ON wcis_transmissions(transmitted_at)
    WHERE status IN ('transmitted','stub_transmitted','ack_997_received');

ALTER TABLE wcis_transmissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wcis_transmissions_admin ON wcis_transmissions;
CREATE POLICY wcis_transmissions_admin ON wcis_transmissions
    FOR ALL USING (
        EXISTS (SELECT 1 FROM users u
                WHERE u.id = auth.uid() AND u.role = 'admin')
    );

-- ── wcis_claim_state ────────────────────────────────────────────────────────
-- Per-claim EDI state. JCN assigned by WCIS on FROI 00 accept
-- (stubbed during M22A). open_benefit_codes mirrors DN85 codes
-- currently paying (e.g. '050' TT, '070' TP, '030' PD scheduled).
CREATE TABLE IF NOT EXISTS wcis_claim_state (
    claim_id                      VARCHAR(60) PRIMARY KEY REFERENCES claims(id),
    jcn                           VARCHAR(30) UNIQUE,
    first_froi_transaction_id     UUID REFERENCES wcis_transactions(id),
    first_froi_submitted_at       TIMESTAMPTZ,
    first_froi_accepted_at        TIMESTAMPTZ,
    claim_admin_claim_number      VARCHAR(60) NOT NULL,
    insurer_fein                  VARCHAR(9),
    claim_administrator_fein      VARCHAR(9),
    open_benefit_codes            TEXT[] DEFAULT '{}',
    last_sroi_submitted_at        TIMESTAMPTZ,
    last_sroi_mtc                 VARCHAR(3),
    denied_at                     TIMESTAMPTZ,
    closed_at                     TIMESTAMPTZ,
    representation_reported_at    TIMESTAMPTZ,
    worker_death_reported_at      TIMESTAMPTZ,
    environment                   VARCHAR(20) NOT NULL DEFAULT 'production'
        CONSTRAINT wcis_claim_state_environment_chk
        CHECK (environment IN ('test','pilot','production')),
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wcis_claim_state_jcn
    ON wcis_claim_state(jcn) WHERE jcn IS NOT NULL;

ALTER TABLE wcis_claim_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wcis_claim_state_admin ON wcis_claim_state;
CREATE POLICY wcis_claim_state_admin ON wcis_claim_state
    FOR ALL USING (
        EXISTS (SELECT 1 FROM users u
                WHERE u.id = auth.uid() AND u.role = 'admin')
    );

-- ── claims retrofit ─────────────────────────────────────────────────────────
-- Per-claim WCIS control fields. wcis_enabled=FALSE suppresses all
-- transmission for claims we intentionally withhold (e.g. pre-WCIS
-- DOI, client opt-out). FEINs are claim-level overrides; the employer
-- table also carries default FEINs set by the M22A prebuild migration.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS
    wcis_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS
    wcis_suppress_reason TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS
    insurer_fein VARCHAR(9);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS
    claim_administrator_fein VARCHAR(9);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS
    employer_fein VARCHAR(9);

-- ── wcis_stub_jcn_seq ───────────────────────────────────────────────────────
-- Used by stubAdapter to synthesize JCNs for FROI 00 acceptances.
-- Production-side JCNs will come from WCIS on real 824 acks.
CREATE SEQUENCE IF NOT EXISTS wcis_stub_jcn_seq START 1;

COMMIT;
