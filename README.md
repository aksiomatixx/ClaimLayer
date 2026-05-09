# HomeCare TPA

> AI-first workers' compensation third-party administrator for California home health agencies.

## Overview

HomeCare TPA is a claims intelligence platform that automates 90%+ of routine WC claims administration tasks, surfacing only genuine edge cases to the supervising adjuster. It is not a workflow tool that makes adjusters faster — it is a system that replaces the repetitive administrative layer entirely while preserving licensed human judgment where California law requires it.

**Specialization:** California home health and home care agencies exclusively.
**License requirement:** California CDI TPA license, CA WC Adjuster license (held by owner).
**Regulatory framework:** California Labor Code, CCR Title 8, DWC regulations, MTUS/ACOEM guidelines.

> For operational roadmap, active build plan, and business context, see the internal Master Context document (not in repo).

---

## Repository Structure

```
homecare-tpa/
├── README.md
├── frontend/                         ← React application (Vite)
│   └── src/
│       ├── App.jsx                   ← Main platform UI (admin + employer + employee portals)
│       ├── Wireframes.jsx            ← Interactive user stories
│       ├── main.jsx                  ← React root with QueryClientProvider
│       ├── i18n.js                   ← i18next config (EN/ES)
│       ├── locales/                  ← en.json, es.json translation files
│       └── services/
│           ├── claims.js             ← fetch wrappers: fetchClaims, triggerAnalysis, etc.
│           ├── employer.js           ← loginEmployer, submitFROI, previewEmployee
│           ├── providers.js          ← fetchProviders(zipCode, limit)
│           ├── rfas.js               ← fetchRFAs, submitRFA, approveRFA, routeToURO
│           ├── reporting.js          ← loss run, employer summary, experience mod, missed deadlines
│           ├── qme.js                ← panel lifecycle
│           ├── mmi.js                ← MMI signals, PR-4, response
│           ├── pd.js                 ← calculatePD, advances, stipulation, EAMS
│           ├── settlement.js         ← M19: MSA screen, stip value, C&R price, compare offers
│           └── notices.js            ← fetchNotices, sendDenialNotice
├── backend/                          ← Express (Node.js) API
│   ├── src/
│   │   ├── constants.js              ← CLAIM_STATUSES, SUBROGATION_STATUSES, DOCUMENT_CATEGORIES
│   │   ├── index.js                  ← Express app entry point (port 3001)
│   │   ├── config.js                 ← Environment variables
│   │   ├── logger.js                 ← Structured JSON logging (Winston)
│   │   ├── services/
│   │   │   ├── supabase.js           ← Service-role + anon-key clients
│   │   │   ├── filehandler.js        ← FileHandler Enterprise client (to be replaced by A1)
│   │   │   ├── adp.js                ← ADP OAuth2 client + AWW/TD calculation
│   │   │   ├── claimService.js       ← Claim lifecycle orchestration
│   │   │   ├── rfaService.js         ← M7: RFA lifecycle and routing
│   │   │   ├── enlyteService.js      ← Enlyte URO stub
│   │   │   ├── lobService.js         ← Lob.com print & mail stub
│   │   │   ├── noticeService.js      ← M9: 5 CA WC statutory notice generators
│   │   │   ├── reportingService.js   ← M10: loss run, summary, exp mod, missed deadlines
│   │   │   ├── qmeService.js         ← M11: QME/AME panel lifecycle
│   │   │   ├── supplementalRequestService.js ← M11: QME report AI evaluation
│   │   │   ├── mmiService.js         ← M12: MMI signals + PR-4 solicitation
│   │   │   ├── pdService.js          ← M13/M19: PD calculation, advances, stip, stipValue
│   │   │   ├── msaScreeningService.js ← M19: Medicare/SSDI/age gate
│   │   │   ├── pdPricingService.js   ← M19: C&R AI pricing + guardrails
│   │   │   ├── aiService.js          ← Claude API wrapper
│   │   │   ├── pdfService.js         ← DWC-1, AI reasoning, auth letter (pdf-lib)
│   │   │   ├── appointmentService.js ← MPN appointment booking
│   │   │   ├── providerService.js    ← Provider search by zip + specialty
│   │   │   ├── db.js                 ← Legacy in-memory (mostly retired)
│   │   │   ├── notificationService.js ← SendGrid magic-link email
│   │   │   └── voiceService.js       ← Whisper transcription + Claude extraction
│   │   ├── routes/
│   │   │   ├── claims.js             ← /api/v1/claims
│   │   │   ├── rfas.js               ← /api/v1/rfas
│   │   │   ├── employer.js           ← /api/v1/employer
│   │   │   ├── reporting.js          ← /api/v1/employers/:id/loss-run, etc.
│   │   │   ├── qme.js                ← /api/v1/qme
│   │   │   ├── mmi.js                ← /api/v1/mmi
│   │   │   ├── pd.js                 ← /api/v1/pd
│   │   │   ├── settlement.js         ← /api/v1/claims/:id/ (M19)
│   │   │   ├── providers.js
│   │   │   ├── appointments.js
│   │   │   ├── voice.js
│   │   │   ├── documents.js
│   │   │   ├── auth.js
│   │   │   └── webhooks.js
│   │   └── middleware/
│   │       ├── auth.js               ← JWT + role enforcement + requireMFA stub
│   │       └── audit.js              ← Request audit logging
│   ├── prompts/
│   │   ├── compensability_analysis.txt
│   │   ├── rfa_mtus_evaluation.txt
│   │   └── cnr_pricing.txt           ← M19: C&R pricing
│   ├── mocks/
│   │   ├── mock_adp.py
│   │   └── mock_filehandler.py
│   ├── tests/
│   │   ├── setup.js
│   │   ├── __mocks__/supabaseClient.js
│   │   ├── unit/
│   │   └── integration/
│   ├── package.json
│   └── .env.example
├── supabase/
│   └── migrations/
│       ├── 20260101000001_initial_schema.sql
│       ├── 20260101000002_seed_data.sql
│       ├── 20260101000003_enable_rls.sql
│       ├── 20260101000004_missing_tables.sql
│       ├── 20260101000005_m6_retrofit.sql
│       ├── 20260101000006_m11_qme.sql
│       ├── 20260101000007_m12_mmi.sql
│       ├── 20260101000008_m13_pd.sql
│       └── 20260101000009_m19_settlement.sql
├── docs/
│   ├── architecture.md
│   ├── integrations.md
│   ├── regulatory.md
│   └── data-model.md
└── .github/workflows/ci.yml
```

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React (Vite) | Three portals: Admin, Employer, Employee |
| Backend | Express (Node.js) | REST API + background workers |
| Database | PostgreSQL via Supabase | Managed, row-level security |
| Auth | Supabase Auth + JWT | httpOnly cookies. Three roles: admin, employer, employee |
| AI Engine | Anthropic Claude API (`claude-sonnet-4-20250514`) | Compensability, reserves, RFA evaluation, diaries, C&R pricing |
| CMS / Ledger | A1 Tracker (decided; not yet implemented) | Currently FileHandler Enterprise. Rename deferred to M_a1 |
| HR / Payroll | ADP Workforce Now API | Mock in dev |
| UR / Pharmacy / Clinical | Enlyte/Mitchell (pending contract) | Mitchell WorkCenter UR + First Script PBM |
| Health Data | Manifest MedEx QHIO (pending DSA) | ADT notifications, clinical document queries |
| Print / Mail | Lob.com (not yet signed) | USPS first-class notice delivery |
| Email / SMS | SendGrid / Twilio | Magic links, notifications |
| PDF Generation | pdf-lib (server-side, no CDN) | DWC-1, AI reasoning, auth letters, notices |
| File Storage | Supabase Storage | Uploaded media, generated PDFs |

