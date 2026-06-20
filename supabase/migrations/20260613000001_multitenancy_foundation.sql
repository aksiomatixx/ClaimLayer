-- ============================================================
-- Multi-tenancy foundation — productization spike, increment 1
--
-- Pooled multi-tenancy: a `tenant` (a customer account — one TPA or
-- self-insured claims operation) sits ABOVE `employer`. Every business
-- row is scoped by `tenant_id`, and tenant isolation is enforced by
-- Row-Level Security keyed to the authenticated user's OWN tenant.
--
-- This increment establishes the model on the users + claims slice and
-- proves isolation (see backend/scripts/migration-contract-test.js). It
-- is intentionally backward-compatible:
--   - a well-known default tenant backfills existing rows and is the
--     column DEFAULT, so the single-tenant demo + service-role app
--     paths (which bypass RLS) are unaffected; and
--   - isolation is enforced as a RESTRICTIVE policy that ANDs on top of
--     the existing role policies — it narrows, never widens, access.
--
-- Later increments: adopt Supabase Auth for staff sessions (so
-- auth.uid() is real), then route tenant-scoped reads off the
-- service-role client through RLS, then propagate tenant_id to the
-- remaining tables.
-- ============================================================

-- ── app schema for SECURITY DEFINER helpers ─────────────────────────────────
CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO authenticated, anon, service_role;

-- ── tenants ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(200) NOT NULL,
    slug        VARCHAR(100) UNIQUE NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'closed')),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Well-known default tenant: backfills pre-multitenancy rows and is the
-- column default, so existing single-tenant data and code keep working.
INSERT INTO tenants (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'ClaimLayer Demo', 'default')
ON CONFLICT (id) DO NOTHING;

-- ── tenant_id on users + claims ──────────────────────────────────────────────
-- NOT NULL with a DEFAULT backfills existing rows to the default tenant in a
-- single metadata-only operation; the inline FK validates against tenants.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL
        DEFAULT '00000000-0000-0000-0000-000000000001'
        REFERENCES tenants(id);

ALTER TABLE claims
    ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL
        DEFAULT '00000000-0000-0000-0000-000000000001'
        REFERENCES tenants(id);

CREATE INDEX IF NOT EXISTS idx_users_tenant  ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_claims_tenant ON claims(tenant_id);

-- ── tenant resolver ──────────────────────────────────────────────────────────
-- Derives the caller's tenant from their own users row. SECURITY DEFINER so
-- it can read users without tripping users' RLS (avoids policy recursion).
-- Returns NULL when there is no authenticated user, which makes the RESTRICTIVE
-- policies below deny by default (fail closed).
CREATE OR REPLACE FUNCTION app.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT tenant_id FROM public.users WHERE id = auth.uid()
$$;

GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO authenticated, anon, service_role;

-- ── tenant-isolation policies (RESTRICTIVE: AND-ed with role policies) ───────
-- RLS is already enabled on claims + users (see 20260101000003_enable_rls.sql).
-- A RESTRICTIVE policy combines with AND, so a row is visible only if a
-- permissive role policy grants it AND it belongs to the caller's tenant.
-- The service-role/owner connection bypasses RLS entirely, so this only
-- governs direct authenticated access — defense-in-depth for tenant data.
DROP POLICY IF EXISTS claims_tenant_isolation ON claims;
CREATE POLICY claims_tenant_isolation ON claims
    AS RESTRICTIVE
    FOR ALL
    TO authenticated
    USING      (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS users_tenant_isolation ON users;
CREATE POLICY users_tenant_isolation ON users
    AS RESTRICTIVE
    FOR ALL
    TO authenticated
    USING      (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());
