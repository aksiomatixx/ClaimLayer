# ADR-0004: Action registry, authority policy, and approval lifecycle

- Status: Accepted — implemented for `reserve.change` and `medical.rfa.approve`
- Date: 2026-10-01
- Addresses: findings S-4 and S-5, and the "Human approval architecture" gaps

## Context

Authorization was a role allow-list per route. About 120 routes required `admin`, so every
claims professional had to be an omnipotent admin, with no monetary authority and no
separation between proposer and approver.

Approval was implicit. The RFA agent's `auto_approve` executed directly: the RFA was marked
`auto_approved` by `ai_system` and the approval letter issued with no human (S-5).

The operating principle is:

> AI gathers facts → structures evidence → calculates deterministic components → identifies
> issues → recommends → a human decides → ClaimLayer executes → everything is audited.

## Decision

### 1. Action registry (`backend/src/policy/actionRegistry.js`)

Every consequential action type is declared once, as frozen code, with its agent autonomy:

| Tier | Agents may | Examples |
|---|---|---|
| `autonomous` | execute (reversible, non-consequential, audited) | classify a document, create a review task, draft correspondence |
| `prepare_for_approval` | propose an action request | reserve change, payment, RFA approval, compensability accept/delay, TD start/stop, notice send |
| `analyze_only` | analyze and recommend in narrative; never propose | claim or body-part denial, UR deny/modify, settlement authority and offers, litigation filings, SIU referral, reopening |

- Changing a tier is a code change plus an ADR. `tests/unit/policy.test.js` pins the tiers so
  a relaxation fails CI.
- No financial action may be `autonomous`.

### 2. Authority policy (`backend/src/policy/authorityPolicy.js`)

A pure function, `evaluateAuthority`, that takes:

- the actor's role level and per-action monetary limit, in integer cents;
- escalations keyed to claim characteristics (litigated, represented, risk flags) that raise
  the minimum role;
- client overrides that may only **tighten** limits.

It returns `withinAuthority`, `requiredRole`, reasons, and the policy version. The result is
snapshotted onto the request at proposal time and re-evaluated against the approver at decision
time.

- The dollar figures are placeholder business limits, not legal rules.
- Legacy `admin` maps to claims-manager authority until roles are split. This is recorded as a
  separation-of-duties gap.

### 3. Approval lifecycle (`backend/src/services/approvalService.js`, table `action_requests`)

```
propose (agent | human) ──► pending_approval ──► approved ──► executing ──► executed
                                   │                                  └──► execution_failed ──► (retry)
                                   ├──► rejected
                                   └──► cancelled (superseded / unaudited)
```

Enforced in the service and, where marked (DB), again by database constraints:

- Agents propose only `prepare_for_approval` actions.
- Only humans decide or execute. Nobody decides their own proposal (DB).
- Every decision carries a rationale (DB). A `modify` decision carries the approved payload
  (DB).
- Authority is checked against the **final** payload, so a modification that raises the amount
  needs the higher authority.
- Financial actions require an MFA-verified approver session.
- Transitions are conditional updates: concurrent approvers cannot both win. Idempotency keys
  are unique (DB).
- Executors (`backend/src/services/actionExecutors.js`) run as the **approving** human and
  re-check preconditions. A failed execution is recorded, surfaced as HTTP 502, and retryable
  by someone holding the same authority.
- Requests are tenant-scoped. A cross-tenant read or decision is a 404.
- Every transition is written to the audit ledger (ADR-0003). Proposal and decision entries
  are required.

### 4. RFA approvals (S-5)

An AI `auto_approve` now:

1. leaves the RFA in `pending_adjuster_review`, with its response diary open;
2. files an agent-proposed `medical.rfa.approve` request citing the RFA and the AI decision.

The approval letter issues only after a human approves, either through the request or
directly. A direct approval or UR routing cancels the pending agent proposal.

## Consequences

- **Behavior change:** RFAs no longer approve themselves. Adjusters see AI-approvable RFAs in
  the review queue with the recommendation attached. Tests that encoded autonomous approval
  were rewritten to assert the human path.
- **The legacy direct route remains.** `PATCH /claims/:id/reserves` is still `admin`-only
  and writes to the ledger, but it bypasses the authority check. It should be retired once the
  UI uses action requests.
- **Next steps:**
  - per-user `authority_grants` in the database;
  - a permission catalog;
  - executors for payments (with the payment ledger), compensability decisions, and TD
    start/stop;
  - an approval queue UI.