---

## Three User Portals

### 1. Employer Portal
- Accessible to: HR managers and risk managers at client home health agencies
- Auth: Email / password
- Key functions: Report new injury (FROI), send employee magic link, view active claims and status, experience mod dashboard
- Data scope: Their own account and claims only (row-level security enforced)

### 2. Employee Portal
- Accessible to: Injured workers
- Auth: Magic link (JWT, 72-hour expiry, single-use) — no password required
- Key functions: Complete injury intake (voice + text), upload photos/video, select and book MPN provider, sign DWC-1 electronically, view claim status and benefits
- Data scope: Their own claim only
- Design principle: Plain language. Reassuring. Pre-populated from ADP. Works on mobile.

### 3. Admin Console
- Accessible to: Supervising adjuster
- Auth: Email / password + MFA
- Key functions: Action queue (AI-surfaced edge cases only), claim review, RFA approval/routing, diary management, notice center, A1 push, employer reporting
- Design principle: Dense, fast, information-complete. Built for expert users only.

---

## Automated Claim Lifecycle

The following sequence executes automatically on every new claim. No human action required unless the system flags an exception.

```
T+0:00   Employer submits FROI  OR  employee opens magic link
T+0:30   ADP pull → demographics, pay history, AWW, TD rate calculated
T+0:35   Claim record created in PostgreSQL + A1 via REST API
T+1:00   Claude AI analysis → compensability, reserves, priority, red flags, actions
T+1:30   AI reasoning PDF generated (pdf-lib) → pushed to A1 document store
T+2:00   MPN provider search (3 options by home zip) → employee selects + books
T+2:05   Authorization letter generated → emailed + faxed to facility
T+2:10   DWC-1 pre-filled → sent to employee for e-signature
T+2:15   DxF roster enrollment → Manifest MedEx passive monitoring begins
T+2:20   Required notices queued in Lob.com (DWC-7, benefit notice per LC §4650)
T+2:25   Initial diary set generated (all statutory deadlines)
T+2:30   Employer notification sent

--- Ongoing (event-driven) ---

ADT received         → Clinical document query fired → Claude reads → claim updated
PR-2 received        → Work status parsed, diaries updated, RFA extracted if present
RFA received         → MTUS evaluation → auto-approve OR package for Enlyte URO
URO determination    → Logged, communicated to provider + worker, diary closed
Lab results received → Claude reads, flags abnormal results, updates claim
TD payment due       → Amount calculated, benefit notice generated, Lob queued
Diary approaching    → Escalation timer starts (48hr warning → adjuster notification)
```

---

## Key Regulatory Constraints

