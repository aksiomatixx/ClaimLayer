# Data Model

PostgreSQL via Supabase. All tables use UUID primary keys. Row-level security (RLS) enforced at the database layer.

Every claim is a structured data object and a state machine. Financial data mirrors FileHandler (FileHandler is authoritative). Every AI decision is logged. Schema decisions here determine ML capability in year 3 — favor structured fields over free text everywhere.

---

## Schema Overview

```sql
-- Core entities
employers          → Client home health agencies
employees          → Injured workers
claims             → Core claim record (state machine)
claim_events       → Immutable event log

-- Medical management
documents          → All documents (PDFs, clinical records, media)
appointments       → MPN appointments
providers          → MPN provider directory (cached)
rfas               → Requests for authorization
rfa_evaluations    → AI MTUS evaluation per RFA

-- Financial (mirrors FileHandler)
reserves           → Reserve history
payments           → Payment history

-- Automation
diaries            → Diary state (source of truth: FileHandler)
notices            → Generated notices + Lob tracking
ai_decisions       → Every Claude analysis

-- Auth / Admin
users              → System users (employers, admins)
audit_log          → Every admin action
```

---

## Table Definitions

### employers
```sql
CREATE TABLE employers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(200) NOT NULL,
    dba                 VARCHAR(200),
    address_line1       VARCHAR(200),
    address_city        VARCHAR(100),
    address_state       CHAR(2) DEFAULT 'CA',
    address_zip         VARCHAR(10),
    phone               VARCHAR(20),
    primary_contact_name VARCHAR(200),
    primary_contact_email VARCHAR(200),
    primary_contact_phone VARCHAR(20),
    fein                VARCHAR(20),                    -- Federal Employer ID
    ca_employer_account_no VARCHAR(30),                  -- CA EDD account
    adp_company_code    VARCHAR(20),                    -- ADP org identifier
    filehandler_client_id VARCHAR(50),                  -- FileHandler client ID
    mpn_enrolled        BOOLEAN DEFAULT FALSE,
    mpn_id              VARCHAR(50),                    -- MPN enrollment ID
    active              BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);
```

### employees
```sql
CREATE TABLE employees (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employer_id         UUID REFERENCES employers(id),
    adp_associate_oid   VARCHAR(50) UNIQUE,             -- ADP's unique identifier
    
    -- Demographics (pulled from ADP)
    first_name          VARCHAR(100) NOT NULL,
    last_name           VARCHAR(100) NOT NULL,
    dob                 DATE,
    ssn_last4           CHAR(4),                        -- Last 4 only, never full SSN
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
    pay_type            VARCHAR(20),                    -- 'hourly' | 'salary'
    hourly_rate         DECIMAL(10,2),
    avg_hours_per_week  DECIMAL(5,1),
    
    -- Financials (calculated from ADP pay statements)
    aww                 DECIMAL(10,2),                  -- Average Weekly Wage
    td_rate             DECIMAL(10,2),                  -- CA TD rate (2/3 AWW, min/max applied)
    aww_calculated_at   TIMESTAMPTZ,                    -- When AWW was last calculated
    
    adp_data_last_pulled TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);
```

