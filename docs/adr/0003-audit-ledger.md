# ADR-0003: Immutable, hash-chained audit ledger

- Status: Accepted — implemented (interim write semantics, see below)
- Date: 2026-10-01
- Addresses: findings S-15 and D-1, and the "Event and audit architecture" gaps

## Context

Before this change, the audit trail was split across four places, and none of them was
immutable:

- **`claim_events`** — no actor column; `ON DELETE CASCADE` from `claims`; deleted by
  compensation code.
- **`audit_log`** — actor optional; RLS `FOR ALL` lets an admin update or delete rows.
- **`ai_decisions`** — the code's insert shape did not exist on a database built from the
  migrations (D-1). Human reviews were written by updating the AI row in place.
- **Winston request logs** — stdout only.

A TPA has to reconstruct, for any consequential action:

- what happened, and when;
- who or what initiated it;
- what the agent recommended and on what evidence;
- what the human decided, and what was executed.

That history must not silently change.

## Decision

1. **One append-only ledger, `audit_ledger`**
   (`supabase/migrations/20261001000002_audit_ledger.sql`), with integrity enforced by the
   database rather than by application convention:
   - A `BEFORE INSERT` trigger assigns `seq`, `prev_hash`, `hash`, and `recorded_at` under a
     per-tenant advisory lock. Callers cannot choose them, and concurrent writers cannot fork
     the chain.
   - `hash = sha256` over every field plus the predecessor's hash. Fields are rendered with
     `quote_nullable`, timestamps in UTC with microseconds, and `jsonb` in canonical form. The
     hash is therefore unambiguous and independent of session settings.
   - `UPDATE`, `DELETE`, and `TRUNCATE` are rejected by triggers and revoked from every API
     role. `service_role` keeps `SELECT` and `INSERT` only.
   - `claim_id` is deliberately **not** a foreign key, so no claim deletion can remove history.
   - `app.audit_ledger_verify(tenant)` recomputes the chain and reports the first altered or
     missing row. `app.audit_ledger_head(tenant)` returns the chain head for external
     anchoring.
2. **Hybrid, not full event sourcing.** Current-state tables remain the operational source.
   The ledger records consequential actions and their evidence. Full event sourcing was
   rejected for its cost to corrections, reporting, and onboarding.
3. **Vocabulary.** Actions are dotted lower-case (`claim.status_changed`, `reserve.approved`,
   `action.proposed`, `agent.recommendation_recorded`, …). Actors are principals
   (`backend/src/policy/principal.js`). Payloads carry facts, with amounts in integer cents.
   Raw model output and document text stay out of the ledger.
4. **Required vs. best-effort writes.**
   - *Required* (the operation fails if the ledger write fails): AI recommendations for
     regulated decisions, approval-lifecycle proposals, and decisions.
   - *Best-effort* (logged loudly on failure): dual-writes from legacy paths that are not yet
     transactional.

## Interim (until the transactional data layer lands)

The backend still writes through supabase-js / PostgREST, which has no multi-statement
transactions. So a ledger entry cannot yet be committed atomically with the state change it
describes. Until Sprint 2 moves consequential paths to a `pg` unit of work:

- Approval proposals and decisions are written to the ledger **before** they take effect. A
  ledger failure reverts the request: no unaudited decision stands.
- Execution and legacy state changes are written **after** the change succeeds. If such a write
  fails, the change stands and the error is logged; the executor's own records
  (`claim_events`, `reserves`) still exist.
- A rolled-back diary aftermath appends a compensating `claim.status_change_reverted` entry.
  Ledger rows are never deleted.

## Consequences

- **Tamper-evident, not tamper-proof against a database superuser.** A superuser can disable
  triggers; verification then detects altered rows and gaps, but not truncation of the chain's
  tail. Anchor `app.audit_ledger_head()` periodically to WORM storage (roadmap: Security).
- **The ledger grows without bound.** Plan partitioning by tenant and time before volume
  requires it. Retention follows the record-retention schedule (to be set with counsel), not
  row deletion.
- **Real-PostgreSQL proof.** `backend/scripts/migration-contract-test.js` proves chain
  assignment, append-only enforcement, tamper and gap detection, timezone independence, and
  privileges against PostgreSQL 16.