Full details in `docs/regulatory.md`. Statutory deadlines are hardcoded in `businessDays.js` (business days) or plain date arithmetic (calendar days).

| Rule | Requirement | Consequence of Violation |
|---|---|---|
| LC §3600 | AOE/COE — injury must arise out of and occur in course of employment | Non-compensable |
| LC §4600 | MPN required to direct medical care | Loss of right to direct treatment |
| LC §4610 | UR must have licensed Medical Director; RFA response within 5 business days | Penalties, void UR decisions; treatment deemed approved |
| LC §4610(b) | First 30 days post-injury: no prospective UR for MTUS-consistent MPN treatment | Treatment cannot be prospectively denied |
| LC §4610.5 | Denied UR → IMR rights notice required; 30 cal day filing window | WCAB sanctions; IMR right forfeited |
| LC §4650 | First TD payment within 14 days of knowledge of disability | 10% self-imposed penalty |
| LC §4650(b) | PD advances within 14 cal days of TD end when PD anticipated | 10% penalty, CRITICAL no_snooze |
| LC §5401.7 | DWC-7 Notice of Rights within 5 days | CDI regulatory action |
| LC §5402 | Accept or deny claim within 90 calendar days | Presumed compensable |
| CCR §9785 | PR-2 within 5 working days of exam | WCAB sanctions |
| CCR §9792.9.1 | RFA standard 5 business days; expedited 72 hours | Treatment deemed approved |
| CCR §35 | QME report within 30 cal days of appointment | WCAB sanctions |

### Hardcoded Architectural Rules

- **AI may APPROVE RFAs. AI may NEVER DENY.** Denial always requires licensed physician (DWC FAQ, LC §4610)
- **Surgical CPT codes (10000-69999 + Category III 0001T-0999T) always route to URO**
- **TD cannot be suspended without written notice and adjuster license decision**
- **No auto-deny path anywhere in codebase — enforced architecturally**
- **DWC I&A block in every unrepresented worker letter — structurally enforced as unbypassable template wrapper**
- **Incomplete RFA: clock starts on receipt regardless of form completeness — never defer deadline for a deficiency**
- **All A1 sync failures: queue for retry, never block operations**
- **EAMS filing: manual — no API exists**
- **7-year audit log retention (CA WC regulations)**

---

## AI Decision Framework

### Compensability Analysis
Claude evaluates: mechanism vs. accepted body part, AOE/COE indicators, prior claims history, witness statements, medical consistency, `employerContests` flag, `motorVehicleFields` (going-and-coming rule, third-party liability).

Returns: compensability rating (Likely / Questionable / Non-Compensable), confidence score 0-100, red flags (including `SUBROGATION_POTENTIAL` when another vehicle was involved), recommended actions, analysis narrative.

### Reserve Recommendations
Claude calculates initial reserves based on: injury type, body part, time off work, AWW/TD rate, medical treatment to date, presence of surgical indicators. Reserves are suggestions — final authority is always the adjuster.

### RFA / MTUS Evaluation

Claude compares the requested treatment against MTUS/ACOEM guidelines for the accepted diagnosis. `rfaService._resolveDecision()` applies the following routing logic in order:

1. **Surgical CPT override → route to URO:** Any CPT code in the surgical range (10000–69999) or Category III codes (`\d{4}T`) is unconditionally routed to Enlyte URO, regardless of AI recommendation. A physician must authorize surgical procedures.
2. **Auto-approve:** AI recommends `auto_approve` (MTUS-consistent, within frequency/duration limits). Decision recorded immediately; `RFA_RESPONSE_DUE` diary closed.
3. **Route to URO:** AI recommends `physician_review` AND treatment is MTUS-inconsistent. Packaged and submitted to Enlyte; `enlyte_referral_id` recorded.
4. **Adjuster review:** AI recommends `physician_review` but treatment IS MTUS-consistent. Queued as `pending_adjuster_review` for human decision.
5. **Defer:** AI evaluation fails (API error, parse failure). Flagged for manual triage; never auto-approved on error.

> **Critical:** Only a licensed physician may modify or deny an RFA (DWC FAQ). Claude may only approve. The Enlyte URO physician modifies or denies. This constraint is enforced in code — `rfaService` has no denial path.

### C&R Pricing (M19)
AI provides a value range with rationale — never a single recommendation. The `cnr_pricing.txt` prompt forces `"recommendation": "adjuster_review"` output field. Factors: future medical projection based on MMI and body part, value of closing medical rights, worker age/earning capacity, apportionment, MMI status. Human adjuster prices from the AI range.

### Diary Generation
Claude generates diary descriptions only — all statutory dates are calculated by code (`businessDays.js` or plain date arithmetic), never by AI.

---

## Milestones

**Current test count: 781 passing (43 suites — unit + integration)**

