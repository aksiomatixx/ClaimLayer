-- ════════════════════════════════════════════════════════════════════════════
-- Trust Foundation (Sprint 1) — action requests (approval lifecycle)
--
-- The record of every consequential action that needs a human decision:
--
--   proposed (agent or human) → pending_approval
--     → approved | rejected          (a human, with rationale, within authority)
--     → executing → executed | execution_failed   (the SYSTEM executes)
--   pending_approval → cancelled | expired
--
-- action_type values are declared in backend/src/policy/actionRegistry.js,
-- which also fixes each action's agent autonomy tier. The authority
-- evaluation (backend/src/policy/authorityPolicy.js) is snapshotted at
-- proposal time and re-evaluated against the approver at decision time.
-- Every transition is also written to audit_ledger.
-- See docs/adr/0004-action-registry-and-approvals.md.
--
-- Database-enforced invariants (defense in depth for the service checks):
--   * no self-approval: decided_by <> proposed_by;
--   * decided states carry a decision, decider and rationale;
--   * a modify decision carries the approved payload;
--   * executed / failed states only follow an approve/modify decision;
--   * idempotency_key is unique when present (no duplicate proposals).
--
-- claim_id references claims WITHOUT cascade: a claim with action history
-- cannot be deleted out from under it.
--
-- MIGRATION APPLY RULE: staged for review — do not auto-apply.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS action_requests (
  id                      TEXT PRIMARY KEY,
  tenant_id               UUID NOT NULL REFERENCES tenants(id),
  client_id               TEXT,
  claim_id                VARCHAR(60) REFERENCES claims(id),
  action_type             TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'pending_approval'
                          CONSTRAINT action_requests_status_chk
                          CHECK (status IN ('pending_approval', 'approved', 'rejected',
                                            'executing', 'executed', 'execution_failed',
                                            'cancelled', 'expired')),
  proposed_by_type        TEXT NOT NULL
                          CONSTRAINT action_requests_proposed_by_type_chk
                          CHECK (proposed_by_type IN ('human', 'agent', 'system')),
  proposed_by             TEXT NOT NULL,
  proposed_by_role        TEXT,
  ai_decision_id          UUID,
  proposal                JSONB NOT NULL,
  evidence                JSONB NOT NULL DEFAULT '[]'::jsonb,
  rationale               TEXT,
  amount_cents            BIGINT CONSTRAINT action_requests_amount_chk CHECK (amount_cents IS NULL OR amount_cents >= 0),
  authority_evaluation    JSONB,
  required_approver_role  TEXT,
  policy_version          TEXT NOT NULL,
  decision                TEXT
                          CONSTRAINT action_requests_decision_chk
                          CHECK (decision IS NULL OR decision IN ('approve', 'modify', 'reject')),
  decided_by              TEXT,
  decided_by_role         TEXT,
  decision_rationale      TEXT,
  decision_authority      JSONB,
  approved_payload        JSONB,
  modifications           JSONB,
  decided_at              TIMESTAMPTZ,
  executed_by             TEXT,
  executed_at             TIMESTAMPTZ,
  execution_result        JSONB,
  execution_error         TEXT,
  execution_attempts      INTEGER NOT NULL DEFAULT 0,
  cancelled_reason        TEXT,
  idempotency_key         TEXT,
  expires_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT action_requests_no_self_approval_chk
    CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CONSTRAINT action_requests_decided_fields_chk
    CHECK (decision IS NULL OR (decided_by IS NOT NULL AND decided_at IS NOT NULL
                                AND decision_rationale IS NOT NULL)),
  CONSTRAINT action_requests_modify_payload_chk
    CHECK (decision IS DISTINCT FROM 'modify' OR approved_payload IS NOT NULL),
  -- COALESCE: with decision NULL, `decision IN (...)` is NULL and a CHECK
  -- accepts NULL — the invariant must be false, not unknown.
  CONSTRAINT action_requests_execution_requires_approval_chk
    CHECK (status NOT IN ('approved', 'executing', 'executed', 'execution_failed')
           OR COALESCE(decision IN ('approve', 'modify'), FALSE)),
  CONSTRAINT action_requests_rejected_requires_reject_chk
    CHECK (status <> 'rejected' OR COALESCE(decision = 'reject', FALSE))
);

CREATE UNIQUE INDEX IF NOT EXISTS action_requests_idempotency_key_uq
  ON action_requests (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS action_requests_queue_idx
  ON action_requests (tenant_id, status, created_at) WHERE status = 'pending_approval';
CREATE INDEX IF NOT EXISTS action_requests_claim_idx
  ON action_requests (claim_id, created_at);

ALTER TABLE action_requests ENABLE ROW LEVEL SECURITY;   -- service role only

COMMIT;

-- ── ROLLBACK (manual; not executed) ─────────────────────────────────────────
-- Approval history is a regulated record; do not drop in production.
-- Disposable environments only:  DROP TABLE action_requests;
