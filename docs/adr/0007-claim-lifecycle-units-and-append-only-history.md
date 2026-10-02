# ADR-0007: Claim lifecycle as units of work; append-only claim history

- Status: Accepted — implemented (Sprint 2, increment 2a)
- Date: 2026-10-02
- Builds on: ADR-0006 (transactional core)
- Addresses: findings D-2 and S-15, the TOCTOU row in "Reliability", and
  "History deletable" in the readiness doc

## Context

ADR-0006 made the approval lifecycle, reserve approval and RFA approval
transactional. The rest of the claim lifecycle still held itself together
with hand-written compensation:

| Workflow | What the compensation did |
|---|---|
| Claim creation | Deleted the claim if its events failed |
| Diary decisions (`diaryActionService`) | A 40-line `_rollback` that deleted notices, delivery channels, successor diaries, events and outbox rows; restored the claim status; then appended a "reverted" ledger entry |
| Document ingestion and triage | Deleted orphan documents, diaries and events, and wrote "reverted" audit rows |

This had three costs:

- A crash *during* compensation left half a workflow behind.
- Compensation meant history could be deleted, so `claim_events` could not be
  made append-only.
- `updateStatus` read the status, checked the transition, then wrote it. Two
  concurrent transitions could both pass the check.

## Decision

### 1. Every claim-lifecycle workflow is one unit of work

Each workflow below commits as one unit, or not at all.

| Workflow | Unit |
|---|---|
| `createClaim` | Employee upsert, claim, opening events, the five statutory diaries and their events, a `claim.created` ledger entry, and the follow-up jobs (analysis, DWC-7, WCIS FROI 00, FileHandler-create retry) |
| `updateStatus` | Transition, event, ledger entry, WCIS and legacy write-back jobs. The status is re-read under a row lock (`SELECT … FOR UPDATE`), so concurrent transitions resolve to one winner. It joins a caller's unit through `opts.tx` |
| `reopenClaim`, `setAttorneyRepresentation` | Change, event, audit row, ledger entry, WCIS job. The row lock makes a racing reopen lose |
| Diary decisions (`completeAction`, `declineAction`, `editAction`) | See below |
| Document ingestion, triage, legacy migration | Document, action diary and event; triage claim, filing or rejection, diary, event, audit row; claim and migration event |

**Diary decisions.** Everything is in the unit:
- the conditional claim on the diary;
- the status transition, run first because it carries the business validation;
- notices, with their documents and delivery channels;
- successor diaries and deadline escalations;
- outbox rows, the event and the audit row;
- the `diary.action_completed` / `diary.action_declined` ledger entry;
- the completed flip.

A failure rolls all of it back. A separate small unit records an
`action_completion_failed` event. `noticeTemplateService.generateNotice` and
`noticeDeliveryService.queueNotice` take the caller's `tx`, or open their own.

**FileHandler claim creation.** It is an external call, so it runs *after*
commit:
- The inline attempt keeps today's response, which includes the FileHandler id.
- A delayed `filehandler.create_claim` job is enqueued inside the unit as the
  durable retry. It is a no-op once the claim has a FileHandler id. The id is
  only written while still unset.

**All compensating writes are deleted.** In the non-atomic compatibility mode
(dev, and the in-memory suite) a failed unit can leave partial rows. Production
requires `DATABASE_URL` (ADR-0006). Two small, honest releases stay so a claim
is never stranded in dev: the diary's `completing` claim, and the document's
`resolving` claim. The rollback guarantees are proven on PostgreSQL in
`tests/pg/`.

### 2. `claim_events` is append-only (migration `20261003000001`)

- **Triggers:** BEFORE UPDATE, DELETE and TRUNCATE triggers raise SQLSTATE
  `42501`.
- **Privileges:** UPDATE, DELETE and TRUNCATE are revoked from `anon`,
  `authenticated` and `service_role`. The supabase-js path cannot mutate events
  at all.
- **Corrections** are new events.
- **The one exception is the synthetic demo seed.** A transaction that sets
  `app.history_purge = 'demo'` may delete the events of claims flagged
  `metadata.demo = true`. Demo reset over `DATABASE_URL` does this:
  - in one transaction;
  - refusing outright to touch any claim not flagged as demo.
- **A static guard** (`tests/unit/historyIsAppendOnly.test.js`) fails if any
  code path other than demo reset ever updates or deletes `claim_events` or
  `audit_ledger`. The in-memory double does not enforce the triggers.
- **Related fix:** legacy migration used to stamp *every* migrated claim as demo
  data. Now only the synthetic `mock_legacy` source is demo, so a real migrated
  claim is never purgeable.

## Consequences

- **Behavior changes:**
  - Status changes, reopen, representation and diary decisions now fail
    instead of committing without their ledger entry (the entry used to be
    best-effort).
  - WCIS triggers from reopen and representation are durable jobs. They run a
    tick later and are retried.
  - A direct diary edit fails if its audit row cannot be written.
- **Demo reset against a real database needs `DATABASE_URL`.** The REST path
  can no longer delete events.
- **Known gap (D-10).** The demo dataset keys some rows with string ids where
  the real schema has UUID keys (`employers`, `policies`, `rfas`,
  `td_periods`, `pd_evaluations`, `settlement_offers`). Those inserts are
  rejected on a real database. `tests/pg/demoReset.pg.test.js` ratchets this to
  exactly the known statements until the dataset is re-keyed.
- **Still open:**
  - tenant scoping (increment 2b);
  - `_testStore` (D-7);
  - the compensation-free conversion of the remaining services (TD periods,
    QME, PD, C&R, disbursements). Their background work is already durable
    (ADR-0006); their multi-row writes are not yet single units.

## Alternatives considered

- **Keep compensation alongside transactions.** Two code paths, and compensation
  is exactly what prevented append-only history. Rejected.
- **Purge demo history with a SECURITY DEFINER function.** That would add a
  standing privileged entry point. The transaction-scoped setting plus the
  per-row demo check is narrower, and needs no new grant.
