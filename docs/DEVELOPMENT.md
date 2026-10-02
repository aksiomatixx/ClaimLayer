# Developer setup

## Prerequisites

- Node.js 20+ (CI uses 24)
- Python 3.11 with `fastapi uvicorn pydantic`, for the mock ADP and FileHandler servers used by
  some backend tests
- PostgreSQL 16 (Docker or local binaries), for the schema-contract test and the transactional
  suite
- Optional: the Supabase CLI plus Docker, for a full local stack (`supabase start`)

## Install

```bash
npm ci --prefix backend
npm ci --prefix frontend
cp backend/.env.example backend/.env    # then fill in SUPABASE_* and JWT_SECRET
```

## Tests

| Suite | Command | Notes |
|---|---|---|
| Backend (Jest) | `cd backend && npm test` | In-memory Supabase mock. Fast, but it cannot catch schema, constraint, RLS, or transaction defects |
| Schema contract (real PostgreSQL) | see below | Applies every migration to a clean database and asserts the code's write shapes, constraints, RLS coverage, and the audit-ledger guarantees |
| Schema write audit | `DATABASE_URL=… node backend/scripts/schema-write-audit.js` | Every column the code writes (static scan) must exist in the migrated schema |
| Transactional suite (real PostgreSQL) | `cd backend && PG_TEST_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:pg` | Unit of work, job queue, approval atomicity and races, the RFA flow on the real schema (ADR-0006). Creates and drops its own database |
| Frontend (Vitest) | `cd frontend && npm test` | |
| Live-model eval | `node backend/src/scripts/liveIngestionTest.js` | Needs `ANTHROPIC_API_KEY`; run after `npm run gen:test-docs` |

Run the contract test whenever you touch a migration or a write path:

```bash
# Docker
docker run -d --name cl-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  node backend/scripts/migration-contract-test.js
```

The script expects an empty database. Drop and recreate it between runs:

```bash
psql postgres://postgres:postgres@localhost:5432/postgres \
  -c 'drop database if exists contract' -c 'create database contract'
DATABASE_URL=postgres://postgres:postgres@localhost:5432/contract \
  node backend/scripts/migration-contract-test.js
```

The in-memory mock (`backend/tests/__mocks__/supabaseClient.js`) accepts any column. A green
Jest run does **not** prove that the database accepts a write. That is how finding D-1 shipped,
and how five more phantom columns survived until Sprint 2 (ADR-0006). New data paths need a
contract assertion, and transactional paths need a `tests/pg/` test.

The in-memory suite always runs in the unit of work's compatibility mode: `tests/setup.js`
clears `DATABASE_URL`, so a value in your `.env` never points it at a real database.

## Running the app

```bash
npm run dev:demo     # seeds 14 synthetic claims, starts backend :3001 + frontend :5173
```

The demo frontend signs in through the dev auto-login endpoints (`/auth/dev-session` and
siblings). These work only when `NODE_ENV` is `development` or `test`.

## Provisioning a staff user (real login)

Login reads role and tenant from `public.users`, never from Supabase `user_metadata`
(ADR-0002):

1. Create the auth user (Supabase dashboard or Admin API).
2. Insert its row:

```sql
insert into public.users (id, email, role, tenant_id, active)
values ('<auth user uuid>', 'adjuster@example.test', 'adjuster',
        '00000000-0000-0000-0000-000000000001', true);
```

Roles:

- staff: `adjuster`, `supervisor`, `admin`
- employer portal: `employer` (also set `employer_id`)

Deactivate with `update public.users set active = false where id = …`.

## MFA in development

MFA enforcement is on whenever `SUPABASE_URL` is set, which includes a local Supabase stack.
Approving an MFA-flagged action (`reserve.change`) therefore needs a session from
`POST /auth/login/mfa` (TOTP enrolled in Supabase Auth). The dev auto-login sessions are not
MFA-verified, so they get `403 MFA_REQUIRED` on those decisions. This is intended: there is no
bypass flag.

## Approval API (ADR-0004)

```bash
# 1. An adjuster escalates a reserve change above their authority (amounts in integer cents)
curl -X POST localhost:3001/api/v1/claims/$CLAIM/action-requests -b cookies -H 'content-type: application/json' -d '{
  "action_type": "reserve.change",
  "payload": { "medical_cents": 3500000, "indemnity_cents": 2000000, "expense_cents": 500000,
               "reason": "Surgery recommended per PR-2" },
  "rationale": "Exceeds my authority; surgery now likely.",
  "idempotency_key": "reserve-review-claim123-2026-10-01"
}'

# 2. A different, sufficiently authorized human decides (approve | modify | reject)
curl -X POST localhost:3001/api/v1/action-requests/$ID/decision -b sup-cookies -H 'content-type: application/json' -d '{
  "decision": "approve", "rationale": "Surgical recommendation supports the increase."
}'

# Queue, catalog, history
curl localhost:3001/api/v1/action-requests?status=pending_approval -b sup-cookies
curl localhost:3001/api/v1/action-registry -b cookies
curl localhost:3001/api/v1/claims/$CLAIM/ledger -b sup-cookies
```

## Transactions and background work (ADR-0006)

Consequential writes go through a unit of work:

```js
const { runInTransaction } = require('../db/unitOfWork');
await runInTransaction({ tenantId, actorId, label: 'reserve.approve' }, async (tx) => {
  await tx.insert('reserves', row);
  await auditLedger.append(entry, { tx });                      // commits with the change
  await jobQueue.enqueue({ queue: 'notice.dwc7', payload }, { tx });
  await outbox.enqueue([{ target: 'filehandler', operation: 'set_reserves', ... }], { tx });
});
```

Rules:

- Never call an external system inside a unit (deadlocks retry the whole unit). Use the outbox,
  a job, or `tx.afterCommit`.
- Background work is a job, never `setImmediate`. Register the queue in
  `backend/src/jobs/registry.js` with a retry budget. Handlers receive plain JSON, reload
  records by id, and must be idempotent.
- Run a worker locally with `DATABASE_URL=… npm run worker`, or rely on the API's in-process
  poller.
- Do not write compensating deletes. A failed unit rolls back. History tables are append-only:
  `audit_ledger` and `claim_events` (ADR-0007) refuse UPDATE and DELETE, so a correction is a
  new event. `tests/unit/historyIsAppendOnly.test.js` fails on code that tries.
- Prove rollback behavior in `tests/pg/`. The in-memory suite runs the non-atomic compatibility
  mode and cannot show it.

## Verifying the audit ledger

```sql
select * from app.audit_ledger_verify('00000000-0000-0000-0000-000000000001');
select * from app.audit_ledger_head('00000000-0000-0000-0000-000000000001');
```

## Conventions

- **Migrations:**
  - additive and idempotent (`IF NOT EXISTS`, guarded `DO` blocks);
  - named constraints (`{table}_{column}_chk`);
  - a commented manual rollback section;
  - applied *before* the matching backend.
- **Money** crosses into new subsystems as integer cents (`backend/src/utils/money.js`).
- **Consequential actions** go through the action registry and approval service. Do not add new
  direct-write routes for financial or legal decisions.
- **Statutory values and deadlines** come from committed, verified sources (ADR-0005). When a
  rule is uncertain, add a `REGULATORY-PENDING` note and a validation task instead of inventing
  the rule.