| Milestone | Description | Status |
|---|---|---|
| M1 | Foundation: Express backend, FileHandler/ADP clients, auth middleware, CI, mocks, test suite | ✅ Complete |
| M2 | Employee intake: Voice (Whisper), media upload, provider finder, appointment booking, DWC-1, i18n (EN/ES) | ✅ Complete |
| M3 | Admin console: Action queue, AI analysis (backend-only), reserve approval, diaries, reasoning PDF, React Query | ✅ Complete |
| M4 | Employer portal: FROI submission, magic link, employer email/password auth, claim RLS, DELAY_NOTICE_DUE diary | ✅ Complete |
| M5 | Supabase swap: Replace in-memory Maps with PostgreSQL; migrations; in-memory mock for tests | ✅ Complete |
| M6 retrofit | Schema additions: `employer_contests`, `motor_vehicle_fields`, `subrogation_status`, `future_medical_only`, document indexing, `automation_config` + `supplemental_requests` tables | ✅ Complete |
| M7 | RFA engine: MTUS evaluation, `_resolveDecision` routing, Enlyte stub, diary lifecycle | ✅ Complete |
| M9 | Notice Center: `lobService` stub, 5 CA WC notice generators, triggers wired, DWC I&A block structurally enforced | ✅ Complete |
| M10 | Reporting: Employer dashboard, loss run + CSV, experience mod, cross-employer view, missed deadline compliance | ✅ Complete |
| M11 | QME/AME: Panel lifecycle, 10 cal day strike deadline (LC §4062.2), supplemental report AI evaluation | ✅ Complete |
| M12 | MMI management + PR-4 solicitation: AI 7-signal evaluation, PR-4 letter, 30 cal day response, apportionment tracking | ✅ Complete |
| M13 | Stipulation + PD closure + PD advances: PDRS lookup, PD calc with apportionment, 14 cal day advances (LC §4650(b), CRITICAL no_snooze), stip lifecycle, EAMS filing, closure | ✅ Complete |
| M19 | Settlement foundation: MSA screening gate, C&R AI pricing with guardrails, PDRS extension, `calculateStipValue` wrapper, settlement_offers table | ✅ Complete |
| M14 | Compromise and Release (no MSA only): offer → accept → sign → EAMS → OACR → paid lifecycle, MSA gate on pricing, CCR §10880 30-day payment due (CRITICAL no_snooze), C&R closes claim (no future medical) | ✅ Complete |
| M14.5 | Award Response, Disbursement Queue & Advance Cap Retrofit: WCAB award extraction (Claude PDF), DEU Template B commutation, disbursement bundle (accrued + scheduled + AA fee + §5800 interest), `pd_advance_payments` per-week tracking, represented 85% / unrepresented 100% advance cap with adjuster override, `claims.p_and_s_date` first-class column with source priority, `recordEAMSFiled` premature-closure fix | ✅ Complete |
| M22A | California WCIS EDI FROI/SROI transmission infrastructure: trigger queue, payload assembly for 19 MTCs (FROI 00/04/AU/01/02/CO + SROI IP/AP/CA/CB/RE/FS/Sx-Px/PY/04/4P/CD/02/FN/CO + scaffolded RB/UR), validation per guide Section K/L (structural, CA edits, referential), stubAdapter with synthetic 824 acks + stub JCN sequence, sftpAdapter/vendorAdapter scaffolds, deadline monitor + queue scanner + ack poller cron, admin routes, C&R breakdown columns on settlement_offers with DN85 5xx three-line PY payload. Event hooks wired on claimService.createClaim / updateStatus, pdService.initiatePDAdvances / recordPDAdvancePayment, cnrService.recordPayment, disbursementService.recordDisbursementPayment. tdService hooks, SROI 02 representation, FROI AU, SROI CD deferred with TRIGGER_EVENT_TO_MTC entries scaffolded for future wire-up. Migrations 20260102000010 + 20260102000011 not applied — SQL for review | ✅ Complete |
| tdService (PARTIAL) | TD period tracking + admin drawer visibility (data + UI; WCIS triggers deferred). See "tdService milestone (PARTIAL — period tracking shipped)" below for shipped/remaining breakdown. Migration 20260102000012 not applied — SQL for review | 🟡 Partial |

---

### tdService milestone (PARTIAL — period tracking shipped)

> Master_Context.md (the canonical "Deferred tasks" log) is internal and not in this repo. This subsection mirrors the equivalent entry so the in-repo state of tdService is searchable.

**Shipped 2026-05-09:** First-class `td_periods` table, `tdPeriodsService.js` with full CRUD + reinstatement + summary aggregations, 6 REST routes, ClaimDrawer Benefits tab with summary card / timeline / period table / Start modal, AdminDashboard columns for active benefit and 104-week cap progress, auto-completion of `TD_PAYMENT_SETUP` diary on first period, `audit_log` entries on every mutation, `claim_event` entries for `td_period_started` / `td_period_closed` / `td_period_reinstated`.

**Remaining for full milestone:**

- WCIS SROI trigger wiring per state change (IP / CA / CB / Sx / Px / RB / RE / FS) — hooks in service file mark the exact MTC mappings; needs `wcisTriggerService.enqueue` calls.
- DWC-9 / SROI 02 generation on benefit changes.
- LC §4650(d) self-imposed-penalty automation for late TD payments.
- Salary continuation specifics (rare in home health).
- Constraint of `suspension_reason_code` to WCIS code list (currently free-text VARCHAR).
- 240-week severe-injury cap path (LC §4656(c)(3)) — currently hardcoded to 104 in `summary`.

---

## Historical Milestone Details

### M19 — Settlement Foundation

