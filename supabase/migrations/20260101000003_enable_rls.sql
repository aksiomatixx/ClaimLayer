-- ============================================================
-- M5 — Enable Row-Level Security (RLS)
--
-- Policy design:
--   - Service role key bypasses all RLS (used by the backend).
--   - Anon / authenticated roles are locked down by default.
--   - Employers can only see their own claims.
--   - Admins/adjusters see all claims.
-- ============================================================

-- ── Enable RLS on sensitive tables ───────────────────────────────────────────
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims         ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE diaries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE reserves       ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents      ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees      ENABLE ROW LEVEL SECURITY;
ALTER TABLE magic_link_tokens ENABLE ROW LEVEL SECURITY;

-- The service-role key bypasses RLS entirely — these policies protect
-- direct browser / Supabase Studio access only.

-- ── claims RLS ───────────────────────────────────────────────────────────────
-- Admins and adjusters (role = 'admin'|'adjuster') see all claims.
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

-- ── claim_events, diaries, reserves, documents, appointments RLS ─────────────
-- These follow the same pattern as claims — inherit via claim_id FK.
-- For simplicity in M5, we rely on the service-role key for all server ops.
-- Direct browser access to these tables is denied by default (no SELECT policy
-- for anonymous/unauthenticated users).

-- ── employees: employer portal can read their own employees ──────────────────
CREATE POLICY employees_employer_own ON employees
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM users u
            WHERE u.id = auth.uid()
              AND (u.role IN ('admin', 'adjuster')
                OR (u.role = 'employer' AND employees.employer_id = u.employer_id))
        )
    );

-- ── providers: readable by all authenticated users (MPN lookup) ──────────────
ALTER TABLE providers ENABLE ROW LEVEL SECURITY;

CREATE POLICY providers_authenticated_read ON providers
    FOR SELECT
    TO authenticated
    USING (true);

-- ── employers: readable by authenticated users, write via service role ────────
ALTER TABLE employers ENABLE ROW LEVEL SECURITY;

CREATE POLICY employers_authenticated_read ON employers
    FOR SELECT
    TO authenticated
    USING (true);

-- ── magic_link_tokens: no direct browser access ───────────────────────────────
-- All operations via service role only (backend validates tokens).
