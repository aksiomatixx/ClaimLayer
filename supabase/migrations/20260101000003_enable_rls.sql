-- ============================================================
-- M5 — Enable Row-Level Security (RLS) (v1.2)
--
-- Policy design:
--   - Service role key bypasses all RLS (used by the backend for all writes).
--   - Anon / authenticated roles are locked down by default.
--   - Employers can only see their own claims.
--   - Admins/adjusters see all claims.
--   - New tables (rfas, ai_decisions, notices, audit_log) follow same pattern.
-- ============================================================

-- ── Enable RLS on all sensitive tables ───────────────────────────────────────
ALTER TABLE claims              ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE diaries             ENABLE ROW LEVEL SECURITY;
ALTER TABLE reserves            ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees           ENABLE ROW LEVEL SECURITY;
ALTER TABLE magic_link_tokens   ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfas                ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfa_evaluations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_decisions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE notices             ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE providers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE employers           ENABLE ROW LEVEL SECURITY;

-- The service-role key bypasses RLS entirely — these policies protect
-- direct browser / Supabase Studio access only.

-- ── claims ───────────────────────────────────────────────────────────────────
-- Admins and adjusters see all claims.
CREATE POLICY claims_admin_all ON claims
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM users u
            WHERE u.id = auth.uid()
              AND u.role IN ('admin', 'adjuster')
        )
    );

-- Employers see only their own employer's claims.
CREATE POLICY claims_employer_own ON claims
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM users u
            WHERE u.id = auth.uid()
              AND u.role = 'employer'
              AND claims.employer_id = u.employer_id::TEXT
        )
    );

-- Employees see only their own claim (via magic link session).
CREATE POLICY claims_employee_own ON claims
    FOR SELECT
    TO authenticated
    USING (
        employee_id = (SELECT id FROM employees WHERE id = auth.uid())
        OR
        (SELECT role FROM users WHERE id = auth.uid()) = 'admin'
    );

-- ── claim_events ─────────────────────────────────────────────────────────────
-- Same scope as claims — inherit via claim_id FK.
CREATE POLICY claim_events_admin_all ON claim_events
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM users u
            WHERE u.id = auth.uid()
              AND u.role IN ('admin', 'adjuster')
        )
    );

CREATE POLICY claim_events_employer_own ON claim_events
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM claims c
            JOIN users u ON u.id = auth.uid()
            WHERE c.id = claim_events.claim_id
              AND u.role = 'employer'
              AND c.employer_id = u.employer_id::TEXT
        )
    );

-- ── diaries, reserves, documents, appointments ───────────────────────────────
-- Admin/adjuster all-access; employer read via claim FK.
CREATE POLICY diaries_admin_all ON diaries
    FOR ALL TO authenticated
    USING (
        EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('admin', 'adjuster'))
    );

CREATE POLICY diaries_employer_own ON diaries
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM claims c JOIN users u ON u.id = auth.uid()
            WHERE c.id = diaries.claim_id AND u.role = 'employer'
              AND c.employer_id = u.employer_id::TEXT
        )
    );

CREATE POLICY reserves_admin_all ON reserves
    FOR ALL TO authenticated
    USING (
        EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('admin', 'adjuster'))
    );

CREATE POLICY documents_admin_all ON documents
    FOR ALL TO authenticated
    USING (
        EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('admin', 'adjuster'))
    );

CREATE POLICY documents_employer_own ON documents
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM claims c JOIN users u ON u.id = auth.uid()
            WHERE c.id = documents.claim_id AND u.role = 'employer'
              AND c.employer_id = u.employer_id::TEXT
        )
    );

CREATE POLICY appointments_admin_all ON appointments
    FOR ALL TO authenticated
    USING (
        EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('admin', 'adjuster'))
    );

-- ── rfas ──────────────────────────────────────────────────────────────────────
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
            WHERE c.id = rfas.claim_id AND u.role = 'employer'
              AND c.employer_id = u.employer_id::TEXT
        )
    );

-- ── rfa_evaluations ───────────────────────────────────────────────────────────
CREATE POLICY rfa_evaluations_admin_all ON rfa_evaluations
    FOR ALL TO authenticated
    USING (
        EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('admin', 'adjuster'))
    );

-- ── ai_decisions ──────────────────────────────────────────────────────────────
-- Admin/adjuster read; no employer or employee access to raw AI decisions.
CREATE POLICY ai_decisions_admin_all ON ai_decisions
    FOR ALL TO authenticated
    USING (
        EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('admin', 'adjuster'))
    );

-- ── notices ───────────────────────────────────────────────────────────────────
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
            WHERE c.id = notices.claim_id AND u.role = 'employer'
              AND c.employer_id = u.employer_id::TEXT
        )
    );

-- ── audit_log ─────────────────────────────────────────────────────────────────
-- Admin read only. Never write via RLS — only via service role.
CREATE POLICY audit_log_admin_only ON audit_log
    FOR ALL TO authenticated
    USING (
        EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role = 'admin')
    );

-- ── employees ─────────────────────────────────────────────────────────────────
-- Admins/adjusters all-access; employers see only their employees.
CREATE POLICY employees_admin_all ON employees
    FOR ALL TO authenticated
    USING (
        EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('admin', 'adjuster'))
    );

CREATE POLICY employees_employer_own ON employees
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM users u
            WHERE u.id = auth.uid()
              AND u.role = 'employer'
              AND employees.employer_id = u.employer_id
        )
    );

-- ── providers ─────────────────────────────────────────────────────────────────
-- MPN directory is readable by all authenticated users.
CREATE POLICY providers_authenticated_read ON providers
    FOR SELECT TO authenticated
    USING (true);

-- ── employers ─────────────────────────────────────────────────────────────────
-- Readable by all authenticated users; write only via service role.
CREATE POLICY employers_authenticated_read ON employers
    FOR SELECT TO authenticated
    USING (true);

-- ── magic_link_tokens ─────────────────────────────────────────────────────────
-- All operations via service role only (backend validates tokens server-side).
-- No direct browser access.