Test count grew from 287 → 302 (19 suites).

- **`supabase/migrations/20260101000009_m19_settlement.sql`** (applied, schema only — PDRS seed data intentionally excluded) — `ALTER TABLE pdrs_lookup` adds body_part, wpi_min, wpi_max, base_rating, age_adjustment_json, occupation_adjustment_json; `CREATE TABLE msa_screenings` with FK to claims (no CASCADE on delete); `CREATE TABLE settlement_offers` with nullable `msa_screening_id` (stip-only offers have no MSA screening).
- **`backend/src/services/msaScreeningService.js`** (new) — `screenMSA(claimId, projectedSettlementValue)`: Medicare eligible (65+ or SSDI) AND settlement >$25k, OR age ≥35 + settlement >$250k → required. Reads `ssdi_receiving` from employees table (M6 retrofit field).
- **`backend/src/services/pdPricingService.js`** (new) — `priceCnr(claimId)`: Claude AI with hardcoded `adjuster_review` recommendation (AI outputs range, human prices). `compareOffers(claimId)`: guardrails DONT_OFFER_CNR (cnr < stip × 1.15), REQUIRES_ADJUSTER_REVIEW (cnr > stip × 5), CNR_VIABLE, NO_CNR_PRICED.
- **`backend/src/services/pdService.js`** (extended) — `calculateStipValue` thin wrapper over existing `getPDEvaluation()`. Zero PDRS duplication.
- **`backend/src/routes/settlement.js`** (new) — 4 endpoints on `/api/v1/claims/:id/`, all admin-only.
- **`backend/prompts/cnr_pricing.txt`** (new) — Claude prompt for C&R pricing.
- **15 new tests:** 6 MSA gate combinations, 6 C&R pricing + guardrail tests, 3 integration tests.

### M13 — Stipulation + PD Closure + PD Advances

Test count grew from 275 → 287.

- **`supabase/migrations/20260101000008_m13_pd.sql`** — `pdrs_lookup` table, `pd_evaluations`, `pd_advances`, `stipulations` (full lifecycle: draft → sent → signed → EAMS filed → closed).
- **`backend/src/services/pdService.js`** (new) — Complete PD lifecycle:
  - `calculatePD(claimId, pr4Id, {apportionmentPercent})` — Fetches PR-4 WPI, PDRS table lookup, computes age at DOI, PD weekly rate using 2026 statutory tiers (1%-69.75%: $160-$290/wk; 70%+: $240-$435/wk), applies apportionment, writes `pd_evaluations`, updates claim status to `pd_evaluation`.
  - `initiatePDAdvances(claimId, pdEvaluationId, {tdEndDate})` — 14 CALENDAR days from TD end (LC §4650(b)). Creates CRITICAL `no_snooze: true` diary with 10% penalty warning. Never uses `addBusinessDays`.
  - `recordPDAdvancePayment` / `waivePDAdvance` — Documented waiver with audit log.
  - `createStipulation` — Generates pdf-lib document with: accepted body parts, PD%, total value, apportionment clause, future medical reservation, **LC §5405 statute of limitations with specific date** (DOI + 5 years), signature lines, **DWC I&A block** (structurally required via `_drawIABlock`). Writes `notices` table row.
  - `sendStipToWorker` — **Represented**: attorney action item diary only, never contacts worker directly. **Unrepresented**: lobService + 21-day follow-up diary.
  - `recordWorkerSignature` / `recordAdjusterSignature` — EAMS package preparation.
  - `recordEAMSFiled` — Sets claim status to `closed` (no future medical) or `future_medical_only` (future medical reserved). EAMS filing is always manual.
- **`backend/src/routes/pd.js`** (new) — 10 endpoints, all `requireRole(['admin'])`.
- **`backend/tests/integration/pd.test.js`** (12 tests) — calculatePD writes row + apportionment; claim status → pd_evaluation; PD advance 14 cal days + CRITICAL no_snooze; waive writes audit log; EAMS filed → closed / future_medical_only; represented worker → attorney action item only; LC §5405 in notices table.

### M12 — MMI Management + PR-4 Solicitation

Test count grew from 263 → 275.

- **`supabase/migrations/20260101000007_m12_mmi.sql`** — `mmi_evaluations` (signals JSONB, recommendation, adjuster_action), `pr4_solicitations` (solicitation/response tracking, WPI, work_restrictions, future_medical, apportionment_noted).
- **`backend/src/services/mmiService.js`** (new):
  - `evaluateMMISignals(claimId)` — Calls Claude with claim snapshot. Evaluates 7 weighted signals (claim_age_exceeds_typical, pr2_stable_plateau, treatment_frequency_declining, rfas_shifting_maintenance, td_over_90_days_soft_tissue, td_104_week_approaching, no_active_treatment). Returns recommendation: no_action / monitor / solicit_pr4. Creates diary per recommendation level. **Never auto-changes claim status.**
  - `solicitPR4` — Generates PR-4 letter (pdf-lib, WPI per AMA 5th Ed, apportionment per LC §4663/4664), sends via lobService, 30 cal day response deadline.
  - `recordPR4Response` — Closes response due diary, creates review diary. If `apportionmentNoted`: flags QME/AME may be needed.
  - `dismissMMIEvaluation` — Sets adjuster_action = dismissed with audit log.