### claims
```sql
CREATE TABLE claims (
    id                  VARCHAR(20) PRIMARY KEY,        -- e.g. HHW-2026-041
    employer_id         UUID REFERENCES employers(id),
    employee_id         UUID REFERENCES employees(id),
    
    -- FileHandler link
    filehandler_claim_id VARCHAR(50) UNIQUE,
    
    -- Injury facts
    date_of_injury      DATE NOT NULL,
    time_of_injury      TIME,
    body_part           VARCHAR(100),
    injury_type         VARCHAR(100),
    mechanism           TEXT,
    voice_transcript    TEXT,
    medical_treatment   TEXT,
    witnesses           TEXT,
    prior_claims        TEXT,
    
    -- Work status
    off_work            BOOLEAN DEFAULT FALSE,
    off_work_start      DATE,
    off_work_end        DATE,                           -- From last PR-2
    rtw_date            DATE,                           -- Actual return to work
    
    -- Financials
    aww                 DECIMAL(10,2),
    td_rate             DECIMAL(10,2),
    
    -- Status (state machine)
    status              VARCHAR(50) NOT NULL DEFAULT 'new_claim',
                        -- new_claim | intake_complete | under_investigation |
                        -- accepted | active_medical | p_and_s | pd_evaluation |
                        -- settlement_discussions | closed | denied | litigated
    
    -- Compensability
    compensability_decision VARCHAR(30),               -- 'accepted' | 'denied' | 'pending'
    compensability_decided_at TIMESTAMPTZ,
    compensability_decided_by VARCHAR(200),
    denial_reason       TEXT,
    
    -- AI analysis
    ai_compensability   VARCHAR(30),                   -- 'Likely Compensable' | 'Questionable' | 'Likely Non-Compensable'
    ai_confidence       SMALLINT,                      -- 0-100
    ai_priority         VARCHAR(20),                   -- 'Critical' | 'High' | 'Medium' | 'Low'
    ai_analyzed_at      TIMESTAMPTZ,
    
    -- Reserves (current — history in reserves table)
    reserve_medical     DECIMAL(12,2) DEFAULT 0,
    reserve_indemnity   DECIMAL(12,2) DEFAULT 0,
    reserve_expense     DECIMAL(12,2) DEFAULT 0,
    
    -- DxF
    dxf_roster_enrolled BOOLEAN DEFAULT FALSE,
    dxf_enrolled_at     TIMESTAMPTZ,
    
    -- Admin
    filed_by            VARCHAR(20),                   -- 'employer' | 'employee'
    filed_at            TIMESTAMPTZ DEFAULT NOW(),
    adjuster_id         UUID REFERENCES users(id),
    
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT valid_status CHECK (status IN (
        'new_claim', 'intake_complete', 'under_investigation', 'accepted',
        'active_medical', 'p_and_s', 'pd_evaluation', 'settlement_discussions',
        'closed', 'denied', 'litigated'
    ))
);
```

### claim_events
```sql
-- Immutable. Never update, only insert.
-- Reconstruct full claim history from this table alone.
CREATE TABLE claim_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            VARCHAR(20) REFERENCES claims(id),
    event_type          VARCHAR(100) NOT NULL,
                        -- 'status_change' | 'reserve_update' | 'ai_analysis' |
                        -- 'document_received' | 'appointment_booked' |
                        -- 'rfa_received' | 'rfa_approved' | 'rfa_denied' |
                        -- 'diary_created' | 'diary_completed' | 'notice_sent' |
                        -- 'payment_issued' | 'adjuster_decision' | 'adt_received'
    event_data          JSONB NOT NULL,                -- Structured event payload
    triggered_by        VARCHAR(50),                   -- 'system' | 'adjuster' | 'employer' | 'employee' | 'dxf' | 'ai'
    triggered_by_user   UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ DEFAULT NOW()      -- Never null, never updated
);

CREATE INDEX idx_claim_events_claim_id ON claim_events(claim_id);
CREATE INDEX idx_claim_events_type ON claim_events(event_type);
CREATE INDEX idx_claim_events_created ON claim_events(created_at);
```

