-- ════════════════════════════════════════════════════════════════════════════
-- Trust Foundation (Sprint 1) — immutable, hash-chained audit ledger
--
-- One append-only record of every consequential action: who or what
-- (human / agent / system / integration) did what, to which entity, on which
-- claim, with which payload and evidence. See docs/adr/0003-audit-ledger.md.
--
-- Guarantees enforced by the DATABASE, not by application convention:
--   * Append-only: BEFORE UPDATE/DELETE row triggers and a BEFORE TRUNCATE
--     statement trigger raise; UPDATE/DELETE/TRUNCATE privileges are revoked
--     from every API role (service_role keeps SELECT + INSERT only).
--   * Tamper-evident: each row's hash covers its own fields and the previous
--     row's hash, per tenant. The chain (seq, prev_hash, hash, recorded_at)
--     is assigned by a BEFORE INSERT trigger under a per-tenant advisory
--     lock, so concurrent writers cannot fork the chain and callers cannot
--     supply their own hashes or sequence numbers.
--   * Verifiable: app.audit_ledger_verify(tenant) recomputes the chain and
--     reports the first broken link. app.audit_ledger_head(tenant) returns
--     the chain head for external anchoring (WORM storage) — a database
--     superuser can still disable triggers, which only external anchoring
--     can detect.
--   * Durable history: claim_id is deliberately NOT a foreign key, so no
--     claim deletion (and no ON DELETE CASCADE) can remove history.
--
-- Hash input is unambiguous: every field is rendered with quote_nullable()
-- (NULL vs '' are distinct; separators inside values are quoted) and
-- timestamps are rendered in UTC with microseconds, independent of the
-- session TimeZone. jsonb::text is canonical (keys sorted, normalized).
-- Uses only built-ins (sha256, PG 11+; gen_random_uuid, PG 13+) — no
-- extension or search_path dependency.
--
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS audit_ledger (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  seq             BIGINT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type      TEXT NOT NULL
                  CONSTRAINT audit_ledger_actor_type_chk
                  CHECK (actor_type IN ('human', 'agent', 'system', 'integration')),
  actor_id        TEXT,
  actor_role      TEXT,
  action          TEXT NOT NULL
                  CONSTRAINT audit_ledger_action_chk
                  CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  entity_type     TEXT,
  entity_id       TEXT,
  claim_id        TEXT,            -- intentionally not a FK (history outlives rows)
  request_id      TEXT,
  correlation_id  TEXT,
  causation_id    UUID,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence        JSONB NOT NULL DEFAULT '[]'::jsonb,
  prev_hash       TEXT NOT NULL,
  hash            TEXT NOT NULL,
  CONSTRAINT audit_ledger_tenant_seq_uq UNIQUE (tenant_id, seq),
  CONSTRAINT audit_ledger_evidence_array_chk CHECK (jsonb_typeof(evidence) = 'array'),
  CONSTRAINT audit_ledger_payload_object_chk CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS audit_ledger_claim_idx
  ON audit_ledger (claim_id, seq) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_ledger_entity_idx
  ON audit_ledger (entity_type, entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_ledger_action_idx
  ON audit_ledger (tenant_id, action, recorded_at);
CREATE INDEX IF NOT EXISTS audit_ledger_correlation_idx
  ON audit_ledger (correlation_id) WHERE correlation_id IS NOT NULL;

-- ── Canonical hash ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.audit_ledger_hash(
  p_prev_hash text, p_tenant_id uuid, p_seq bigint, p_id uuid,
  p_occurred_at timestamptz, p_recorded_at timestamptz,
  p_actor_type text, p_actor_id text, p_actor_role text, p_action text,
  p_entity_type text, p_entity_id text, p_claim_id text,
  p_request_id text, p_correlation_id text, p_causation_id uuid,
  p_payload jsonb, p_evidence jsonb
) RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
  SELECT encode(sha256(convert_to(concat_ws(',',
    quote_nullable(p_prev_hash),
    quote_nullable(p_tenant_id::text),
    quote_nullable(p_seq::text),
    quote_nullable(p_id::text),
    quote_nullable(to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
    quote_nullable(to_char(p_recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
    quote_nullable(p_actor_type),
    quote_nullable(p_actor_id),
    quote_nullable(p_actor_role),
    quote_nullable(p_action),
    quote_nullable(p_entity_type),
    quote_nullable(p_entity_id),
    quote_nullable(p_claim_id),
    quote_nullable(p_request_id),
    quote_nullable(p_correlation_id),
    quote_nullable(p_causation_id::text),
    quote_nullable(p_payload::text),
    quote_nullable(p_evidence::text)
  ), 'UTF8')), 'hex')
$$;

-- ── Chain assignment on insert ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.audit_ledger_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_last_seq  bigint;
  v_last_hash text;
BEGIN
  -- Serialize appends per tenant: one chain, no forks, no duplicate seq.
  PERFORM pg_advisory_xact_lock(hashtextextended('audit_ledger:' || NEW.tenant_id::text, 0));

  SELECT l.seq, l.hash INTO v_last_seq, v_last_hash
    FROM public.audit_ledger l
   WHERE l.tenant_id = NEW.tenant_id
   ORDER BY l.seq DESC
   LIMIT 1;

  NEW.id          := COALESCE(NEW.id, gen_random_uuid());
  NEW.seq         := COALESCE(v_last_seq, 0) + 1;
  NEW.prev_hash   := COALESCE(v_last_hash, 'GENESIS');
  NEW.recorded_at := clock_timestamp();
  NEW.occurred_at := COALESCE(NEW.occurred_at, NEW.recorded_at);
  NEW.payload     := COALESCE(NEW.payload, '{}'::jsonb);
  NEW.evidence    := COALESCE(NEW.evidence, '[]'::jsonb);
  NEW.hash        := app.audit_ledger_hash(
    NEW.prev_hash, NEW.tenant_id, NEW.seq, NEW.id, NEW.occurred_at, NEW.recorded_at,
    NEW.actor_type, NEW.actor_id, NEW.actor_role, NEW.action,
    NEW.entity_type, NEW.entity_id, NEW.claim_id,
    NEW.request_id, NEW.correlation_id, NEW.causation_id,
    NEW.payload, NEW.evidence);
  RETURN NEW;
END $$;

-- ── Append-only enforcement ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.audit_ledger_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_ledger is append-only: % is not permitted', TG_OP
    USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS audit_ledger_chain        ON audit_ledger;
DROP TRIGGER IF EXISTS audit_ledger_no_mutation  ON audit_ledger;
DROP TRIGGER IF EXISTS audit_ledger_no_truncate  ON audit_ledger;

CREATE TRIGGER audit_ledger_chain
  BEFORE INSERT ON audit_ledger
  FOR EACH ROW EXECUTE FUNCTION app.audit_ledger_before_insert();

CREATE TRIGGER audit_ledger_no_mutation
  BEFORE UPDATE OR DELETE ON audit_ledger
  FOR EACH ROW EXECUTE FUNCTION app.audit_ledger_reject_mutation();

CREATE TRIGGER audit_ledger_no_truncate
  BEFORE TRUNCATE ON audit_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_ledger_reject_mutation();

-- ── Verification + anchoring helpers ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.audit_ledger_verify(p_tenant_id uuid)
RETURNS TABLE (ok boolean, checked bigint, first_bad_seq bigint, reason text)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  r              public.audit_ledger%ROWTYPE;
  v_expect_prev  text   := 'GENESIS';
  v_expect_seq   bigint := 1;
  v_n            bigint := 0;
BEGIN
  FOR r IN SELECT * FROM public.audit_ledger WHERE tenant_id = p_tenant_id ORDER BY seq LOOP
    v_n := v_n + 1;
    IF r.seq <> v_expect_seq THEN
      RETURN QUERY SELECT false, v_n, r.seq, 'sequence gap (row removed)'::text; RETURN;
    END IF;
    IF r.prev_hash <> v_expect_prev THEN
      RETURN QUERY SELECT false, v_n, r.seq, 'prev_hash does not match predecessor'::text; RETURN;
    END IF;
    IF r.hash <> app.audit_ledger_hash(
         r.prev_hash, r.tenant_id, r.seq, r.id, r.occurred_at, r.recorded_at,
         r.actor_type, r.actor_id, r.actor_role, r.action,
         r.entity_type, r.entity_id, r.claim_id,
         r.request_id, r.correlation_id, r.causation_id,
         r.payload, r.evidence) THEN
      RETURN QUERY SELECT false, v_n, r.seq, 'hash mismatch (row altered)'::text; RETURN;
    END IF;
    v_expect_prev := r.hash;
    v_expect_seq  := r.seq + 1;
  END LOOP;
  RETURN QUERY SELECT true, v_n, NULL::bigint, NULL::text;
END $$;

CREATE OR REPLACE FUNCTION app.audit_ledger_head(p_tenant_id uuid)
RETURNS TABLE (seq bigint, hash text, recorded_at timestamptz)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT l.seq, l.hash, l.recorded_at
    FROM public.audit_ledger l
   WHERE l.tenant_id = p_tenant_id
   ORDER BY l.seq DESC
   LIMIT 1
$$;

-- ── Privileges ───────────────────────────────────────────────────────────────
ALTER TABLE audit_ledger ENABLE ROW LEVEL SECURITY;   -- no policies: API roles see nothing

REVOKE UPDATE, DELETE, TRUNCATE ON audit_ledger FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON audit_ledger FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON audit_ledger FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE ALL ON audit_ledger FROM service_role';
    EXECUTE 'GRANT SELECT, INSERT ON audit_ledger TO service_role';
    EXECUTE 'GRANT USAGE ON SCHEMA app TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.audit_ledger_verify(uuid) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.audit_ledger_head(uuid) TO service_role';
  END IF;
END $$;

REVOKE ALL ON FUNCTION app.audit_ledger_verify(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.audit_ledger_head(uuid)   FROM PUBLIC;

COMMIT;

-- ── ROLLBACK (manual; not executed) ─────────────────────────────────────────
-- The ledger is a regulated record. It is never dropped in production.
-- In a disposable environment only:
--   DROP TABLE audit_ledger;  DROP FUNCTION app.audit_ledger_verify(uuid);
--   DROP FUNCTION app.audit_ledger_head(uuid); DROP FUNCTION app.audit_ledger_before_insert();
--   DROP FUNCTION app.audit_ledger_reject_mutation(); DROP FUNCTION app.audit_ledger_hash(...);