- **`backend/src/routes/mmi.js`** (new) — 6 endpoints, admin-only.
- **`backend/tests/integration/mmi.test.js`** (12 tests).

### M11 — QME/AME Process Management

Test count grew from 246 → 263.

- **`supabase/migrations/20260101000006_m11_qme.sql`** — `qme_panels` table, `diaries.no_snooze BOOLEAN` column for CRITICAL strike deadlines.
- **`backend/src/services/qmeService.js`** (new):
  - `requestPanel(claimId, specialty, adjusterNotes)` — Creates panel row + CRITICAL diary.
  - `issuePanel(panelId, {panelIssuedDate, doctor1, doctor2, doctor3})` — **10 CALENDAR days** strike deadline (LC §4062.2, NOT business days). CRITICAL `no_snooze: true` diary.
  - `recordStrikes(panelId, {strike1Npi, strike2Npi})` — Validates NPIs, derives remaining doctor, rejects same-doctor-twice.
  - `scheduleAppointment(panelId, {appointmentDate})` — 30 calendar day report due (CCR §35).
  - `recordReportReceived(panelId)` — Triggers supplemental report AI evaluation (fire-and-forget).
- **`backend/src/services/supplementalRequestService.js`** (new) — `evaluateQmeReport(panelId)`: Claude identifies gaps (apportionment, future medical, work restrictions, body parts, PR-2 contradictions), drafts supplemental request letter, writes `supplemental_requests` row.
- **`backend/src/routes/qme.js`** (new) — 10 endpoints, admin-only.
- **`backend/tests/integration/qme.test.js`** (17 tests).

### M10 — Reporting

Test count grew from 226 → 246.

- **`backend/src/services/reportingService.js`** (new) — 5 query functions:
  - `getLossRun(employerId)` — All claims with reserve totals (adjuster reserves preferred, AI-suggested fallback).
  - `getEmployerSummary(employerId)` — Open claim count, total incurred YTD, TD weeks paid YTD, average days to first payment.
  - `getExperienceModInputs(employerId)` — Payroll by class code (8827/8835/8742 for home health), losses by class code, 5-year loss trend, WCIRB experience period.
  - `getCrossEmployerReport()` — Admin-only: all employers aggregated.
  - `getMissedDeadlineReport()` — Admin-only: TD late (>14 days, LC §4650), DWC-7 late (>5 days), RFA expired.
- **`backend/src/routes/reporting.js`** (new) — 5 GET endpoints with employer scope enforcement.
- **`backend/tests/integration/reporting.test.js`** (20 tests).

### M9 — Notice Center

Test count grew from 212 → 226.

- **`backend/src/services/lobService.js`** (new) — Lob.com stub. `sendLetter` returns `{ letterId: 'ltr_MOCK-{ts}', status: 'queued', estimatedDelivery }`. One-line flag swap to production: set `LOB_LIVE=true` and provision `LOB_API_KEY`.
- **`backend/src/services/noticeService.js`** (new) — Five CA WC statutory notice generators, all server-side pdf-lib:
  - `generateDwc7(claimId)` — DWC-7 Notice of Rights per LC §5401.7. 5 business day deadline.
  - `generateTdNotice(claimId)` — TD benefit notice per LC §4650. AWW/TD breakdown, 14 cal day deadline, 104-week cap.
  - `generateRfaLetter(rfaId)` — RFA determination letter per 8 CCR §9792.9.1. Decision-aware: approval, denial + IMR rights (Maximus contact, 30-day deadline), or status.
  - `generateImrRightsNotice(rfaId)` — IMR rights notice per LC §4610.5. 30 cal day filing deadline.
  - `generateDenialNotice(claimId, adjusterId)` — Claim denial. **Hard guard**: throws if `adjusterId` missing/empty/whitespace.
  - **DWC I&A block**: `_drawIABlock()` called directly from every generator — structurally hardcoded.
- **`backend/src/services/claimService.js`** — Step 8 (new): after AI analysis, fire-and-forget `generateDwc7(claimId)` via `setImmediate`. Errors caught and logged, never rethrown.
- **`backend/src/services/rfaService.js`** — Notice triggers: `evaluateRFA` auto_approve → `generateRfaLetter`; route_to_uro → `generateRfaLetter` + `generateImrRightsNotice`; `adjusterApproveRFA` → `generateRfaLetter`; `adjusterRouteToURO` → both.
- **`backend/tests/unit/noticeService.test.js`** (14 tests).

### M7 — RFA Engine

- **`backend/src/services/rfaService.js`** (new) — Full RFA lifecycle:
  - `createRFA` — inserts RFA, calculates deadline (5 business days / 72 hours), seeds `RFA_RESPONSE_DUE` diary, logs event, triggers async AI evaluation.
  - `evaluateRFA` — fetches claim, calls aiService, persists `rfa_evaluations`, routes via `_resolveDecision`.
  - `_resolveDecision` — surgical CPT override → URO; AI auto_approve → approve; MTUS-inconsistent → URO; MTUS-consistent + physician_review → adjuster queue.
  - `_isSurgical` — CPT 10000–69999 + Category III.
  - `adjusterApproveRFA`, `adjusterRouteToURO`.
