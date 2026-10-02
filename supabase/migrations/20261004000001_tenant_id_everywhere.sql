-- ============================================================
-- 20261004000001_tenant_id_everywhere.sql
-- Multi-tenancy propagation: add tenant_id to all public tables,
-- backfill from parent claims, and enforce tenant isolation.
-- ============================================================

-- ── 1. Update app.current_tenant_id() to support app.tenant_id setting ─────
CREATE OR REPLACE FUNCTION app.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT coalesce(
        nullif(current_setting('app.tenant_id', true), '')::uuid,
        (SELECT tenant_id FROM public.users WHERE id = auth.uid()),
        '00000000-0000-0000-0000-000000000001'::uuid
    );
$$;

GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO authenticated, anon, service_role;

-- ── 2. Add tenant_id to all tables that do not have it ───────────────────────
DO $$
DECLARE
    tbl text;
    tables text[] := ARRAY[
        'employers',
        'employees',
        'policies',
        'insurers',
        'claim_events',
        'diaries',
        'reserves',
        'reserve_line_items',
        'claim_documents',
        'documents',
        'td_periods',
        'rfas',
        'rfa_evaluations',
        'qme_panels',
        'pd_evaluations',
        'pd_advances',
        'pd_advance_payments',
        'settlement_offers',
        'stipulations',
        'award_disbursements',
        'benefit_notices',
        'benefit_notice_channels',
        'notices',
        'wcis_trigger_queue',
        'wcis_transactions',
        'wcis_claim_state',
        'integration_outbox',
        'claim_links',
        'supervisor_alerts',
        'appointments',
        'providers',
        'ai_decisions',
        'pr4_solicitations',
        'mmi_evaluations',
        'supplemental_requests',
        'magic_link_tokens',
        'deferred_penalty_flags',
        'legacy_claims',
        'legacy_updates',
        'legacy_diaries',
        'legacy_documents',
        'pdrs_lookup'
    ];
BEGIN
    FOREACH tbl IN ARRAY tables LOOP
        IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = tbl
        ) THEN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = tbl AND column_name = 'tenant_id'
            ) THEN
                EXECUTE format('
                    ALTER TABLE %I
                    ADD COLUMN tenant_id UUID NOT NULL
                    DEFAULT ''00000000-0000-0000-0000-000000000001''::uuid
                    REFERENCES tenants(id);
                ', tbl);
                EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_tenant_id ON %I(tenant_id);', tbl, tbl);
            END IF;
        END IF;
    END LOOP;
END;
$$;

-- ── 3. Backfill tenant_id from parent claims for claim-bound tables ─────────
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT table_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'claim_id'
          AND table_name NOT IN ('claims', 'claim_events')
    LOOP
        EXECUTE format('
            UPDATE %I t
            SET tenant_id = c.tenant_id
            FROM claims c
            WHERE t.claim_id = c.id
              AND t.tenant_id <> c.tenant_id;
        ', r.table_name);
    END LOOP;
END;
$$;

-- ── 4. Apply RESTRICTIVE tenant-isolation policies on all public tables ──────
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT table_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'tenant_id'
          AND table_name <> 'tenants'
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', r.table_name, r.table_name);
        EXECUTE format('
            CREATE POLICY %I_tenant_isolation ON %I
                AS RESTRICTIVE
                FOR ALL
                TO authenticated
                USING (tenant_id = app.current_tenant_id())
                WITH CHECK (tenant_id = app.current_tenant_id());
        ', r.table_name, r.table_name);
    END LOOP;
END;
$$;
