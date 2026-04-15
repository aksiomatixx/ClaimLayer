-- ============================================================
-- M5 — Initial Schema
-- HomeCare TPA — California WC Claims Administration
--
-- Dependency order:
--   1. users (referenced by claims.adjuster_id)
--   2. employers
--   3. employees
--   4. claims
--   5. claim_events, diaries, reserves, documents, appointments
--   6. magic_link_tokens, providers
-- ============================================================

-- ── Extension ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── users ─────────────────────────────────────────────────────────────────────
-- System users — handled by Supabase Auth (auth.users).
-- This table mirrors only the fields the application needs.
CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY,           -- same UUID as auth.users.id
    email       VARCHAR(200) UNIQUE NOT NULL,
    role        VARCHAR(20) NOT NULL,       -- 'admin' | 'adjuster' | 'employer'
    employer_id UUID,                       -- populated for role='employer'
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── employers ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employers (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                    VARCHAR(200) NOT NULL,
    dba                     VARCHAR(200),
    address_line1           VARCHAR(200),
    address_city            VARCHAR(100),
    address_state           CHAR(2) DEFAULT 'CA',
    address_zip             VARCHAR(10),
    phone                   VARCHAR(20),
    primary_contact_name    VARCHAR(200),
    primary_contact_email   VARCHAR(200),
    primary_contact_phone   VARCHAR(20),
    fein                    VARCHAR(20),
    ca_employer_account_no  VARCHAR(30),
    adp_company_code        VARCHAR(20),
    filehandler_client_id   VARCHAR(50),
    mpn_enrolled            BOOLEAN DEFAULT FALSE,
    mpn_id                  VARCHAR(50),
    active                  BOOLEAN DEFAULT TRUE,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ── employees ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employees (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employer_id         UUID REFERENCES employers(id),
    adp_employee_id     VARCHAR(50) UNIQUE NOT NULL,   -- ADP internal employee ID (e.g. 'BC-001')
    adp_associate_oid   VARCHAR(50),                   -- ADP associateOID

    -- Demographics
    first_name          VARCHAR(100) NOT NULL,
    last_name           VARCHAR(100) NOT NULL,
    dob                 DATE,
    address_line1       VARCHAR(200),
    address_city        VARCHAR(100),
    address_state       CHAR(2),
    address_zip         VARCHAR(10),
    phone               VARCHAR(20),
    email               VARCHAR(200),

    -- Employment
    job_title           VARCHAR(200),
    hire_date           DATE,

    -- Financials (from ADP pay statements)
    aww                 DECIMAL(10,2),
    td_rate             DECIMAL(10,2),
    weeks_calculated    INTEGER,

    adp_data_last_pulled TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employees_adp_id ON employees(adp_employee_id);

-- ── claims ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS claims (
    id                  VARCHAR(60) PRIMARY KEY,       -- 'claim_<timestamp>'
    claim_number        VARCHAR(20) UNIQUE,            -- 'HHW-2026-042'
    employer_id         VARCHAR(100),                  -- employer identifier
    employee_id         UUID REFERENCES employees(id),

    -- FileHandler link
    filehandler_id      VARCHAR(50),

    -- Injury facts
    date_of_injury      DATE,
    body_part           VARCHAR(100),
    injury_type         VARCHAR(100),
    injury_description  TEXT,
    employer_name       VARCHAR(200),

    -- Financial
    aww                 DECIMAL(10,2),
    td_rate             DECIMAL(10,2),
    weeks_calculated    INTEGER,

    -- Status machine
    status              VARCHAR(50) NOT NULL DEFAULT 'new_claim',

    -- AI analysis
    ai_analysis         JSONB,
    priority            VARCHAR(20),

    -- Employee snapshot (JSONB for quick retrieval without join)
    employee            JSONB,

    -- Reserves (current — history in reserves table)
    reserve_medical     DECIMAL(12,2) DEFAULT 0,
    reserve_indemnity   DECIMAL(12,2) DEFAULT 0,
    reserve_expense     DECIMAL(12,2) DEFAULT 0,

    -- Employer portal / magic link
    magic_link_sent_at  TIMESTAMPTZ,
    intake_progress     JSONB DEFAULT '{"voice_complete":false,"media_complete":false,"mpn_acknowledged":false,"provider_selected":false,"appointment_confirmed":false,"dwc1_generated":false}',

    filed_at            TIMESTAMPTZ DEFAULT NOW(),     -- FROI receipt (LC §5400)
    adjuster_id         UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT valid_status CHECK (status IN (
        'new_claim', 'intake_complete', 'under_investigation', 'accepted',
        'active_medical', 'p_and_s', 'pd_evaluation', 'settlement_discussions',
        'closed', 'denied', 'litigated'
    ))
);

CREATE INDEX IF NOT EXISTS idx_claims_employer_id  ON claims(employer_id);
CREATE INDEX IF NOT EXISTS idx_claims_status       ON claims(status);
CREATE INDEX IF NOT EXISTS idx_claims_created_at   ON claims(created_at);
CREATE INDEX IF NOT EXISTS idx_claims_claim_number ON claims(claim_number);

-- ── Sequence function for claim numbers ──────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS claim_number_seq START 42;

CREATE OR REPLACE FUNCTION next_claim_number()
RETURNS TEXT AS $$
DECLARE
    seq_val BIGINT;
    year_val TEXT;
BEGIN
    seq_val  := nextval('claim_number_seq');
    year_val := to_char(NOW(), 'YYYY');
    RETURN 'HHW-' || year_val || '-' || lpad(seq_val::TEXT, 3, '0');
END;
$$ LANGUAGE plpgsql;

-- ── claim_events ──────────────────────────────────────────────────────────────
-- Immutable append-only log. Never UPDATE, only INSERT.
CREATE TABLE IF NOT EXISTS claim_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id    VARCHAR(60) REFERENCES claims(id) ON DELETE CASCADE,
    type        VARCHAR(100) NOT NULL,
    timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    data        JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claim_events_claim_id  ON claim_events(claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_events_type      ON claim_events(type);
CREATE INDEX IF NOT EXISTS idx_claim_events_timestamp ON claim_events(timestamp);

-- ── diaries ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS diaries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id    VARCHAR(60) REFERENCES claims(id) ON DELETE CASCADE,
    diary_type  VARCHAR(100) NOT NULL,
    due_date    DATE,
    assigned_to VARCHAR(200),
    priority    VARCHAR(20),
    notes       TEXT,
    status      VARCHAR(20) DEFAULT 'open',   -- 'open' | 'completed' | 'cancelled'
    fh_diary_id VARCHAR(50),                  -- FileHandler diary ID after sync
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_diaries_claim_id  ON diaries(claim_id);
CREATE INDEX IF NOT EXISTS idx_diaries_due_date  ON diaries(due_date);
CREATE INDEX IF NOT EXISTS idx_diaries_status    ON diaries(status);

-- ── reserves ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reserves (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id    VARCHAR(60) REFERENCES claims(id) ON DELETE CASCADE,
    medical     DECIMAL(12,2) DEFAULT 0,
    indemnity   DECIMAL(12,2) DEFAULT 0,
    expense     DECIMAL(12,2) DEFAULT 0,
    reason      TEXT,
    source      VARCHAR(50),                  -- 'AI_ENGINE' | 'ADJUSTER'
    approved_by VARCHAR(200),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reserves_claim_id ON reserves(claim_id);

-- ── documents ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            VARCHAR(60) REFERENCES claims(id) ON DELETE CASCADE,
    filehandler_doc_id  VARCHAR(50),
    doc_type            VARCHAR(50) NOT NULL,
    description         VARCHAR(500),
    source              VARCHAR(50),
    storage_path        VARCHAR(500),
    file_size_bytes     INTEGER,
    mime_type           VARCHAR(100),
    ai_read             BOOLEAN DEFAULT FALSE,
    ai_summary          TEXT,
    ai_key_findings     JSONB,
    ai_read_at          TIMESTAMPTZ,
    filehandler_pushed  BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_claim_id ON documents(claim_id);
CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type);

-- ── appointments ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id        VARCHAR(60) REFERENCES claims(id) ON DELETE CASCADE,
    provider_id     VARCHAR(50),
    appointment_date DATE,
    appointment_time VARCHAR(20),
    visit_type      VARCHAR(50),
    status          VARCHAR(20) DEFAULT 'scheduled',  -- 'scheduled' | 'confirmed' | 'completed' | 'cancelled'
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointments_claim_id ON appointments(claim_id);

-- ── magic_link_tokens ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS magic_link_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    jti             VARCHAR(200) UNIQUE NOT NULL,
    claim_id        VARCHAR(60) REFERENCES claims(id) ON DELETE CASCADE,
    adp_employee_id VARCHAR(50) NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    generated_by    UUID REFERENCES users(id),
    sent_to_email   VARCHAR(200),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_magic_link_tokens_jti     ON magic_link_tokens(jti);
CREATE INDEX        IF NOT EXISTS idx_magic_link_tokens_claim   ON magic_link_tokens(claim_id);
CREATE INDEX        IF NOT EXISTS idx_magic_link_tokens_cleanup ON magic_link_tokens(expires_at)
    WHERE used_at IS NULL;

-- ── providers (MPN directory cache) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS providers (
    id                  VARCHAR(20) PRIMARY KEY,       -- e.g. 'prov_001'
    name                VARCHAR(200) NOT NULL,
    specialty           VARCHAR(100),
    address_line1       VARCHAR(200),
    city                VARCHAR(100),
    state               CHAR(2) DEFAULT 'CA',
    zip                 VARCHAR(10),
    phone               VARCHAR(20),
    fax                 VARCHAR(20),
    email               VARCHAR(200),
    mpn_tier            SMALLINT DEFAULT 2,
    walk_in             BOOLEAN DEFAULT FALSE,
    rating              DECIMAL(3,1),
    hours               VARCHAR(200),
    languages           JSONB DEFAULT '[]',
    accepting_new_wc    BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
