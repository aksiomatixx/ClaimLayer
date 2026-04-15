-- ============================================================
-- M5 — Initial Schema (v1.2)
-- HomeCare TPA — California WC Claims Administration
--
-- Dependency order:
--   1. users           (referenced by claims.adjuster_id)
--   2. employers
--   3. employees
--   4. claims          (references users, employers, employees)
--   5. claim_events    (references claims)
--   6. documents       (references claims)
--   7. rfas            (references claims)
--   8. rfa_evaluations (references rfas, users)
--   9. reserves        (references claims)
--  10. diaries         (references claims)
--  11. ai_decisions    (references claims, rfas, documents, users)
--  12. notices         (references claims)
--  13. providers
--  14. magic_link_tokens (references claims, users)
--  15. audit_log       (references users)
--  16. appointments    (references claims)
--
-- Backend-compatibility notes:
--   - claims.id          is VARCHAR(60) — backend generates 'claim_<ts>_<rand>' IDs
--   - claims.employer_id is VARCHAR(100) — EMPLOYER_SEED uses string keys, not UUIDs
--   - claim_events uses columns: type, timestamp, data (not event_type/event_data)
--   - diaries uses columns: due_date DATE, fh_diary_id, assigned_to VARCHAR
--   - reserves uses columns: source, approved_by VARCHAR (not set_by, UUID)
--   - providers.id is VARCHAR(20) — seed uses 'prov_001' etc.
--   - employees has adp_employee_id as the backend lookup key
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── users ─────────────────────────────────────────────────────────────────────
-- System users — synced from Supabase Auth (auth.users).
-- id matches auth.users.id. Omitting the FK reference here for test compatibility.
CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY,           -- mirrors auth.users.id
    role                VARCHAR(20) NOT NULL,       -- 'admin' | 'adjuster' | 'employer'
    employer_id         UUID,                       -- set for role='employer'
    first_name          VARCHAR(100),
    last_name           VARCHAR(100),
    email               VARCHAR(200) UNIQUE,
    phone               VARCHAR(20),
    active              BOOLEAN DEFAULT TRUE,
    last_login_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW()
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
-- adp_employee_id is the backend lookup key (e.g. 'BC-001').
-- adp_associate_oid is ADP's internal OID.
CREATE TABLE IF NOT EXISTS employees (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employer_id         UUID REFERENCES employers(id),
    adp_employee_id     VARCHAR(50) UNIQUE,         -- backend lookup key (e.g. 'BC-001')
    adp_associate_oid   VARCHAR(50),                -- ADP's associateOID

    -- Demographics (pulled from ADP)
    first_name          VARCHAR(100) NOT NULL,
    last_name           VARCHAR(100) NOT NULL,
    dob                 DATE,
    ssn_last4           CHAR(4),                    -- Last 4 only
    address_line1       VARCHAR(200),
    address_city        VARCHAR(100),
    address_state       CHAR(2),
    address_zip         VARCHAR(10),
    phone               VARCHAR(20),
    email               VARCHAR(200),

    -- Employment
    job_title           VARCHAR(200),
    department          VARCHAR(200),
    hire_date           DATE,
    pay_type            VARCHAR(20),                -- 'hourly' | 'salary'
    hourly_rate         DECIMAL(10,2),
    avg_hours_per_week  DECIMAL(5,1),

    -- Financials (calculated from ADP pay statements)
    aww                 DECIMAL(10,2),
    td_rate             DECIMAL(10,2),
    weeks_calculated    INTEGER,
    aww_calculated_at   TIMESTAMPTZ,

    adp_data_last_pulled TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employees_adp_employee_id ON employees(adp_employee_id);
CREATE INDEX IF NOT EXISTS idx_employees_adp_oid         ON employees(adp_associate_oid);

-- ── claims ────────────────────────────────────────────────────────────────────
-- id: backend-generated format 'claim_<timestamp>_<random>' (up to ~60 chars)
-- claim_number: human-readable 'HHW-YYYY-NNN' (from next_claim_number())
-- employer_id: string key (EMPLOYER_SEED uses non-UUID keys like 'employer-brightcare-001')
CREATE TABLE IF NOT EXISTS claims (
    id                  VARCHAR(60) PRIMARY KEY,    -- internal: 'claim_<ts>_<rand>'
    claim_number        VARCHAR(20) UNIQUE,         -- display: 'HHW-2026-042'
    employer_id         VARCHAR(100),               -- employer identifier (may be UUID or string)
    employee_id         UUID REFERENCES employees(id),

    -- FileHandler link
    filehandler_id      VARCHAR(50),                -- FileHandler claim ID after sync

    -- Injury facts
    date_of_injury      DATE NOT NULL,
    body_part           VARCHAR(100),
    injury_type         VARCHAR(100),
    injury_description  TEXT,
    employer_name       VARCHAR(200),               -- denormalized for quick display

    -- Employee snapshot (JSONB for retrieval without join)
    employee            JSONB,

    -- Work status
    off_work            BOOLEAN DEFAULT FALSE,
    off_work_start      DATE,
    off_work_end        DATE,
    rtw_date            DATE,

    -- Financials
    aww                 DECIMAL(10,2),
    td_rate             DECIMAL(10,2),
    weeks_calculated    INTEGER,

    -- Status (state machine)
    status              VARCHAR(50) NOT NULL DEFAULT 'new_claim',
                        -- new_claim | intake_complete | under_investigation |
                        -- accepted | active_medical | p_and_s | pd_evaluation |
                        -- settlement_discussions | closed | denied | litigated

    -- Compensability
    compensability_decision VARCHAR(30),            -- 'accepted' | 'denied' | 'pending'
    compensability_decided_at TIMESTAMPTZ,
    compensability_decided_by VARCHAR(200),
    denial_reason       TEXT,

    -- AI analysis (stored as a single JSONB blob for M5; structured columns planned for M6)
    ai_analysis         JSONB,
    priority            VARCHAR(20),               -- 'Critical' | 'High' | 'Medium' | 'Low'
    ai_analyzed_at      TIMESTAMPTZ,

    -- Reserves (current — history in reserves table)
    reserve_medical     DECIMAL(12,2) DEFAULT 0,
    reserve_indemnity   DECIMAL(12,2) DEFAULT 0,
    reserve_expense     DECIMAL(12,2) DEFAULT 0,

    -- DxF
    dxf_roster_enrolled BOOLEAN DEFAULT FALSE,
    dxf_enrolled_at     TIMESTAMPTZ,

    -- Employer portal / magic link
    magic_link_sent_at  TIMESTAMPTZ,
    intake_progress     JSONB DEFAULT '{"voice_complete":false,"media_complete":false,"mpn_acknowledged":false,"provider_selected":false,"appointment_confirmed":false,"dwc1_generated":false}',

    -- Admin
    filed_by            VARCHAR(20),               -- 'employer' | 'employee'
    filed_at            TIMESTAMPTZ DEFAULT NOW(), -- FROI receipt (LC §5400)
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
CREATE INDEX IF NOT EXISTS idx_claims_adjuster     ON claims(adjuster_id);
CREATE INDEX IF NOT EXISTS idx_claims_doi          ON claims(date_of_injury);
CREATE INDEX IF NOT EXISTS idx_claims_created_at   ON claims(created_at);
CREATE INDEX IF NOT EXISTS idx_claims_claim_number ON claims(claim_number);

-- ── Sequence and function for claim numbers ───────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS claim_number_seq START 42;

CREATE OR REPLACE FUNCTION next_claim_number()
RETURNS TEXT AS $$
DECLARE
    seq_val  BIGINT;
    year_val TEXT;
BEGIN
    seq_val  := nextval('claim_number_seq');
    year_val := to_char(NOW(), 'YYYY');
    RETURN 'HHW-' || year_val || '-' || lpad(seq_val::TEXT, 3, '0');
END;
$$ LANGUAGE plpgsql;

-- ── claim_events ──────────────────────────────────────────────────────────────
-- Immutable append-only log. Never UPDATE, only INSERT.
-- Column names match backend inserts: type, timestamp, data.
CREATE TABLE IF NOT EXISTS claim_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id    VARCHAR(60) REFERENCES claims(id) ON DELETE CASCADE,
    type        VARCHAR(100) NOT NULL,
                -- 'status_changed' | 'reserve_update' | 'ai_analysis_complete' |
                -- 'document_received' | 'appointment_booked' | 'appointment_confirmed' |
                -- 'rfa_received' | 'rfa_approved' | 'rfa_denied' |
                -- 'diary_created' | 'diary_completed' | 'notice_sent' |
                -- 'payment_issued' | 'adjuster_decision' | 'adt_received' |
                -- 'filehandler_claim_created' | 'filehandler_sync_failed' |
                -- 'reserves_approved' | 'reserves_set' | 'ai_analysis_failed'
    timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    data        JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claim_events_claim_id  ON claim_events(claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_events_type      ON claim_events(type);
CREATE INDEX IF NOT EXISTS idx_claim_events_timestamp ON claim_events(timestamp);

-- ── documents ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            VARCHAR(60) REFERENCES claims(id) ON DELETE CASCADE,
    filehandler_doc_id  VARCHAR(50),

    -- Document metadata
    doc_type            VARCHAR(50) NOT NULL,
                        -- 'ai_reasoning_pdf' | 'dwc1' | 'pr2' | 'pr3' |
                        -- 'rfa_form' | 'rfa_auth_letter' | 'mri_report' |
                        -- 'operative_report' | 'lab_result' | 'dwc7' | 'td_notice' |
                        -- 'denial_letter' | 'imr_rights_notice' | 'qme_report' |
                        -- 'photo' | 'video' | 'voice_transcript' | 'other'
    description         VARCHAR(500),

    -- Source
    source              VARCHAR(50),               -- 'employee_upload' | 'dxf' | 'generated' | 'employer_upload'
    source_facility     VARCHAR(200),
    source_provider_npi VARCHAR(20),

    -- Storage
    storage_path        VARCHAR(500),
    file_size_bytes     INTEGER,
    mime_type           VARCHAR(100),

    -- AI processing
    ai_read             BOOLEAN DEFAULT FALSE,
    ai_summary          TEXT,
    ai_key_findings     JSONB,
    ai_read_at          TIMESTAMPTZ,

    -- Clinical document fields
    document_date       DATE,
    next_appointment    DATE,
    work_status         VARCHAR(30),               -- 'full_duty' | 'modified' | 'off_work'
    work_restriction_end DATE,
    contains_rfa        BOOLEAN DEFAULT FALSE,

    filehandler_pushed  BOOLEAN DEFAULT FALSE,
    filehandler_pushed_at TIMESTAMPTZ,

    received_at         TIMESTAMPTZ DEFAULT NOW(),
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_claim_id ON documents(claim_id);
CREATE INDEX IF NOT EXISTS idx_documents_type     ON documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_docs_unread        ON documents(received_at) WHERE ai_read = FALSE;

-- ── rfas ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rfas (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            VARCHAR(60) REFERENCES claims(id) ON DELETE CASCADE,

    -- RFA details
    received_at         TIMESTAMPTZ NOT NULL,
    received_via        VARCHAR(30),               -- 'fax' | 'portal' | 'dxf' | 'mail'
    requesting_physician VARCHAR(200),
    requesting_npi      VARCHAR(20),

    -- What is being requested
    treatment_description TEXT NOT NULL,
    cpt_codes           VARCHAR(20)[],
    icd10_codes         VARCHAR(10)[],
    urgency             VARCHAR(20) DEFAULT 'standard', -- 'standard' | 'expedited'

    -- Deadlines (calculated on receipt)
    response_due_at     TIMESTAMPTZ NOT NULL,

    -- Decision
    decision            VARCHAR(30),
                        -- 'auto_approved' | 'adjuster_approved' | 'sent_to_uro' |
                        -- 'uro_approved' | 'uro_modified' | 'uro_denied' | 'deferred'
    decision_made_at    TIMESTAMPTZ,
    decision_made_by    VARCHAR(50),               -- 'ai_system' | user_id | 'enlyte'

    -- URO tracking
    enlyte_referral_id  VARCHAR(50),
    enlyte_sent_at      TIMESTAMPTZ,
    enlyte_determination VARCHAR(20),
    enlyte_physician    VARCHAR(200),
    enlyte_rationale    TEXT,

    -- Notices
    imr_rights_notice_required BOOLEAN DEFAULT FALSE,
    imr_rights_notice_sent     BOOLEAN DEFAULT FALSE,

    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rfas_claim_id ON rfas(claim_id);
CREATE INDEX IF NOT EXISTS idx_rfas_decision ON rfas(decision);
CREATE INDEX IF NOT EXISTS idx_rfas_deadline ON rfas(response_due_at) WHERE decision IS NULL;
CREATE INDEX IF NOT EXISTS idx_rfas_open_deadline ON rfas(response_due_at) WHERE decision IS NULL;

-- ── rfa_evaluations ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rfa_evaluations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rfa_id              UUID REFERENCES rfas(id) ON DELETE CASCADE,

    -- AI evaluation
    mtus_consistent         BOOLEAN,
    mtus_guideline_cited    VARCHAR(200),
    within_frequency_limits BOOLEAN,
    within_duration_limits  BOOLEAN,
    first_30_days           BOOLEAN,
    surgical                BOOLEAN DEFAULT FALSE,
    formulary_status        VARCHAR(20),           -- 'exempt' | 'non_exempt' | 'special_fill' | 'n_a'

    -- AI recommendation
    recommendation      VARCHAR(30) NOT NULL,      -- 'auto_approve' | 'adjuster_review' | 'route_to_uro' | 'defer'
    confidence          SMALLINT,                  -- 0-100
    rationale           TEXT,

    -- Human override
    overridden          BOOLEAN DEFAULT FALSE,
    override_by         UUID REFERENCES users(id),
    override_reason     TEXT,

    evaluated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── reserves ─────────────────────────────────────────────────────────────────
-- FileHandler is authoritative. This mirrors it for fast querying.
-- source/approved_by use VARCHAR to match backend inserts.
CREATE TABLE IF NOT EXISTS reserves (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            VARCHAR(60) REFERENCES claims(id) ON DELETE CASCADE,
    filehandler_reserve_id VARCHAR(50),

    medical             DECIMAL(12,2) NOT NULL DEFAULT 0,
    indemnity           DECIMAL(12,2) NOT NULL DEFAULT 0,
    expense             DECIMAL(12,2) NOT NULL DEFAULT 0,

    reason              TEXT,
    source              VARCHAR(50),               -- 'AI_ENGINE' | 'ADJUSTER' | 'system'
    approved_by         VARCHAR(200),              -- adjuster email or 'ai_system'

    filehandler_synced  BOOLEAN DEFAULT FALSE,
    filehandler_synced_at TIMESTAMPTZ,

    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reserves_claim_id ON reserves(claim_id);

-- ── diaries ───────────────────────────────────────────────────────────────────
-- Diary state. FileHandler is authoritative.
-- due_date/fh_diary_id/assigned_to match backend inserts.
CREATE TABLE IF NOT EXISTS diaries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id    VARCHAR(60) REFERENCES claims(id) ON DELETE CASCADE,
    fh_diary_id VARCHAR(50),                       -- FileHandler diary ID after sync

    diary_type  VARCHAR(100) NOT NULL,
                -- 'DWC1_NOTICE' | 'TD_PAYMENT_SETUP' | 'PR2_FOLLOW_UP' |
                -- 'DWC7_NOTICE' | 'COMPENSABILITY_DECISION_DUE' | 'DELAY_NOTICE_DUE' |
                -- 'NEXT_APPOINTMENT' | 'RESERVE_REVIEW' | 'EMPLOYER_CONTACT' | 'CUSTOM'

    due_date    DATE,
    priority    VARCHAR(20),                       -- 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
    assigned_to VARCHAR(200),                      -- email address or system identifier
    notes       TEXT,

    status      VARCHAR(20) DEFAULT 'open',        -- 'open' | 'completed' | 'escalated' | 'cancelled'
    completed_at TIMESTAMPTZ,
    completed_by VARCHAR(200),
    resolution_notes TEXT,

    auto_generated    BOOLEAN DEFAULT TRUE,
    generated_by_event VARCHAR(100),

    -- Escalation tracking
    warning_sent_at   TIMESTAMPTZ,
    escalated_at      TIMESTAMPTZ,

    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_diaries_claim_id    ON diaries(claim_id);
CREATE INDEX IF NOT EXISTS idx_diaries_due_date    ON diaries(due_date);
CREATE INDEX IF NOT EXISTS idx_diaries_status      ON diaries(status);
CREATE INDEX IF NOT EXISTS idx_diaries_status_due  ON diaries(status, due_date) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_diaries_priority    ON diaries(priority) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_diaries_open_due    ON diaries(due_date, priority) WHERE status = 'open';

-- ── ai_decisions ──────────────────────────────────────────────────────────────
-- Every Claude analysis logged. Never delete. Training data and audit trail.
CREATE TABLE IF NOT EXISTS ai_decisions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            VARCHAR(60) REFERENCES claims(id),
    rfa_id              UUID REFERENCES rfas(id),
    document_id         UUID REFERENCES documents(id),

    decision_type       VARCHAR(50) NOT NULL,
                        -- 'compensability_analysis' | 'reserve_recommendation' |
                        -- 'rfa_evaluation' | 'document_summary' |
                        -- 'diary_generation' | 'notice_draft'

    -- Full input/output for audit and future training
    model_used          VARCHAR(100),              -- e.g. 'claude-sonnet-4-6'
    system_prompt_hash  VARCHAR(64),               -- SHA256 of system prompt
    input_snapshot      JSONB NOT NULL,            -- claim state at time of analysis
    output_raw          TEXT NOT NULL,             -- raw model response
    output_parsed       JSONB,                     -- parsed JSON output

    -- Key outputs
    confidence          SMALLINT,
    recommendation      VARCHAR(50),

    -- Human review
    reviewed_by         UUID REFERENCES users(id),
    review_action       VARCHAR(30),               -- 'approved' | 'modified' | 'rejected'
    review_notes        TEXT,
    reviewed_at         TIMESTAMPTZ,

    -- Token usage (cost tracking)
    input_tokens        INTEGER,
    output_tokens       INTEGER,

    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_decisions_claim_id   ON ai_decisions(claim_id);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_type       ON ai_decisions(decision_type);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_unreviewed ON ai_decisions(created_at) WHERE reviewed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ai_unreviewed           ON ai_decisions(created_at) WHERE reviewed_at IS NULL;

-- ── notices ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            VARCHAR(60) REFERENCES claims(id) ON DELETE CASCADE,

    notice_type         VARCHAR(50) NOT NULL,
                        -- 'dwc7' | 'td_benefit' | 'delay' | 'denial' | 'rtw' | 'dwc9' | 'imr_rights'
    statutory_deadline  TIMESTAMPTZ,

    -- Recipient
    recipient_name      VARCHAR(200),
    recipient_address   TEXT,

    -- Generation
    generated_at        TIMESTAMPTZ,
    pdf_storage_path    VARCHAR(500),

    -- Lob mailing
    lob_letter_id       VARCHAR(50),
    lob_sent_at         TIMESTAMPTZ,
    lob_expected_delivery DATE,
    lob_delivered_at    TIMESTAMPTZ,
    lob_status          VARCHAR(30),               -- 'queued' | 'printing' | 'in_transit' | 'delivered'

    -- FileHandler
    filehandler_doc_id  VARCHAR(50),
    filehandler_pushed  BOOLEAN DEFAULT FALSE,

    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── providers (MPN directory cache) ──────────────────────────────────────────
-- id is VARCHAR(20) to match PROVIDERS_SEED keys ('prov_001', etc.)
CREATE TABLE IF NOT EXISTS providers (
    id                  VARCHAR(20) PRIMARY KEY,   -- e.g. 'prov_001'
    npi                 VARCHAR(20),
    name                VARCHAR(200) NOT NULL,
    practice_name       VARCHAR(200),
    specialty           VARCHAR(100),
    address_line1       VARCHAR(200),
    city                VARCHAR(100),
    state               CHAR(2) DEFAULT 'CA',
    zip                 VARCHAR(10),
    phone               VARCHAR(20),
    fax                 VARCHAR(20),
    email               VARCHAR(200),

    mpn_tier            SMALLINT DEFAULT 2,        -- 1=preferred, 2=standard, 3=fallback
    walk_in             BOOLEAN DEFAULT FALSE,
    accepts_wc          BOOLEAN DEFAULT TRUE,
    accepting_new_wc    BOOLEAN DEFAULT TRUE,

    -- EHR integration
    ehr_system          VARCHAR(50),               -- 'epic' | 'cerner' | 'concentra' | 'none'
    ehr_integrated      BOOLEAN DEFAULT FALSE,
    dxf_participant     BOOLEAN DEFAULT FALSE,

    -- Quality
    rating              DECIMAL(3,1),
    review_count        INTEGER DEFAULT 0,

    -- Operating info (not in spec — used by backend)
    hours               VARCHAR(200),
    languages           JSONB DEFAULT '[]',

    -- Zip codes served
    zip_prefixes_served VARCHAR(3)[],

    active              BOOLEAN DEFAULT TRUE,
    last_verified_at    TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_providers_specialty ON providers(specialty);
CREATE INDEX IF NOT EXISTS idx_providers_tier      ON providers(mpn_tier) WHERE active = TRUE;

-- ── magic_link_tokens ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS magic_link_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    jti             VARCHAR(200) UNIQUE NOT NULL,  -- JWT ID claim — one row per issued link
    claim_id        VARCHAR(60) REFERENCES claims(id) ON DELETE CASCADE,
    adp_employee_id VARCHAR(50) NOT NULL,

    -- Validity window
    expires_at      TIMESTAMPTZ NOT NULL,          -- 72 hours after generation
    used_at         TIMESTAMPTZ,                   -- set atomically on first use; NULL = still valid

    -- Provenance
    generated_by    UUID REFERENCES users(id),
    sent_to_email   VARCHAR(200),

    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_magic_link_tokens_jti     ON magic_link_tokens(jti);
CREATE INDEX        IF NOT EXISTS idx_magic_link_tokens_claim   ON magic_link_tokens(claim_id);
CREATE INDEX        IF NOT EXISTS idx_magic_link_tokens_cleanup ON magic_link_tokens(expires_at)
    WHERE used_at IS NULL;

-- ── audit_log ─────────────────────────────────────────────────────────────────
-- Every admin action. Never delete. 7-year retention per CA WC regulations.
CREATE TABLE IF NOT EXISTS audit_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID REFERENCES users(id),
    user_role     VARCHAR(20),

    action        VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),                     -- 'claim' | 'rfa' | 'diary' | 'reserve' | etc.
    resource_id   VARCHAR(50),

    description   TEXT,
    old_value     JSONB,
    new_value     JSONB,

    ip_address    INET,
    user_agent    TEXT,

    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user     ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created  ON audit_log(created_at);

-- ── appointments ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            VARCHAR(60) REFERENCES claims(id) ON DELETE CASCADE,
    provider_id         VARCHAR(50),               -- references providers(id) or external ID

    -- Scheduling (db.js uses appointment_date + appointment_time)
    appointment_date    DATE,
    appointment_time    VARCHAR(20),
    visit_type          VARCHAR(50),               -- 'initial_eval' | 'follow_up' | 'specialist'

    -- Confirmation
    confirmation_number VARCHAR(100),
    authorization_sent_at TIMESTAMPTZ,

    -- Status
    status              VARCHAR(20) DEFAULT 'scheduled',
                        -- 'scheduled' | 'confirmed' | 'completed' | 'cancelled'
    notes               TEXT,

    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointments_claim_id ON appointments(claim_id);