### documents
```sql
CREATE TABLE documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            VARCHAR(20) REFERENCES claims(id),
    filehandler_doc_id  VARCHAR(50),                   -- FileHandler's document ID after push
    
    -- Document metadata
    doc_type            VARCHAR(50) NOT NULL,
                        -- 'ai_reasoning_pdf' | 'dwc1' | 'pr2' | 'pr3' |
                        -- 'rfa_form' | 'rfa_auth_letter' | 'mri_report' |
                        -- 'operative_report' | 'lab_result' | 'dwc7' | 'td_notice' |
                        -- 'denial_letter' | 'imr_rights_notice' | 'qme_report' |
                        -- 'photo' | 'video' | 'voice_transcript' | 'other'
    description         VARCHAR(500),
    
    -- Source
    source              VARCHAR(50),                   -- 'employee_upload' | 'dxf' | 'generated' | 'employer_upload'
    source_facility     VARCHAR(200),                  -- If from DxF, which facility
    source_provider_npi VARCHAR(20),
    
    -- Storage
    storage_path        VARCHAR(500),                  -- Supabase Storage path
    file_size_bytes     INTEGER,
    mime_type           VARCHAR(100),
    
    -- AI processing
    ai_read             BOOLEAN DEFAULT FALSE,
    ai_summary          TEXT,                          -- Claude's summary of the document
    ai_key_findings     JSONB,                         -- Structured key findings
    ai_read_at          TIMESTAMPTZ,
    
    -- Clinical document fields (for PR-2 type documents)
    document_date       DATE,
    next_appointment    DATE,
    work_status         VARCHAR(30),                   -- 'full_duty' | 'modified' | 'off_work'
    work_restriction_end DATE,
    contains_rfa        BOOLEAN DEFAULT FALSE,
    
    filehandler_pushed  BOOLEAN DEFAULT FALSE,
    filehandler_pushed_at TIMESTAMPTZ,
    
    received_at         TIMESTAMPTZ DEFAULT NOW(),
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_documents_claim_id ON documents(claim_id);
CREATE INDEX idx_documents_type ON documents(doc_type);
CREATE INDEX idx_documents_ai_read ON documents(ai_read) WHERE ai_read = FALSE;
```

### rfas
```sql
CREATE TABLE rfas (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            VARCHAR(20) REFERENCES claims(id),
    
    -- RFA details
    received_at         TIMESTAMPTZ NOT NULL,           -- Clock starts here
    received_via        VARCHAR(30),                   -- 'fax' | 'portal' | 'dxf' | 'mail'
    requesting_physician VARCHAR(200),
    requesting_npi      VARCHAR(20),
    
    -- What is being requested
    treatment_description TEXT NOT NULL,
    cpt_codes           VARCHAR(20)[],
    icd10_codes         VARCHAR(10)[],
    urgency             VARCHAR(20) DEFAULT 'standard', -- 'standard' | 'expedited'
    
    -- Deadlines (calculated on receipt)
    response_due_at     TIMESTAMPTZ NOT NULL,           -- receipt + 5 business days OR 72 hours
    
    -- Decision
    decision            VARCHAR(30),
                        -- 'auto_approved' | 'adjuster_approved' | 'sent_to_uro' |
                        -- 'uro_approved' | 'uro_modified' | 'uro_denied' | 'deferred'
    decision_made_at    TIMESTAMPTZ,
    decision_made_by    VARCHAR(50),                   -- 'ai_system' | user_id | 'enlyte'
    
    -- URO tracking
    enlyte_referral_id  VARCHAR(50),
    enlyte_sent_at      TIMESTAMPTZ,
    enlyte_determination VARCHAR(20),
    enlyte_physician    VARCHAR(200),
    enlyte_rationale    TEXT,
    
    -- Notices
    imr_rights_notice_required BOOLEAN DEFAULT FALSE,
    imr_rights_notice_sent BOOLEAN DEFAULT FALSE,
    
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_rfas_claim_id ON rfas(claim_id);
CREATE INDEX idx_rfas_decision ON rfas(decision);
-- Index for finding RFAs approaching deadline
CREATE INDEX idx_rfas_deadline ON rfas(response_due_at) WHERE decision IS NULL;
```

