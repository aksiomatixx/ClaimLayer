-- ════════════════════════════════════════════════════════════════════════════
-- Sprint 2 — transactional core: durable job queue + no cascading claim deletes
--
-- 1. jobs — the durable work queue that replaces in-process setImmediate()
--    background work (claim analysis, notice generation, WCIS triggers,
--    RFA evaluation, ...). See docs/adr/0006-transactional-core.md.
--
--      pending ──claim──▶ running ──▶ succeeded
--         ▲                  │
--         └── retry (backoff)┤
--                            └──▶ dead     (attempts exhausted; ledger + diary)
--      pending ──▶ cancelled
--
--    * Enqueued INSIDE the same transaction as the state change that needs
--      the work: a rolled-back change never leaves an orphan job, and a
--      committed change can never lose its job to a process crash.
--    * Workers claim with FOR UPDATE SKIP LOCKED and hold a lease
--      (locked_by, locked_until). A crashed worker's lease expires and the
--      job is reclaimed; completion is fenced on locked_by so a worker
--      whose lease was reclaimed cannot overwrite the new owner's result.
--    * idempotency_key is unique per queue when present: enqueueing the
--      same logical work twice is a no-op.
--    * claim_id is a lookup column, deliberately NOT a foreign key: jobs
--      are operational and retention-pruned; the record of what happened
--      is audit_ledger.
--
-- 2. Every foreign key into claims loses ON DELETE CASCADE. Deleting a
--    claim row must never silently erase its event history, diaries,
--    reserves, documents or appointments. A claim with dependent records
--    now cannot be deleted at all (the FK raises); a claim is closed, not
--    deleted. The constraints keep their names and columns — only the
--    delete action changes — so application code is unaffected. (Callers
--    that delete a just-created claim as compensation do so before any
--    child row exists; demo reset deletes children explicitly.)
--
-- 3. Schema truth — columns the code writes but no migration created. On a
--    real database each of these writes was rejected; most were unchecked,
--    so the failure was silent. Found by the real-PostgreSQL test suite
--    (tests/pg/) and an audit of every insert/update shape against the
--    migrated schema; the in-memory test double accepts any column.
--    All additive, nullable or defaulted — non-breaking.
--      rfas.updated_at                 every RFA write (create, AI routing,
--                                      deferral, URO referral, approval):
--                                      createRFA failed outright and RFA
--                                      decisions never persisted
--      diaries.auto_generated,         the statutory RFA_RESPONSE_DUE diary
--      diaries.generated_by_event      (CCR §9792.9.1) was never created
--      diaries.resolution_notes        TD_PAYMENT_SETUP diaries were never
--                                      auto-completed by TD period creation
--      notices.pdf_buffer_b64          the stipulation notice audit row was
--                                      never written
--
-- Idempotent: safe to re-apply.
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1. Durable job queue ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jobs (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
                   REFERENCES tenants(id),
  queue            TEXT NOT NULL
                   CONSTRAINT jobs_queue_chk
                   CHECK (queue ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length(queue) <= 100),
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CONSTRAINT jobs_status_chk
                   CHECK (status IN ('pending', 'running', 'succeeded', 'dead', 'cancelled')),
  run_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts         INTEGER NOT NULL DEFAULT 0
                   CONSTRAINT jobs_attempts_chk CHECK (attempts >= 0),
  max_attempts     INTEGER NOT NULL DEFAULT 8
                   CONSTRAINT jobs_max_attempts_chk CHECK (max_attempts BETWEEN 1 AND 25),
  locked_by        TEXT,
  locked_until     TIMESTAMPTZ,
  last_error       TEXT,
  idempotency_key  TEXT,
  claim_id         TEXT,
  correlation_id   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  -- A running job always carries its lease; a finished job always says when.
  CONSTRAINT jobs_running_lease_chk
    CHECK (status <> 'running' OR (locked_by IS NOT NULL AND locked_until IS NOT NULL)),
  CONSTRAINT jobs_finished_at_chk
    CHECK ((status IN ('succeeded', 'dead', 'cancelled')) = (finished_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_uq
  ON jobs (queue, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_due_idx
  ON jobs (run_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS jobs_lease_idx
  ON jobs (locked_until) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (claim_id, created_at) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_dead_idx
  ON jobs (tenant_id, finished_at) WHERE status = 'dead';

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;   -- service role only

-- ── 2. No cascading deletes from claims ─────────────────────────────────────

DO $$
DECLARE
  r   record;
  def text;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass AS tbl, pg_get_constraintdef(c.oid) AS condef
      FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.confrelid = 'public.claims'::regclass
       AND c.confdeltype = 'c'
  LOOP
    def := replace(r.condef, ' ON DELETE CASCADE', '');
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.tbl, r.conname, def);
    RAISE NOTICE 'removed ON DELETE CASCADE: %.%', r.tbl, r.conname;
  END LOOP;
END $$;

-- ── 3. Schema truth ─────────────────────────────────────────────────────────

ALTER TABLE rfas    ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ DEFAULT now();
ALTER TABLE diaries ADD COLUMN IF NOT EXISTS auto_generated     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE diaries ADD COLUMN IF NOT EXISTS generated_by_event TEXT;
ALTER TABLE diaries ADD COLUMN IF NOT EXISTS resolution_notes   TEXT;
ALTER TABLE notices ADD COLUMN IF NOT EXISTS pdf_buffer_b64     TEXT;

COMMIT;

-- ── ROLLBACK (manual; not executed) ─────────────────────────────────────────
-- jobs (disposable environments only, or after draining the queue):
--   DROP TABLE jobs;
-- Restoring cascades is NOT recommended (it re-opens silent history loss).
-- If required, per constraint, e.g.:
--   ALTER TABLE claim_events DROP CONSTRAINT claim_events_claim_id_fkey,
--     ADD CONSTRAINT claim_events_claim_id_fkey FOREIGN KEY (claim_id)
--       REFERENCES claims(id) ON DELETE CASCADE;
-- (the constraints this migration changed, as of 2026-10: claim_events,
--  diaries, reserves, documents, appointments, magic_link_tokens, td_periods,
--  reserve_line_items, claim_links ×2.)
-- Schema-truth columns (each drop re-breaks the write that needs it):
--   ALTER TABLE rfas    DROP COLUMN updated_at;
--   ALTER TABLE diaries DROP COLUMN auto_generated, DROP COLUMN generated_by_event,
--                       DROP COLUMN resolution_notes;
--   ALTER TABLE notices DROP COLUMN pdf_buffer_b64;
