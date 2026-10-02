# ADR-0006: Transactional core — unit of work, durable job queue, outbox

- Status: Accepted — implemented for the approval lifecycle, reserve approval, RFA approval, and
  all background work (Sprint 2, increment 1)
- Date: 2026-10-02
- Addresses: the "Event / audit", "Reliability" and "Financial controls" gaps in
  `CLAIMLAYER_TPA_PRODUCTION_READINESS.md`, and ADR-0003's "Interim" write semantics

## Context

The backend talked to Postgres only through supabase-js with the service-role key. That means
one HTTP request per statement and **no multi-statement transactions**. Every consequential
workflow was a sequence of independent writes held together by compensating writes, for
example:

- "if the ledger append fails, cancel the request";
- "if events fail, delete the claim".

A crash between two writes left half a workflow behind. The audit ledger (ADR-0003) was
therefore best-effort on several paths: it could not be written atomically with the change it
recorded.

Background work (AI analysis, notices, WCIS triggers, RFA evaluation, FileHandler pushes) ran
in 15 `setImmediate` fire-and-forget calls. Any restart, deploy or crash lost that work, with
no retry and no record.

Reserve approval called FileHandler synchronously *before* the local writes. The two systems
could diverge, and a FileHandler outage made a properly approved reserve fail.

Every foreign key from claim history into `claims` was `ON DELETE CASCADE`. One delete
erased events, diaries, reserves, documents and appointments.

## Decision

### 1. A unit of work over a direct Postgres connection (`backend/src/db/`)

```js
await runInTransaction({ tenantId, actorId, label }, async (tx) => {
  ...state change via tx...
  await auditLedger.append(entry, { tx });            // same transaction
  await jobQueue.enqueue({ queue, payload }, { tx }); // same transaction
  await outbox.enqueue([...], { tx });                // same transaction
  tx.afterCommit(() => ...);                          // only after COMMIT
});
```

- **`pool.js`** — a `pg` pool on `DATABASE_URL`, with TLS (localhost: off; otherwise
  required; `verify` checks the CA) and a statement timeout.
  - Type parsers return **PostgREST shapes**: timestamps as ISO strings, dates as
    `YYYY-MM-DD`, numerics and safe bigints as numbers. Code written against supabase-js
    therefore sees identical values.
- **`unitOfWork.js`** —
  - `BEGIN`; transaction-local `app.tenant_id` / `app.actor_id` (for triggers and future RLS);
    `COMMIT` / `ROLLBACK`.
  - Retries the whole unit on deadlock (`40P01`) or serialization failure (`40001`), up to 3
    attempts. A unit must therefore touch only the database: external effects go through the
    outbox or a job.
  - `afterCommit` hooks run once, after commit. They never throw into the caller.
- **`adapters.js`** — one small interface (`insert`, `update`, `select`, `selectOne`, `query`,
  `afterCommit`) with two implementations:

  | Mode | When | Guarantees |
  |---|---|---|
  | `pg` | `DATABASE_URL` set. **Required in production** — config refuses to boot without it, and `runInTransaction` refuses again | Atomic |
  | `compat` | No `DATABASE_URL`: the in-memory test suite and the DB-less demo | Same business code over supabase-js. **Not atomic**; the former compensating writes still run, in this mode only |

  The adapter validates identifiers, checks columns against `information_schema`,
  JSON-encodes `jsonb` values, requires a `where` on updates, and has **no `delete()`**.

### 2. A durable job queue (`jobs` table, `services/jobQueue.js`, `jobs/registry.js`)

Lifecycle: `pending → running → succeeded | dead`; also `pending → cancelled`.

- **Enqueue inside the transaction** that needs the work. A rolled-back change leaves no
  orphan job; a committed change cannot lose its job.
- **Claiming:**
  - Workers claim with `FOR UPDATE SKIP LOCKED` under a lease (`locked_by`, `locked_until`).
  - An expired lease is reclaimed.
  - Completion is **fenced** on `locked_by`, so a worker whose lease was taken over cannot
    overwrite the new owner's outcome.
- **Retries:**
  - Backoff is 30 s·2ⁿ⁻¹, capped at 1 h, with ±20 % jitter.
  - Each queue declares `maxAttempts` (1 where a repeat is unsafe).
  - `(queue, idempotency_key)` is unique.
- **Dead-letter, in one transaction:**
  - the job is marked `dead`;
  - a `job.dead` audit-ledger entry is written;
  - a `BACKGROUND_JOB_FAILED` diary goes on the claim.

  Operators list jobs and re-queue dead ones (`GET /admin/jobs`,
  `POST /admin/jobs/:id/requeue`, ledgered).
- **Who runs jobs:**
  - After commit, the API process "kicks" a new job for low latency.
  - Retries and recovery belong to pollers: `npm run worker` (also drives the outbox), the
    in-process poller (single-process deployments; `JOBS_IN_PROCESS_POLLER=false` to disable),
    or `POST /admin/workers/jobs/run` from a scheduler.
- **Registry and handlers:**
  - Every queue is declared in `jobs/registry.js`; an unknown queue fails at the call site.
  - Handlers receive plain JSON, reload mutable records by id, and must be idempotent.