### rfa_evaluations
```sql
CREATE TABLE rfa_evaluations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rfa_id              UUID REFERENCES rfas(id),
    
    -- AI evaluation
    mtus_consistent     BOOLEAN,
    mtus_guideline_cited VARCHAR(200),                 -- e.g. "ACOEM Low Back Disorders 4.2.1"
    within_frequency_limits BOOLEAN,
    within_duration_limits  BOOLEAN,
    first_30_days       BOOLEAN,                       -- Qualifies for automatic auth under LC 4610(b)
    surgical            BOOLEAN DEFAULT FALSE,
    formulary_status    VARCHAR(20),                   -- 'exempt' | 'non_exempt' | 'special_fill' | 'n_a'
    
    -- AI recommendation
    recommendation      VARCHAR(30) NOT NULL,          -- 'auto_approve' | 'adjuster_review' | 'route_to_uro' | 'defer'
    confidence          SMALLINT,                      -- 0-100
    rationale           TEXT,
    
    -- Human override
    overridden          BOOLEAN DEFAULT FALSE,
    override_by         UUID REFERENCES users(id),
    override_reason     TEXT,
    
    evaluated_at        TIMESTAMPTZ DEFAULT NOW()
);
```

### reserves
```sql
-- Reserve history. FileHandler is authoritative. This mirrors it for fast querying.
CREATE TABLE reserves (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            VARCHAR(20) REFERENCES claims(id),
    filehandler_reserve_id VARCHAR(50),
    
    medical             DECIMAL(12,2) NOT NULL,
    indemnity           DECIMAL(12,2) NOT NULL,
    expense             DECIMAL(12,2) NOT NULL,
    total               DECIMAL(12,2) GENERATED ALWAYS AS (medical + indemnity + expense) STORED,
    
    reason              TEXT,
    set_by              VARCHAR(50),                   -- 'ai_initial' | 'adjuster' | 'system'
    approved_by         UUID REFERENCES users(id),
    
    filehandler_synced  BOOLEAN DEFAULT FALSE,
    filehandler_synced_at TIMESTAMPTZ,
    
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reserves_claim_id ON reserves(claim_id);
```

### diaries
```sql
-- Diary state. FileHandler is authoritative (diaries live there for audit).
-- This table is a fast-queryable cache of diary state.
CREATE TABLE diaries (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            VARCHAR(20) REFERENCES claims(id),
    filehandler_diary_id VARCHAR(50) UNIQUE,
    
    diary_type          VARCHAR(50) NOT NULL,
                        -- 'pr2_follow_up' | 'work_status_expiry' | 'td_payment_due' |
                        -- 'rfa_response_due' | 'next_appointment' | 'qme_deadline' |
                        -- 'wcab_hearing' | 'mmi_assessment' | 'pd_rating' |
                        -- 'reserve_review' | 'employer_contact' | 'dxf_enrollment' |
                        -- 'imr_rights_expiry' | 'compensability_decision_due' |
                        -- 'td_termination_notice' | 'custom'
    
    due_at              TIMESTAMPTZ NOT NULL,
    priority            VARCHAR(10) DEFAULT 'normal',  -- 'critical' | 'high' | 'normal' | 'low'
    assigned_to         UUID REFERENCES users(id),
    description         TEXT,
    
    status              VARCHAR(20) DEFAULT 'open',    -- 'open' | 'completed' | 'escalated' | 'cancelled'
    completed_at        TIMESTAMPTZ,
    completed_by        VARCHAR(50),                   -- user_id or 'system'
    resolution_notes    TEXT,
    
    auto_generated      BOOLEAN DEFAULT TRUE,
    generated_by_event  VARCHAR(100),                  -- Which event triggered this diary
    
    -- Escalation tracking
    warning_sent_at     TIMESTAMPTZ,                   -- When 48-hour warning was sent
    escalated_at        TIMESTAMPTZ,                   -- When it hit the adjuster action queue
    
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_diaries_claim_id ON diaries(claim_id);
CREATE INDEX idx_diaries_status_due ON diaries(status, due_at) WHERE status = 'open';
CREATE INDEX idx_diaries_priority ON diaries(priority) WHERE status = 'open';
```

