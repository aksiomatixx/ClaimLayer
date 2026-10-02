# Architecture Decision Records

Each ADR records one decision: the context that forced it, what was decided, and what it costs.
ADRs are immutable once accepted. A changed decision gets a new ADR that supersedes the old one.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-system-of-record.md) | ClaimLayer is the claims and financial system of record | Accepted |
| [0002](0002-server-authoritative-identity.md) | Server-authoritative identity | Accepted — implemented |
| [0003](0003-audit-ledger.md) | Immutable, hash-chained audit ledger | Accepted — implemented; transactional appends via ADR-0006 on converted paths |
| [0004](0004-action-registry-and-approvals.md) | Action registry, authority policy, and approval lifecycle | Accepted — implemented for reserve changes and RFA approvals |
| [0005](0005-rules-engine.md) | Versioned, effective-dated rules engine | Proposed |
| [0006](0006-transactional-core.md) | Transactional core — unit of work, durable job queue, outbox | Accepted — implemented for approvals, reserve and RFA approval, background work |
| [0007](0007-claim-lifecycle-units-and-append-only-history.md) | Claim lifecycle as units of work; append-only claim history | Accepted — implemented |

## Template

```markdown
# ADR-NNNN: Title

- Status: Proposed | Accepted | Superseded by ADR-XXXX
- Date: YYYY-MM-DD

## Context
## Decision
## Consequences
## Alternatives considered
```