- **What this replaced:** all 15 `setImmediate` sites. In `compat` mode the handler runs on the
  next macrotask, with exactly the timing `setImmediate` gave, so existing behavior and tests
  are unchanged there.

### 3. The approval lifecycle is transactional (ADR-0004)

| Step | One transaction contains |
|---|---|
| `propose` | request insert + `action.proposed` |
| `decide` | conditional transition + `action.approved/modified/rejected` |
| `execute` | conditional claim to `executing` + the **executor's effects** + `executed` + `action.executed` |

- An approved action either happened with its complete record, or did not happen at all.
- A failed execution rolls back entirely and is recorded as `execution_failed` (with
  `action.execution_failed`) in a separate unit. It is never stuck in `executing`, and it is
  retryable.
- Racing approvers or retries resolve to exactly one winner on the row lock.
- Executors receive `ctx.tx` and must not call external systems directly.

### 4. Reserve and RFA approvals are units of work

- **Reserve approval** (direct, worksheet, or action request) commits these together:
  - the `reserves` row;
  - the `reserves_approved` event;
  - the **required** `reserve.approved` ledger entry;
  - a `set_reserves` **outbox** row.

  FileHandler is updated by dispatching that row after commit, with the outbox id as its
  idempotency key. An outage leaves the approval committed and the sync pending. The outbox
  retries it and, terminally, raises a CRITICAL `INTEGRATION_SYNC_FAILED` diary.
- **RFA approval** commits these together:
  - the decision;
  - the claim event;
  - completion of the RFA-scoped diary;
  - an `rfa.approved` ledger entry;
  - the determination-letter job.

  The action-request path re-checks "still undecided" under the RFA row lock. Superseding
  queued agent proposals runs after commit.

### 5. No cascading deletes from `claims`

Migration `20261002000001` rewrites every foreign key into `claims` without `ON DELETE
CASCADE`, keeping names and columns. A claim with history cannot be deleted at all; claims are
closed, not deleted. Demo reset deletes child tables explicitly, in foreign-key order, and
fails loudly instead of half-wiping.

### 6. Proof on real PostgreSQL

`npm run test:pg` (`tests/pg/`, CI job "Migrations + schema contract") runs against a freshly
migrated database:

- commit/rollback, a **real deadlock** and its retry, row locks;
- `SKIP LOCKED` exactly-once processing across concurrent workers;
- lease reclaim and fencing; dead-letter atomicity;
- ledger rollback with an intact chain;
- approval atomicity under injected ledger and database failures; approval races;
- the RFA flow end to end on the real schema.

Failures are injected with temporary `NOT VALID` CHECK constraints, so the database itself
refuses the write mid-transaction. supabase-js reads in these paths run through a pg-backed
stand-in (`tests/pg/pgSupabase.js`). It sees committed data only, as PostgREST does.

## Consequences

- **Production needs `DATABASE_URL`** (Supabase: the direct connection or the session pooler
  on port 5432). The API holds a pool of up to `DATABASE_POOL_MAX` connections; worker
  processes hold their own.
- **Behavior change — FileHandler reserve sync is asynchronous.** A FileHandler outage no
  longer fails a reserve approval. The approval commits and the sync is retried.
  `filehandler.setReserves` now carries an idempotency key.
- **Behavior change — background work is retried.** A failing analysis, notice or WCIS hook is
  retried with backoff and then dead-lettered to a diary, instead of being logged and lost.
- **Behavior change — direct RFA approval writes an `rfa.approved` ledger entry** and records
  the session principal as the actor.
- **Found and fixed:** the real-schema suite and a new static audit
  (`backend/scripts/schema-write-audit.js`, in CI) found five columns the code wrote but no
  migration created. They are added in `20261002000001`. On a real database:
  - `createRFA` failed;
  - RFA decisions never persisted;
  - the statutory `RFA_RESPONSE_DUE` diary was never created;
  - TD-setup diaries never auto-completed;
  - stipulation notice rows were never written.

  Most of those writes were unchecked, so the failures were silent. The in-memory double
  accepts any column and hid them.
- **Not yet transactional (increment 2):**
  - `claimService` (create, status), `diaryActionService` and `documentIngestionService`
    still use compensating writes;
  - their background jobs are enqueued outside a transaction. Durable once written, but a
    crash between the state change and the enqueue can still lose the job;
  - `tenant_id` is not yet on every table, nor enforced by query scoping;
  - `claim_events` is not yet append-only;
  - `_testStore` and the in-memory double remain.
- **Open domain question (TODO, not invented):** a *direct* approval of an RFA already decided
  another way (for example routed to URO) is not refused. Whether it should be is a
  utilization-review rule to confirm.

## Alternatives considered

- **Postgres functions (RPC) per workflow.** Atomic over supabase-js, but business logic would
  move into PL/pgSQL, be tested separately, and duplicate validation. Rejected for workflows;
  still fine for small primitives.
- **An external queue (SQS, Redis, BullMQ).** Another system to operate, and the enqueue could
  not share the business transaction without a second outbox. A Postgres queue with
  `SKIP LOCKED` is sufficient at TPA volume and keeps exactly-once enqueue.
- **Converting every service at once.** Too large to review or prove. The dual-adapter
  interface lets services move one at a time while the in-memory suite keeps passing.