### ai_decisions
```sql
-- Every Claude analysis logged. This is the training data and the audit trail.
-- Never delete rows from this table.
CREATE TABLE ai_decisions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            VARCHAR(20) REFERENCES claims(id),
    rfa_id              UUID REFERENCES rfas(id),
    document_id         UUID REFERENCES documents(id),
    
    decision_type       VARCHAR(50) NOT NULL,
                        -- 'compensability_analysis' | 'reserve_recommendation' |
                        -- 'rfa_evaluation' | 'document_summary' |
                        -- 'diary_generation' | 'notice_draft'
    
    -- Full input/output for audit and future training
    model_used          VARCHAR(100),                  -- 'claude-sonnet-4-20250514'
    system_prompt_hash  VARCHAR(64),                   -- SHA256 of system prompt (track prompt versions)
    input_snapshot      JSONB NOT NULL,                -- Claim state at time of analysis
    output_raw          TEXT NOT NULL,                 -- Raw model response
    output_parsed       JSONB,                         -- Parsed JSON output
    
    -- Key outputs
    confidence          SMALLINT,
    recommendation      VARCHAR(50),
    
    -- Human review
    reviewed_by         UUID REFERENCES users(id),
    review_action       VARCHAR(30),                   -- 'approved' | 'modified' | 'rejected'
    review_notes        TEXT,
    reviewed_at         TIMESTAMPTZ,
    
    -- Token usage (for cost tracking)
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ai_decisions_claim_id ON ai_decisions(claim_id);
CREATE INDEX idx_ai_decisions_type ON ai_decisions(decision_type);
CREATE INDEX idx_ai_decisions_unreviewed ON ai_decisions(created_at) WHERE reviewed_at IS NULL;
```

### notices
```sql
CREATE TABLE notices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            VARCHAR(20) REFERENCES claims(id),
    
    notice_type         VARCHAR(50) NOT NULL,
                        -- 'dwc7' | 'td_benefit' | 'delay' | 'denial' | 'rtw' | 'dwc9' | 'imr_rights'
    statutory_deadline  TIMESTAMPTZ,                   -- When this notice is legally required by
    
    -- Recipient
    recipient_name      VARCHAR(200),
    recipient_address   TEXT,
    
    -- Generation
    generated_at        TIMESTAMPTZ,
    pdf_storage_path    VARCHAR(500),
    
    -- Lob
    lob_letter_id       VARCHAR(50),
    lob_sent_at         TIMESTAMPTZ,
    lob_expected_delivery DATE,
    lob_delivered_at    TIMESTAMPTZ,
    lob_status          VARCHAR(30),                   -- 'queued' | 'printing' | 'in_transit' | 'delivered'
    
    -- FileHandler
    filehandler_doc_id  VARCHAR(50),
    filehandler_pushed  BOOLEAN DEFAULT FALSE,
    
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
```

### providers
```sql
-- MPN provider directory. Cached and refreshed weekly. Not authoritative — actual MPN management is external.
CREATE TABLE providers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    npi                 VARCHAR(20) UNIQUE,
    name                VARCHAR(200) NOT NULL,
    practice_name       VARCHAR(200),
    address_line1       VARCHAR(200),
    city                VARCHAR(100),
    state               CHAR(2),
    zip                 VARCHAR(10),
    phone               VARCHAR(20),
    fax                 VARCHAR(20),
    
    specialty           VARCHAR(100),                  -- 'Occupational Medicine' | 'Orthopedic Surgery' | etc.
    accepts_wc          BOOLEAN DEFAULT TRUE,
    mpn_tier            SMALLINT DEFAULT 2,            -- 1 = preferred (integrated EHR), 2 = standard, 3 = fallback
    walk_in             BOOLEAN DEFAULT FALSE,
    
    -- EHR integration
    ehr_system          VARCHAR(50),                   -- 'epic' | 'cerner' | 'athena' | 'eclinicalworks' | 'concentra' | 'other' | 'none'
    ehr_integrated      BOOLEAN DEFAULT FALSE,         -- Can we pull records automatically?
    dxf_participant     BOOLEAN DEFAULT FALSE,         -- Is this provider a DxF signatory?
    
    -- Quality
    rating              DECIMAL(3,1),
    review_count        INTEGER DEFAULT 0,
    
    -- Zip codes served (for proximity matching)
    zip_prefixes_served VARCHAR(3)[],
    
    active              BOOLEAN DEFAULT TRUE,
    last_verified_at    TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_providers_zip ON providers USING GIN(zip_prefixes_served);
CREATE INDEX idx_providers_specialty ON providers(specialty);
CREATE INDEX idx_providers_tier ON providers(mpn_tier) WHERE active = TRUE;
```

