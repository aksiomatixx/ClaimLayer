# ADR-0001: ClaimLayer is the claims and financial system of record

- Status: Accepted
- Date: 2026-10-01

## Context

ClaimLayer was built as a workflow layer on top of a customer's retained claims system.
`docs/data-model.md` names FileHandler as authoritative for financials and diaries, and the
legacy adapter layer (`backend/src/services/legacy/`) exists to write decisions back to that
system.

The business is now a California workers' compensation TPA. A TPA owns the claim file, the
reserve and payment ledgers, the statutory reporting, and the audit trail that regulators and
clients examine. If financial truth lives in another product:

- authority limits cannot be enforced at the point of payment;
- duplicate-payment controls cannot be guaranteed;
- the audit trail splits across two systems.

## Decision

ClaimLayer becomes the system of record for claims, reserves, payments, diaries, documents, and
the audit trail.

- External systems become integrations behind adapters: payment rails, EDI transport, bill
  review, UR, and print-mail.
- Legacy adapters become import and migration tools rather than the architecture's center.

## Consequences

- A reserve ledger and a payment ledger must be built in ClaimLayer (roadmap: Financial
  controls). Until they exist, the FileHandler call inside `claimService.approveReserves`
  remains the money-moving step. It is now reached only through authorized paths, and every
  call is recorded in the audit ledger.
- `filehandler.js`, `MockLegacyAdapter`, and the `legacy_*` tables are transitional. New
  features must not deepen the dependency on an external ledger.
- Reconciliation with external money movers (bank, check vendor) becomes ClaimLayer's job.

## Alternatives considered

- **Stay a layer on a third-party claims system.** Rejected: the TPA would be accountable for
  controls it does not own.
- **License a claims platform and build agents beside it.** Viable commercially, but it gives up
  the integrated data and audit architecture that is the intended advantage.
