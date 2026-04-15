-- ============================================================
-- M5 — Missing Tables (v1.0)
-- HomeCare TPA — California WC Claims Administration
--
-- These five tables exist in docs/data-model.md but were absent
-- from migration 20260101000001_initial_schema.sql.
--
-- Dependency order:
--   1. rfas            (references claims)
--   2. rfa_evaluations (references rfas, users)
--   3. ai_decisions    (references claims, rfas, documents, users)
--   4. notices         (references claims)
--   5. audit_log       (references users)
--
-- NOTE: claim_id columns use VARCHAR(60) to match the actual
-- claims.id column type in the database (the data-model.md spec
-- shows VARCHAR(20), but the initial migration uses VARCHAR(60)
-- for the backend's 'claim_<timestamp>_<random>' ID format).
-- ============================================================

-- ── rfas ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rfas (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            VARCHAR(60) REFERENCES claims(id),

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
    imr_rights_notice_sent     BOOLEAN DEFAULT FALSE,

    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rfas_claim_id ON rfas(claim_id);
CREATE INDEX IF NOT EXISTS idx_rfas_decision ON rfas(decision);
-- Index for finding RFAs approaching deadline
CREATE INDEX IF NOT EXISTS idx_rfas_deadline ON rfas(response_due_at) WHERE decision IS NULL;

-- ── rfa_evaluations ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rfa_evaluations (
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

-- ── ai_decisions ──────────────────────────────────────────────────────────────
-- Every Claude analysis logged. This is the training data and the audit trail.
-- Never delete rows from this table.
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

CREATE INDEX IF NOT EXISTS idx_ai_decisions_claim_id   ON ai_decisions(claim_id);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_type       ON ai_decisions(decision_type);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_unreviewed ON ai_decisions(created_at) WHERE reviewed_at IS NULL;

-- ── notices ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            VARCHAR(60) REFERENCES claims(id),

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

-- ── audit_log ─────────────────────────────────────────────────────────────────
-- Every admin action. Never delete. 7-year retention per CA WC regulations.
CREATE TABLE IF NOT EXISTS audit_log (
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

CREATE INDEX IF NOT EXISTS idx_audit_log_user     ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created  ON audit_log(created_at);

-- ── Enable RLS on new tables ──────────────────────────────────────────────────
ALTER TABLE rfas             ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfa_evaluations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_decisions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE notices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log        ENABLE ROW LEVEL SECURITY;

-- ── RLS policies for new tables ───────────────────────────────────────────────

-- rfas: admin/adjuster all-access; employers read their own via claim FK
CREATE POLICY rfas_admin_all ON rfas
    FOR ALL TO authenticated
    USING (
        EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('admin', 'adjuster'))
    );

CREATE POLICY rfas_employer_own ON rfas
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM claims c JOIN users u ON u.id = auth.uid()
            WHERE c.id = rfas.claim_id
              AND u.role = 'employer'
              AND c.employer_id = u.employer_id::TEXT
        )
    );

-- rfa_evaluations: admin/adjuster only
CREATE POLICY rfa_evaluations_admin_all ON rfa_evaluations
    FOR ALL TO authenticated
    USING (
        EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('admin', 'adjuster'))
    );

-- ai_decisions: admin/adjuster only (raw AI I/O is not exposed to employers)
CREATE POLICY ai_decisions_admin_all ON ai_decisions
    FOR ALL TO authenticated
    USING (
        EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('admin', 'adjuster'))
    );

-- notices: admin/adjuster all-access; employers read their own via claim FK
CREATE POLICY notices_admin_all ON notices
    FOR ALL TO authenticated
    USING (
        EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('admin', 'adjuster'))
    );

CREATE POLICY notices_employer_own ON notices
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM claims c JOIN users u ON u.id = auth.uid()
            WHERE c.id = notices.claim_id
              AND u.role = 'employer'
              AND c.employer_id = u.employer_id::TEXT
        )
    );

-- audit_log: admin read only; no employer or employee access
CREATE POLICY audit_log_admin_only ON audit_log
    FOR ALL TO authenticated
    USING (
        (SELECT role FROM users WHERE id = auth.uid()) = 'admin'
    );