### users
```sql
CREATE TABLE users (
    id                  UUID PRIMARY KEY REFERENCES auth.users(id),  -- Supabase auth user
    role                VARCHAR(20) NOT NULL,          -- 'admin' | 'employer' | 'employee'
    employer_id         UUID REFERENCES employers(id), -- Set for employer role
    
    first_name          VARCHAR(100),
    last_name           VARCHAR(100),
    email               VARCHAR(200) UNIQUE,
    phone               VARCHAR(20),
    
    active              BOOLEAN DEFAULT TRUE,
    last_login_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
```

### audit_log
```sql
-- Every admin action. Never delete. 7-year retention per CA WC regulations.
CREATE TABLE audit_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID REFERENCES users(id),
    user_role           VARCHAR(20),
    
    action              VARCHAR(100) NOT NULL,
    resource_type       VARCHAR(50),                   -- 'claim' | 'rfa' | 'diary' | 'reserve' | etc.
    resource_id         VARCHAR(50),
    
    description         TEXT,
    old_value           JSONB,
    new_value           JSONB,
    
    ip_address          INET,
    user_agent          TEXT,
    
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_log_user ON audit_log(user_id);
CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);
```

---

## Row-Level Security Policies

```sql
-- Claims: employers see only their own claims
CREATE POLICY employer_claims_policy ON claims
    FOR ALL TO authenticated
    USING (
        employer_id = (SELECT employer_id FROM users WHERE id = auth.uid())
        OR
        (SELECT role FROM users WHERE id = auth.uid()) = 'admin'
    );

-- Claims: employees see only their own claim
CREATE POLICY employee_claims_policy ON claims
    FOR SELECT TO authenticated
    USING (
        employee_id = (SELECT id FROM employees WHERE id = auth.uid())
        OR
        (SELECT role FROM users WHERE id = auth.uid()) = 'admin'
    );

-- Audit log: admin read only
CREATE POLICY audit_log_admin_only ON audit_log
    FOR ALL TO authenticated
    USING ((SELECT role FROM users WHERE id = auth.uid()) = 'admin');
```

---

## Indexes Summary

Critical indexes for query performance:

```sql
-- Claims lookup
CREATE INDEX idx_claims_employer ON claims(employer_id);
CREATE INDEX idx_claims_status ON claims(status);
CREATE INDEX idx_claims_adjuster ON claims(adjuster_id);
CREATE INDEX idx_claims_doi ON claims(date_of_injury);

-- Diary queue (the worker polls this constantly)
CREATE INDEX idx_diaries_open_due ON diaries(due_at, priority) WHERE status = 'open';

-- AI review queue
CREATE INDEX idx_ai_unreviewed ON ai_decisions(created_at) WHERE reviewed_at IS NULL;

-- RFA deadline monitoring
CREATE INDEX idx_rfas_open_deadline ON rfas(response_due_at) WHERE decision IS NULL;

-- Document processing queue
CREATE INDEX idx_docs_unread ON documents(received_at) WHERE ai_read = FALSE;
```

---

*Schema version 1.0 — April 2026*  
*Changes to this schema must be made via numbered migrations. Never alter production tables directly.*
