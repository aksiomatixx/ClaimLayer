# System Architecture

ClaimLayer is a regulatory-aware execution layer for California workers' compensation
claims: a team of Claude agents drafts the analysis, applies statutory math, and prepares
the next action, while deterministic guardrails enforced in code and a licensed human at
every consequential decision keep the model inside its bounds. It runs as a workflow layer
on top of a retained claims system of record, not a replacement for it.

This document describes **the system as it exists in this repository**. It runs on
synthetic demo data; external vendor integrations are stubbed behind real interfaces (see
[Integrations](#integrations)). It is a reference implementation, not a production
deployment.

The same material is browsable in-app at `/architecture` (agent registry, guardrail
catalog, and human-checkpoint tables, rendered with live 30-day decision stats).

**Stack:** Node.js / Express · React / Vite · PostgreSQL (Supabase) · Anthropic Claude API
· server-side PDF generation (pdf-lib).

---

## How to read this doc

Each section labels what is real versus deferred:

- **Implemented** — code in this repo, exercised by the test suite.
- **Simulated** — a working interface with a stub/mock adapter; the contract is real, the
  vendor call is not.
- **Production setup** — what an operator must provide to run it for real.
- **Future** — designed-for but not built.

---

## Component overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  FRONTEND — React / Vite (single-page, React Query for server state)   │
│  Adjuster console · Claim drawer (decision loop) · /agents · /architec.│
│  Supervisor digest · Employer & Employee portals                       │
└───────────────────────────────┬──────────────────────────────────────┘
                                 │  HTTPS / REST · JWT in httpOnly cookie
┌───────────────────────────────▼──────────────────────────────────────┐
│  BACKEND — Express                                                      │
│  Routes (25 groups)  →  Services (business logic)  →  Integrations      │
│                                                                        │
│  AI layer:        aiService → Claude (6 prompts) + deterministic gates  │
│  Guardrails:      enforced in services, not prompts                     │
│  Audit:           aiDecisionsService logs every model call             │
│  Ingestion:       documentIngestionService (PDF text-layer + fallback)  │
│  Cron workers:    notice delivery · integration outbox · supervisor     │
│  Webhooks:        inbound email (docs) · Lob delivery · WCIS acks       │
└───────────────────────────────┬──────────────────────────────────────┘
                                 │
┌───────────────────────────────▼──────────────────────────────────────┐
│  DATA — PostgreSQL (Supabase) · 29 migrations · RLS policies            │
│  claims (state machine) · claim_events · ai_decisions · diaries ·       │
│  documents · rfas · reserves · td_periods · pd_evaluations ·            │
│  settlement_offers · audit_log · legacy_* (adapter round trip)          │
└───────────────────────────────┬──────────────────────────────────────┘
                                 │  pluggable LegacyClaimsAdapter
┌───────────────────────────────▼──────────────────────────────────────┐
│  INTEGRATIONS (interfaces real, adapters stubbed in this repo)          │
│  Claude API (live when ANTHROPIC_API_KEY set) · Legacy system of record │
│  (mock round trip) · ADP / FileHandler (local mock servers) ·           │
│  Lob print-mail (stub) · SendGrid/Twilio (stub) · WCIS EDI (stub adapt.)│
└──────────────────────────────────────────────────────────────────────┘
```

---

## Agent boundaries

Six agents are registered. Five call Claude; one (MSA screening) is deterministic by
design — Medicare eligibility is a threshold rule, not a judgment call, so no model touches
it. Every agent has an authored prompt in `backend/prompts/`, an explicit invocation
trigger, and a bounded output schema. **No agent sets claim status or writes money; they
recommend, and a human disposes.**

| Agent | Model | Invoked when | Returns |
|---|---|---|---|
| Compensability Analyst | Claude | Claim reaches `intake_complete` | score, priority, suggested reserves, red flags — never a status |
| RFA / MTUS Evaluator | Claude | New RFA received | `auto_approve` or `physician_review` only — **no deny path** |
| C&R Pricing Engine | Claude | After MSA screen passes | a value *range*; recommendation hardcoded to `adjuster_review` |
| MSA Screening Gate | **Deterministic** | Before any C&R offer | `medicare_eligible`, `msa_required` from pure threshold logic |
| Voice Intake Extractor | Claude | Employee submits a voice transcript | structured intake fields; never overwrites adjuster-entered values |
| Document Classifier | Claude | Any document ingested | category (controlled list), confidence, verbatim claim number or null |

**Implemented.** Agent code in `backend/src/services/` (`aiService.js`, `rfaService.js`,
`cnrService.js`, `pdPricingService.js`, `msaScreeningService.js`, `voiceService.js`,
`documentIngestionService.js`). Prompts live in `backend/prompts/*.txt` so they are
reviewable and editable without a code deploy.

---

## Deterministic guardrails

Guardrails live in the **service layer, not the prompts** — the model cannot reach past
them regardless of what it returns. The full catalog (12 rules, each tied to a regulatory
or product reason) renders in-app at `/architecture`; the load-bearing ones:

- **No auto-deny path exists anywhere in the system.** There is no code path from any model
  output to a `denied` status. Denials are a licensed-human action by construction.
- **RFA agent may only return `auto_approve` or `physician_review`.** Adverse
  determinations require a licensed physician (LC §4610). Surgical CPT (10000–69999) and
  Category-III codes route to physician review regardless of the model's recommendation.
- **C&R pricing is capped and gated.** Offers above 1.15× the stipulated value are flagged
  for adjuster scrutiny; above 5.0× are rejected outright. Every C&R is gated by the
  deterministic MSA screen before the model ever prices it.
- **Statutory values are never model-generated.** PDRS values, statutory rates, and fee
  schedules come from authoritative DWC sources tracked in
  `docs/regulatory/sources.json`; the model reasons over them, never invents them.
- **Penalty / deadline diaries cannot be snoozed**, and deadlines use the correct
  calendar- vs business-day basis per the governing code section.
- **Every model call is audited** (next section).

**Implemented & tested.** Adversarial guardrail tests in
`backend/tests/adversarial/` and `backend/tests/security/` attempt to push agents past
their bounds and assert the guardrails hold. A live-model eval gate
(`backend/src/scripts/liveIngestionTest.js`, run by
`.github/workflows/live-ingestion-test.yml`) replays 13 golden documents through the real
classifier and asserts category, claim match, and routing — it has already caught the model
over-applying a signal, which was then fixed deterministically in code.

---

## Human-in-the-loop checkpoints

Nine sign-off points, in lifecycle order — every consequential decision is a licensed
person's. The agent prepares; the human disposes from a ranked action queue where the
analysis is already drafted and the deadline already computed.

Compensability accept/deny · reserve approval · RFA approve / route-to-URO · MMI/P&S
confirmation · PD advance amount + start date · C&R offer review (AI range → human price) ·
C&R acceptance (worker + adjuster signature) · EAMS filing · stipulation filing → closure.

**Implemented.** Each maps to a service method (`claimService.updateStatus`,
`claimService.approveReserves`, `rfaService.adjusterApproveRFA`, `cnrService.offerCnr`,
…). The drawer shows a **dry-run of exactly what completing an action will do** before the
adjuster commits; edits are audited and penalty diaries refuse to move.

---

## Audit logging

`aiDecisionsService.logDecision` records every model call with its input snapshot, parsed
output, confidence, guardrails triggered, latency, token counts, and any human-override
status. For regulated decisions it is called with `{ required: true }` so a persistence
failure fails the call rather than letting an unaudited decision stand; elsewhere it is
best-effort and never throws. The full feed is queryable in-app at `/agents`, with 30-day
per-agent stats surfaced on `/architecture`. A separate `audit_log` table records
human/admin actions. Retention target is 7 years per CA WC record requirements.

**Implemented.** `ai_decisions` and `audit_log` tables; `/agents` console and
`/architecture` stats read them live.

---

## Document ingestion

The inbound half of the inversion — every arriving document becomes a prepared action, not
a PDF in an inbox:

1. A document arrives as an **actual PDF** (drawer upload or the inbound-email webhook) or
   as extracted text.
2. PDFs extract their text layer locally (`pdfjs-dist`); a scanned PDF with no usable text
   layer falls back to classifying the document itself via a Claude document block — same
   guardrails either way.
3. The Document Classifier assigns a controlled category and, when present, the **verbatim**
   claim number (never guessed).
4. Routing guardrails: confidence below threshold, an unverifiable claim number, or a
   category outside the controlled list sends the document to a **human triage queue** —
   it is never silently filed.
5. A **deterministic rules table** (not a model output) translates the category into the
   diary/action it requires; the action surfaces in the drawer with the source document one
   click away.

**Implemented & tested.** `documentIngestionService.js`; the end-to-end path (arrival →
classification → claim match → triage-or-file → action diary → write-back) is walked by
`backend/tests/integration/document-to-action.e2e.test.js`, and exercised with real Claude
calls and real PDFs by the live-ingestion eval gate.

---

## Background workers

Three cron workers run the outbound aftermath. All are also triggerable via authenticated
admin endpoints, so the demo needs no scheduler.

| Worker | Module | Cadence (prod) |
|---|---|---|
| Notice delivery | `backend/src/cron/noticeDeliveryWorker.js` | every 15 min |
| Integration outbox | `backend/src/cron/outboxWorker.js` | every 5 min |
| Supervisor alerts | `backend/src/cron/supervisorAlertWorker.js` | 06:30 America/Los_Angeles, Mon–Fri |

A WCIS deadline monitor (`backend/src/cron/wcisDeadlineMonitor.js`) tracks state-reporting
acknowledgement deadlines. The supervisor digest is deterministic (plain queries, no
model) — it lists every no-snooze diary due today and every overdue diary across the book,
grouped by adjuster, acknowledged with an audit trail.

---

## Integrations

ClaimLayer is a **system of engagement on top of a retained system of record**. A pluggable
`LegacyClaimsAdapter` interface (`healthCheck`, `ingestClaims`, `pushClaimUpdate`,
`pushDiary`, `pushDocument`, `pushNotice`) lets a customer's claims system be wired in with
one contract — no rip-and-replace. Outbound writes go through a durable **outbox** so a
degraded downstream never blocks operational state; failures are queued and retried.

| Integration | In this repo | Production setup |
|---|---|---|
| Claude API | **Live** when `ANTHROPIC_API_KEY` is set; agents degrade gracefully without it | API key |
| Legacy system of record | **Mock adapter** with a visible bidirectional round trip on demo data | Implement the adapter for the target system (Origami, Guidewire, Sapiens, A1/FileHandler) |
| ADP (wage/AWW) · FileHandler (ledger) | **Local mock servers** (`backend/mocks/`); the client code is the same against the real APIs | Vendor credentials + base URLs |
| Lob (print & mail) | **Stub** — letters are `submitted`, marked `delivered` only by a signature-verified webhook | `LOB_LIVE=true` + real client + `LOB_WEBHOOK_SECRET` |
| SendGrid / Twilio (email / SMS) | **Stub**; inbound-email document channel is shaped for SendGrid Inbound Parse / Mailgun | Vendor account + inbound MX/DNS + `EMAIL_INBOUND_TOKEN` |
| WCIS FROI/SROI (state EDI) | **Stub adapter** (`WCIS_ADAPTER=stub`); transactions build, enqueue, and reconcile against simulated acks | DWC trading-partner credentials + a real adapter |

No integration is claimed to be live in production. EAMS filing is always a manual
procedural step — no EAMS API exists.

---

## Database

PostgreSQL via Supabase. 29 migrations in `supabase/migrations/`, applied in filename
order; **migrations are never auto-applied** — each is staged for review because schema
changes can touch regulated data. Row-level-security policies ship in the migrations.

Design principles:

- **Claims are state machines.** A `status` field with defined transitions; every change
  is written to the immutable `claim_events` log, so any claim's history reconstructs from
  events alone.
- **Every AI decision is a row.** `ai_decisions` is the audit trail and the dataset.
- **Schema-contract tested.** `backend/scripts/migration-contract-test.js` asserts every
  write shape the code performs against a schema built only from the migrations, so code and
  schema cannot silently drift.

Core tables: `claims`, `claim_events`, `ai_decisions`, `documents`, `diaries`, `rfas`,
`rfa_evaluations`, `reserves`, `td_periods`, `pd_evaluations`, `settlement_offers`,
`notices`, `audit_log`, plus `legacy_*` tables for the adapter round trip.

---

## Security

- **Auth:** Supabase-backed; JWT in an httpOnly cookie (never localStorage). Roles:
  `admin`, `employer`, `employee`, `supervisor`. Employees authenticate via single-use
  magic-link JWTs. *(MFA enroll/verify endpoints are stubbed.)*
- **Authorization:** role checks at the API layer plus row-level-security policies at the
  database layer.
- **Webhooks fail closed:** Lob delivery, inbound email, and WCIS acks reject requests
  without their configured secret/token rather than processing them.
- **Audit:** AI decisions and admin actions are logged; retention target 7 years.

---

## Testing & CI

**1,352 automated tests across 92 suites** — 1,268 backend (Jest), 84 frontend
(Vitest + Testing Library). Coverage spans benefits math, statutory-deadline logic,
state-machine transitions, atomic decision workflows, the document-to-action e2e path, and
adversarial guardrail tests.

CI (`.github/workflows/`):

- **ci.yml** — backend + frontend suites; all 29 migrations apply to a clean PostgreSQL 16,
  the hardening migration re-applies idempotently, and the schema contract is asserted.
- **live-ingestion-test.yml** — the live-model eval gate: 13 golden PDFs through the real
  classifier, asserting category, claim match, and routing.
- **pages.yml** — deploys the marketing site + interactive demo to GitHub Pages.

---

## Deployment

**Production setup.** Apply migrations before deploying the matching backend
(`migrate → deploy`, always — the code writes columns the migrations create). Provide the
backend env (`SUPABASE_*`, `JWT_SECRET`, `ANTHROPIC_API_KEY`, and any vendor secrets), run
the three cron workers (or hit their admin endpoints on a scheduler), and set the
webhook secrets — webhook verification fails closed without them.

**Demo.** `npm run dev:demo` seeds 14 synthetic claims and starts the backend (:3001) and
frontend (:5173) against a local Supabase. The interactive demo is a static build of the
real frontend with captured API fixtures, deployed to GitHub Pages — no backend required.

---

## Future work

- Real `LegacyClaimsAdapter` implementations for named claims systems.
- Live vendor adapters (Lob, SendGrid/Twilio, WCIS EDI trading partner) behind the existing
  interfaces.
- Supabase MFA enrollment (endpoints are scaffolded).

---

*See `docs/data-model.md` for the schema, `docs/regulatory/sources.json` for tracked
statutory sources, and the in-app `/architecture` and `/agents` views for the live agent
registry, guardrail catalog, and decision audit trail.*
