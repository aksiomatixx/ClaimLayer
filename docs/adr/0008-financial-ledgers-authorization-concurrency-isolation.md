# ADR-0008: Financial ledgers — authorization, concurrency and isolation

- Status: Accepted — implemented
- Date: 2026-10-02
- Builds on: ADR-0003 (audit ledger), ADR-0004 (approvals), ADR-0006 (units of
  work), ADR-0007 (append-only history)
- Reviews: commits `4009cbe` and `b6b59e7`, pushed directly to `main`
  outside the PR flow

## Context

Two direct pushes to `main` added a reserve ledger, a payment ledger with a
payee vault, client loss-fund escrow, a staffing hierarchy, per-body-part
compensability, document storage metadata and tenant-wide `tenant_id`
columns. The direction is right. A review against the binding rules found
that the work could not ship as written:

| Area | Defect |
|---|---|
| Migrations | Two of the five could not apply: a missing table in the tenant list, a stray character in the policy SQL, and VARCHAR keys referencing UUID columns. One updated append-only history. None had been applied anywhere, the hosted project included |
| RLS | The new financial tables had PERMISSIVE policies for PUBLIC that passed whenever `app.tenant_id` was unset, as it always is on the PostgREST path. Anonymous API callers could read and write payees and payments. `app.current_tenant_id()` fell back to the default tenant for any caller |
| Payments | `POST /claims/:id/ledger/payments` issued a payment directly, skipping the existing `payment.issue` approval, authority and MFA |
| Concurrency | Balances were read and then written with no lock. A duplicate check ran before its insert with nothing in between to stop a racing insert. Ordering relied on a per-process counter that pushed timestamps into the future |
| Error handling | `try/catch` blocks marked "non-fatal" inside transactions around ledger writes. On PostgreSQL a failed statement aborts the transaction, so these either surfaced later as a confusing error or committed a payment without its ledger entry |
| Audit | Benefit-service audit helpers sent snake_case keys, so the ledger dropped the claim id. They also wrote an `audit_log.tenant_id` column that does not exist, so every C&R, disbursement and PD action failed on PostgreSQL |
| Voids | A void did not reduce paid-to-date, raised incurred instead, and could run twice |
| Routes | Request bodies could override tenant, actor and claim. Employer-portal users could read other employers' escrow accounts and loss runs |

## Decision

### 1. Every ledger payment traces to a human authorization

- `paymentLedgerService.issuePayment` runs only inside its authorizing unit
  of work (`opts.tx`).
- It is attributed to the human who authorized it (`opts.actor`).
- It must reference that authorization: an approved `payment.issue` request,
  an approved award disbursement, or a recorded statutory PD advance payment.
- **New payments.** The claim-ledger route now proposes `payment.issue` and
  returns 202. The payment is issued by the approval executor when a second
  human with authority for the amount (and MFA) approves it. Self-approval is
  refused, as for every action.
- **Recorded payments.** A disbursement or PD advance already paid out is a
  fact the ledger must hold, so it passes `recorded: true`. If the reserve is
  short, the ledger posts an explicit `reserve_revision` attributed to
  `system:payment-ledger` and opens a `RESERVE_ADEQUACY_REVIEW` diary for the
  adjuster. A new payment against a short reserve is refused: the adjuster
  raises the reserve through its own approval first.

### 2. One lock per claim ledger; balances are sums

- Every posting takes `pg_advisory_xact_lock(hashtextextended('claim-ledger:' || claim_id, 0))`
  for the rest of its transaction. This covers reserve postings, payment
  issue (before its duplicate check) and void.
- A category's balance is `SUM(amount_delta)`, which does not depend on row
  order or timestamps. `resulting_balance` is a stored snapshot.
- A void flips the payment's status with a conditional update, under a row
  lock, then posts `payment_void`: paid-to-date goes down, the reserve goes
  back up, incurred is unchanged. Of two concurrent voids exactly one
  succeeds.
- Reserve approval posts only the differences to its targets (`postToTargets`)
  inside the approval's unit. A ledger failure fails the approval.
- Loss-fund deposits and debits re-read the account under `FOR UPDATE`. A
  frozen or closed account keeps its status, and a frozen account takes no
  debits.

### 3. Deny by default at the database

- The financial and staffing tables have **no permissive policy**: anonymous
  and authenticated callers read and write nothing. The backend's service-role
  and owner connections bypass RLS.
- A RESTRICTIVE tenant policy (`TO authenticated`) keeps any future
  permissive grant tenant-bound.
- `anon` has no privileges on these tables. `reserve_transactions` and
  `loss_fund_transactions` are append-only: triggers block UPDATE, DELETE and
  TRUNCATE, and those privileges are revoked. The only exception is the
  ADR-0007 demo purge.
- `app.current_tenant_id()` resolves a signed-in user to their own `users`
  row. Only a connection without a JWT subject may name a tenant through
  `app.tenant_id`. There is no fallback, so no match means no rows.

### 4. Audit entries belong to the unit

`benefitAudit.recordAudit` writes the ledger entry and the legacy `audit_log`
row inside the caller's transaction. It resolves the claim id from the entity.
If either write fails, the action does not commit.

### 5. The migrations were corrected in place

None of the 20261004–20261005 migrations had ever applied successfully, here
or on the hosted project. Editing them in place is therefore not a silent
schema change. A follow-up migration would have had to start from a state
that no database has.

The contract test now:

- re-applies them for idempotency;
- proves deny-by-default under Supabase's default grants;
- proves the strict tenant function;
- checks the `claim_events` tenant backfill (which disables the UPDATE
  trigger only under the migration's own lock, and only when a claim lives
  outside the default tenant);
- checks the latest-snapshot reserve backfill.

## Consequences

- **Behavior changes:**
  - The claim-ledger payment route returns 202 and a pending request, not a
    payment.
  - Recording a payment above the reserve raises the reserve visibly instead
    of failing silently or going negative.
  - Payee tax ids and bank accounts need `PAYEE_VAULT_KEY` in production
    (never `JWT_SECRET`).
  - Employer-portal users no longer see staffing or loss-run endpoints until a
    mapping from employer user to agency or host employer exists.
  - Model output is held to its prompt's contract: title-case priorities,
    three labels, an integer score from 0 to 100. Invalid fields are flagged,
    never promoted.
- **Tests:**
  - `tests/pg/financialLedgers.pg.test.js` proves the races resolve to one
    winner. With the lock disabled, the overdraw test fails every time and the
    duplicate test fails intermittently.
  - `tests/integration/ledger-routes.test.js` proves the route controls.
  - `tests/unit/financialControls.test.js` covers escrow, claim state and the
    §5402 clock.
  - The static guard now covers both financial ledgers.
- **Still open:**
  - TD-period WCIS triggers are best-effort after commit, not durable jobs
    (the TD-units follow-up).
  - The 2020–2025 TD min/max rows are REGULATORY-PENDING: results say
    `statutoryScheduleVerified: false`.
  - `storeDocument` is not yet wired to an intake path and records
    `not_scanned` until a real antivirus scanner exists.

## Alternatives considered

- **A unique index on `duplicate_hash`.** Rejected. It would block legitimate
  repeat payments outside the 90-day window. The lock serializes the check
  and the insert instead.
- **Locking the claim row (`FOR UPDATE`).** Rejected. It would serialize
  every claim update behind ledger postings. The advisory lock is scoped to
  the ledger.
- **Blocking a recorded payment that exceeds the reserve.** Rejected. The
  money has already moved, so refusing to record it would leave the ledger
  and WCIS reporting out of step with reality. The deficiency is recorded
  explicitly and put in front of the adjuster.
