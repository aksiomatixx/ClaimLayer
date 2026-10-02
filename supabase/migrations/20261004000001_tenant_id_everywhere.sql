-- ============================================================
-- 20261004000001_tenant_id_everywhere.sql
-- Multi-tenancy propagation: add tenant_id to every claim-scoped and
-- reference table, backfill it from the parent claim, and add a
-- RESTRICTIVE tenant-isolation policy to every table that carries it.
--
-- Revised before first application (the original could not apply: it
-- skipped msa_screenings, backfilled through views and immutable tables,
-- updated the append-only claim_events, and widened app.current_tenant_id()
-- to fall back to the default tenant). Nothing here weakens an existing
-- policy: RESTRICTIVE policies only ever narrow what a permissive policy
-- grants, and the service-role / owner connections bypass RLS.
--
-- Idempotent: safe to re-apply.
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ============================================================
BEGIN;

-- ── 1. app.current_tenant_id(): the caller's tenant, never a fallback ──────
-- A signed-in user resolves to their own users row. Only a connection with no
-- JWT subject (the backend's own transactional connection, which sets
-- app.tenant_id with SET LOCAL) may name its tenant through the setting.
-- No match → NULL → no row passes a tenant policy.
CREATE OR REPLACE FUNCTION app.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN auth.uid() IS NOT NULL
            THEN (SELECT tenant_id FROM public.users WHERE id = auth.uid())
        ELSE nullif(current_setting('app.tenant_id', true), '')::uuid
    END;
$$;

GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO authenticated, anon, service_role;

-- ── 2. Add tenant_id where it is missing ────────────────────────────────────
-- The default keeps today's single-tenant writers working (claims has the same
-- default); explicit tenant stamping on every write is increment 2b.
CREATE TEMP TABLE _tenant_tables (name text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _tenant_tables VALUES
    ('employers'), ('employees'), ('policies'), ('insurers'),
    ('claim_events'), ('diaries'), ('reserves'), ('reserve_line_items'),
    ('claim_documents'), ('documents'), ('td_periods'), ('rfas'),
    ('rfa_evaluations'), ('qme_panels'), ('pd_evaluations'), ('pd_advances'),
    ('pd_advance_payments'), ('settlement_offers'), ('stipulations'),
    ('award_disbursements'), ('benefit_notices'), ('benefit_notice_channels'),
    ('notices'), ('wcis_trigger_queue'), ('wcis_transactions'),
    ('wcis_claim_state'), ('wcis_transmissions'), ('integration_outbox'),
    ('claim_links'), ('supervisor_alerts'), ('appointments'), ('providers'),
    ('ai_decisions'), ('pr4_solicitations'), ('mmi_evaluations'),
    ('msa_screenings'), ('supplemental_requests'), ('magic_link_tokens'),
    ('deferred_penalty_flags'), ('legacy_claims'), ('legacy_updates'),
    ('legacy_diaries'), ('legacy_documents'), ('pdrs_lookup');

DO $$
DECLARE
    tbl text;
BEGIN
    FOR tbl IN
        SELECT t.name FROM _tenant_tables t
        JOIN information_schema.tables i
          ON i.table_schema = 'public' AND i.table_name = t.name AND i.table_type = 'BASE TABLE'
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = tbl AND column_name = 'tenant_id'
        ) THEN
            EXECUTE format(
                'ALTER TABLE %I ADD COLUMN tenant_id UUID NOT NULL
                   DEFAULT ''00000000-0000-0000-0000-000000000001''::uuid
                   REFERENCES tenants(id)', tbl);
        END IF;
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)', 'idx_' || tbl || '_tenant_id', tbl);
    END LOOP;
END;
$$;

-- ── 3. Backfill tenant_id from the parent claim ─────────────────────────────
-- Only the tables this migration stamped, and only rows that disagree.
DO $$
DECLARE
    tbl text;
BEGIN
    FOR tbl IN
        SELECT t.name FROM _tenant_tables t
        WHERE t.name <> 'claim_events'
          AND EXISTS (SELECT 1 FROM information_schema.columns c
                       WHERE c.table_schema = 'public' AND c.table_name = t.name
                         AND c.column_name = 'claim_id')
          AND EXISTS (SELECT 1 FROM information_schema.tables i
                       WHERE i.table_schema = 'public' AND i.table_name = t.name
                         AND i.table_type = 'BASE TABLE')
    LOOP
        EXECUTE format(
            'UPDATE %I t SET tenant_id = c.tenant_id
               FROM claims c
              WHERE t.claim_id = c.id AND t.tenant_id IS DISTINCT FROM c.tenant_id', tbl);
    END LOOP;
END;
$$;

-- claim_events is append-only (20261003000001). Stamping the new column is a
-- one-time schema backfill, not a history edit: only when a claim lives
-- outside the default tenant, under this transaction's ACCESS EXCLUSIVE lock,
-- with the UPDATE trigger re-enabled before commit.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM claim_events e JOIN claims c ON c.id = e.claim_id
                WHERE e.tenant_id IS DISTINCT FROM c.tenant_id) THEN
        ALTER TABLE claim_events DISABLE TRIGGER claim_events_no_update;
        UPDATE claim_events e SET tenant_id = c.tenant_id
          FROM claims c
         WHERE e.claim_id = c.id AND e.tenant_id IS DISTINCT FROM c.tenant_id;
        ALTER TABLE claim_events ENABLE TRIGGER claim_events_no_update;
    END IF;
END;
$$;

-- ── 4. RESTRICTIVE tenant isolation on every tenant-scoped base table ──────
-- AND-ed with the existing permissive role policies; RLS is already enabled
-- on every public table (20261001000001), and is (re)enabled here so a new
-- policy can never be inert.
DO $$
DECLARE
    tbl text;
BEGIN
    FOR tbl IN
        SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables i
          ON i.table_schema = c.table_schema AND i.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND c.column_name = 'tenant_id'
          AND i.table_type = 'BASE TABLE'
          AND c.table_name <> 'tenants'
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_tenant_isolation', tbl);
        EXECUTE format(
            'CREATE POLICY %I ON %I
                AS RESTRICTIVE
                FOR ALL
                TO authenticated
                USING (tenant_id = app.current_tenant_id())
                WITH CHECK (tenant_id = app.current_tenant_id())',
            tbl || '_tenant_isolation', tbl);
    END LOOP;
END;
$$;

COMMIT;