- **`backend/src/services/enlyteService.js`** (new) — Enlyte stub. Returns `ENL-MOCK-{timestamp}` referral IDs.
- **`backend/src/routes/rfas.js`** (new) — 5 endpoints with JWT auth.
- **`backend/tests/integration/rfa-engine.test.js`** (45 tests) — `_isSurgical` (9), `_resolveDecision` (5), `_calcDeadline` (2), HTTP endpoints, all 4 decision paths.

### M6 — Schema Retrofit

Purely additive. Test count grew from 197 → 212.

- **Migration additions:** `employees.ssdi_receiving` (LC §4661.5), `claims.employer_contests`, `claims.motor_vehicle_fields` (JSONB), `claims.subrogation_status` (CHECK), `future_medical_only` status, `documents` indexing columns, `automation_config` and `supplemental_requests` tables.
- **`backend/src/constants.js`** (new) — `CLAIM_STATUSES`, `SUBROGATION_STATUSES`, `DOCUMENT_CATEGORIES` (11 values).
- **`backend/src/services/claimService.js`** — Step 6.5: if `injuryType === 'Motor Vehicle'`, set `subrogation_status = 'under_evaluation'`.
- **`backend/src/services/aiService.js`** — `analyzeCompensability` payload includes `employerContests` and `motorVehicleFields`.
- **`frontend/src/App.jsx`** — PHI disclaimer on MediaUploader; motor vehicle AOE/COE conditional block; label cleanup (FileHandler → CMS).
- **Tests:** m6-schema.test.js (9 tests), claim-flow.test.js (+5 M6 tests).

### M5 — Supabase Swap

- **`backend/src/services/supabase.js`** (new) — Service-role + anon-key clients. `verifyConnection()` on startup.
- **`backend/src/services/claimService.js`** — All persistence from in-memory Maps to Supabase queries.
- **Migrations:** initial_schema, seed_data, enable_rls.
- **`backend/tests/__mocks__/supabaseClient.js`** (new) — In-memory Supabase mock for Jest.

### M4 — Employer Portal

- **`backend/src/routes/auth.js`** — `POST /api/v1/auth/employer/login`, `GET /api/v1/auth/dev-employer-session` (blocked in production).
- **`backend/src/routes/employer.js`** (new) — `POST /api/v1/employer/froi` (auth-guarded, ADP pull, magic token), `GET /api/v1/employer/employee-preview/:adpEmployeeId`.
- **`backend/src/services/notificationService.js`** (new) — `sendMagicLinkEmail`: no-op without `SENDGRID_API_KEY`. PHI constraint: only claim number + employer name, no body part / AWW / diagnosis.
- **`backend/src/services/claimService.js`** — `filed_at` + `DELAY_NOTICE_DUE` diary at filed_at + 14 cal days (LC §4650/§4652).
- **Tests:** 18 integration tests.

### M3 — Admin Console

- **Security fix**: Removed `runAIAnalysis()` from browser (was exposing `ANTHROPIC_API_KEY`). AI now runs server-side via `POST /api/v1/claims/:id/analyze`.
- **`backend/src/routes/claims.js`** — Added `/analyze`, `/reasoning-pdf`, `/diaries` endpoints.
- **`backend/src/services/pdfService.js`** — `generateReasoningPDF` using pdf-lib.
- **`backend/src/middleware/auth.js`** — `requireMFA` stub.
- **`frontend/src/App.jsx`** — React Query; ActionQueue component; ClaimDrawer with reserve approval form, diaries, status transitions.
- **Tests:** 27 integration tests.

### M2 — Employee Intake

- **`backend/src/services/voiceService.js`** — OpenAI Whisper + Claude structured extraction.
- **`backend/src/services/providerService.js`** — MPN search by zip, distance, specialty, walk-in.
- **`backend/src/services/appointmentService.js`** — Appointment lifecycle.
- **`backend/src/services/pdfService.js`** — `generateDWC1`, `generateAuthorizationLetter` (pdf-lib).
- **`frontend/src/App.jsx`** — `EmployeeIntakeWizard` (6 steps). Full EN/ES localization.
- **`backend/utils/businessDays.js`** — All 15 CA statutory holidays.
- **Tests:** 23 integration tests.

### M1 — Foundation

- **`backend/src/services/filehandler.js`** — Full FileHandler Enterprise client with retry.
- **`backend/src/services/adp.js`** — ADP OAuth2 client, 26-period pay statement pull, CA LC §4453 AWW calculation, 2026 TD rate (floor $252.03 / ceiling $1,680.29).
- **`backend/src/services/claimService.js`** — Full FROI → ADP → FileHandler → diaries → async Claude analysis.
- **`backend/src/services/aiService.js`** — Claude API wrapper. Hard-rejects non-JSON.
- **REST API**: `/api/v1/claims` + webhook receivers.
- **Middleware:** JWT auth, role enforcement, audit logging.
- **Mocks:** Mock ADP (7 test employees), Mock FileHandler (full in-memory ledger, `/mock/reset`).
- **`.github/workflows/ci.yml`** — GitHub Actions CI with mocks + Jest.

---

## Development Principles

