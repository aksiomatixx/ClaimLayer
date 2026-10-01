# ADR-0005: Versioned, effective-dated rules engine

- Status: Proposed
- Date: 2026-10-01

## Context

California statutory logic is encoded as JavaScript constants scattered across services:

- `DOC_ACTION_RULES`, in `documentIngestionService`
- `AFTERMATH_RULES`, in `diaryActionService`
- `DISBURSEMENT_POLICY`
- `PD_RATES_2026`, in `pdService`
- TD minimum/maximum, in `adp.js`
- the initial diaries, in `claimService._seedInitialDiaries`

None of these are versioned or effective-dated, and no computed deadline records which rule
produced it. Several carry honest `REGULATORY-PENDING` notes because their citations are not
backed by a committed source. Two are known to be wrong for the staffing use case:

- AWW assumes biweekly pay (D-3);
- TD limits apply one year's values to every date of injury (D-4).

Requirements:

- Legal rules must be separable from model reasoning.
- Rules must not be invented.
- Rules must be addable and versioned safely.

## Decision (proposed)

### Rule packs

Rule packs are stored as data plus registered code, keyed by `rule_id@version`. Each carries:

- jurisdiction (CA);
- `effective_from` / `effective_to`, plus which date selects the version (date of injury,
  receipt, service, etc.);
- citation and `source_document` (a committed file under `docs/regulatory/`);
- `verified_by` and `verified_at`;
- `status ∈ {draft, unverified, validated, retired}`.

### Logic and parameters

Logic is deterministic code functions. Numeric parameters (rates, day counts, holiday
calendars) live in reviewed data tables, so annual updates are data changes.

### Validation gate

Only `validated` rules may drive automation: sending notices, starting benefits, setting
statutory deadlines that cannot be snoozed. `unverified` rules may create advisory tasks
labelled as unverified.

### Traceability

Every computed output stores `rule_id@version`, inputs, and outputs: deadline instances,
benefit rates, and notice requirements.

### Golden vectors

Each rule version ships test vectors. CI fails if a validated rule's vectors change without a
version bump.

### Model isolation

Models never compute rule outputs. They may extract rule inputs from documents (dates,
restrictions); a human confirms an input before it drives a deadline or benefit.

### Migration path

Lift each existing constant table into a rule pack with status `unverified`. A licensed
reviewer then validates rules one by one against committed sources.

## Consequences

- A licensed reviewer and counsel become part of the release process for regulatory rules.
- Existing automated behavior (initial diaries, aftermath rules) would initially degrade to
  "advisory" until validated. That is the honest state of those rules today.