1. **Every claim is a data asset.** Structured fields everywhere. No free-text where typed data belongs. Schema decisions made now determine ML capability in year 3.

2. **The system of record is A1 (FileHandler until M_a1).** Our database is operational state. A1 is the auditable financial ledger. When they conflict, A1 wins.

3. **AI recommends, humans authorize decisions that require a license.** Approvals by non-physicians: legal. Denials or modifications: physician only (DWC). This constraint is hard-coded into the RFA routing logic and applies across all milestones.

4. **Audit trail on everything.** Every AI decision, every human override, every API call to A1 is logged with timestamp, user, and rationale. DWC PAR audits are a reality.

5. **Mobile-first for employee and employer portals.** Most injured home health workers will complete intake on a phone. Design and test there first.

6. **Fail safe, not fail open.** If the AI is uncertain, escalate to human. Never auto-approve if confidence is below threshold. Never auto-deny under any circumstances.

7. **Regulatory data is never synthesized.** Fee schedules, PDRS values, statutory rates, form templates — always seeded from authoritative sources, never approximated by AI.

---

## Getting Started (Local Development)

```bash
git clone https://github.com/aksiomatixx/homecare-tpa.git
cd homecare-tpa
```

### Demo mode — one command (`npm run dev:demo`)

For an interview / walkthrough, the fastest path is the demo orchestrator:

```bash
cd backend && npm install && cd ..    # install backend deps once
cd frontend && npm install && cd ..   # install frontend deps once
npm run dev:demo                      # wipes demo data, seeds 8 claims, starts both servers
```

Then open http://localhost:5173. An amber banner at the top confirms demo mode is loaded and provides a one-click "Reset Demo" button (calls `POST /api/v1/admin/demo-reset`, admin-auth required, blocked when `NODE_ENV=production`).

The seed creates 8 fake claims spanning every lifecycle status (`new_claim` → `intake_complete` → `under_investigation` → `active_medical` ×2 → `p_and_s` → `pd_evaluation` → `settlement_discussions`), all flagged `metadata.demo = true`. PD evaluations use the values already in the `pdrs_lookup` seed (per the Regulatory Data Rule — no synthesized PDRS / fee-schedule / AWW figures).

| Script | Purpose |
|---|---|
| `npm run dev:demo` | db:reset + seed + dev (one-shot demo bootstrap) |
| `npm run db:reset` | Wipes only rows where `metadata.demo = true` (safe if mixed with real claims) |
| `npm run seed:demo` | Seeds the 8 demo claims (idempotent) |
| `npm run dev` | Spawns backend (3001) and frontend (5173) in parallel |
| `npm test` | Delegates to `backend/npm test` |

### Mock servers (optional — manual API exploration only)

The Jest test suite uses `jest.mock('axios')` and does not require external processes. The Python mock servers are only needed if you want to test raw ADP/FileHandler HTTP calls directly (e.g. with Postman or curl against a running backend).

```bash
pip install fastapi uvicorn pydantic

# Terminal 1 — Mock ADP (port 8001)
python backend/mocks/mock_adp.py

# Terminal 2 — Mock FileHandler (port 8002)
python backend/mocks/mock_filehandler.py
```

### Backend

```bash
cd backend
npm install
cp .env.example .env        # then fill in JWT_SECRET and ANTHROPIC_API_KEY
npm run dev                 # starts on port 3001
```

### Tests

```bash
cd backend
npm test                    # no external processes required
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Minimum required environment variables

```
JWT_SECRET=                 # any random 64-char hex string
ANTHROPIC_API_KEY=          # from console.anthropic.com

# Mock values — change only when connecting to real services
FILEHANDLER_API_KEY=mock-fh-key
FILEHANDLER_BASE_URL=http://localhost:8002
ADP_CLIENT_ID=mock
ADP_CLIENT_SECRET=mock
ADP_AUTH_URL=http://localhost:8001/auth/oauth/v2/token
ADP_BASE_URL=http://localhost:8001

# Optional — magic-link emails are no-op without this
SENDGRID_API_KEY=
FRONTEND_URL=http://localhost:5173

# Supabase (live database)
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
SUPABASE_ANON_KEY=
```

Full variable reference: `backend/.env.example`

---

## Questions / Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| Apr 2026 | GitHub Issues over email for specs | Searchable, version-controlled, linked to commits |
| Apr 2026 | PostgreSQL / Supabase | Structured claims data, row-level security, managed infra |
| Apr 2026 | FileHandler Enterprise as initial CMS | Purpose-built TPA ledger, auditable, WC-specific |
| Apr 2026 | Switch from FileHandler to A1 Tracker as CMS | Predictable pricing, shadow TPA portability, CDI succession plan evidence. Implemented in M_a1 |
| Apr 2026 | Manifest MedEx as QHIO | Largest CA nonprofit QHIO, covers 90%+ of CA population, free ADT network |
| Apr 2026 | Enlyte as URO | Dominant CA WC UR vendor, April 2026 regulation updates incorporated |
| Apr 2026 | C&R limited to no-MSA cases | MSA screening gate blocks C&R when required; stip only path |
| Apr 2026 | Patient photo screening removed | PHI disclaimer text instead; no AI vision pre-screening |

---

*HomeCare TPA — Confidential. For authorized contributors only.*
