# HomeCare TPA

> AI-first workers' compensation third-party administrator for California home health agencies.

## Overview

HomeCare TPA is a claims intelligence platform that automates 90%+ of routine WC claims administration tasks, surfacing only genuine edge cases to the supervising adjuster. It is not a workflow tool that makes adjusters faster — it is a system that replaces the repetitive administrative layer entirely while preserving licensed human judgment where California law requires it.

**Specialization:** California home health and home care agencies exclusively.  
**License requirement:** California CDI TPA license, CA WC Adjuster license (held by owner).  
**Regulatory framework:** California Labor Code, CCR Title 8, DWC regulations, MTUS/ACOEM guidelines.

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
│           ├── reporting.js          ← fetchLossRun, fetchEmployerSummary, fetchExperienceModInputs, fetchCrossEmployerReport, fetchMissedDeadlines
│           ├── qme.js                ← fetchPanelsForClaim, requestPanel, issuePanel, recordStrikes, scheduleQmeAppointment, markReportReceived
│           ├── mmi.js                ← evaluateMMISignals, fetchMMIEvaluations, solicitPR4, recordPR4Response, dismissMMIEvaluation
│           ├── pd.js                 ← calculatePD, initiatePDAdvances, createStipulation, sendStipToWorker, recordEAMSFiled
│           └── notices.js            ← (M9 pending) fetchNotices, sendDenialNotice
├── backend/                          ← Express (Node.js) API
│   ├── src/
│   │   ├── constants.js              ← Controlled vocabulary: CLAIM_STATUSES, SUBROGATION_STATUSES, DOCUMENT_CATEGORIES
│   │   ├── index.js                  ← Express app entry point (port 3001)
│   │   ├── config.js                 ← All environment variables
│   │   ├── logger.js                 ← Structured JSON logging (Winston)
│   │   ├── services/
│   │   │   ├── supabase.js           ← Supabase service-role + anon-key clients
│   │   │   ├── filehandler.js        ← FileHandler Enterprise client
│   │   │   ├── adp.js                ← ADP OAuth2 client + AWW/TD calculation
│   │   │   ├── claimService.js       ← Claim lifecycle orchestration + diaries + DWC-7 trigger
│   │   │   ├── rfaService.js         ← RFA lifecycle: create → AI eval → route/approve + notice triggers
│   │   │   ├── enlyteService.js      ← Enlyte URO stub (real API deferred to M_enlyte)
│   │   │   ├── lobService.js         ← Lob.com print & mail stub (LOB_LIVE flag for real API)
│   │   │   ├── noticeService.js      ← CA WC statutory notice generation (pdf-lib, 5 notice types)
│   │   │   ├── reportingService.js   ← M10: loss run, employer summary, experience mod, cross-employer, missed deadlines
│   │   │   ├── qmeService.js         ← M11: QME/AME panel lifecycle (request → issue → strikes → appointment → report)
│   │   │   ├── supplementalRequestService.js ← M11: AI-powered QME report evaluation + supplemental request drafting
│   │   │   ├── mmiService.js         ← M12: MMI signal detection (Claude AI), PR-4 solicitation (pdf-lib), response tracking
│   │   │   ├── pdService.js          ← M13: PD calculation (PDRS lookup), PD advances (LC §4650(b)), stipulation lifecycle, EAMS filing
│   │   │   ├── aiService.js          ← Claude API integration
│   │   │   ├── pdfService.js         ← DWC-1, AI reasoning, auth letter (pdf-lib)
│   │   │   ├── appointmentService.js ← MPN appointment booking
│   │   │   ├── providerService.js    ← Provider search by zip + specialty
│   │   │   ├── db.js                 ← In-memory DB helpers (legacy; replaced by Supabase)
│   │   │   ├── notificationService.js ← SendGrid magic-link email (no-op without API key)
│   │   │   └── voiceService.js       ← OpenAI Whisper transcription + Claude extraction
│   │   ├── routes/
│   │   │   ├── claims.js             ← /api/v1/claims (CRUD + analyze + pdf + diaries)
│   │   │   ├── rfas.js               ← /api/v1/rfas (create, list, approve, route-to-uro)
│   │   │   ├── employer.js           ← /api/v1/employer (FROI submission + employee preview)
│   │   │   ├── reporting.js          ← /api/v1/employers/:id/loss-run, /summary, /experience-mod-inputs + admin reports
│   │   │   ├── qme.js                ← /api/v1/qme (panel CRUD + supplemental requests)
│   │   │   ├── mmi.js                ← /api/v1/mmi (MMI evaluation + PR-4 solicitation)
│   │   │   ├── pd.js                 ← /api/v1/pd (PD calculation, advances, stipulation, EAMS filing)
│   │   │   ├── providers.js          ← /api/v1/providers
│   │   │   ├── appointments.js       ← /api/v1/appointments
│   │   │   ├── voice.js              ← /api/v1/voice (Whisper + text extraction)
│   │   │   ├── documents.js          ← /api/v1/documents
│   │   │   ├── auth.js               ← /api/v1/auth (magic link, employer login, dev-session)
│   │   │   └── webhooks.js           ← DxF ADT, Enlyte determination, Lob receivers
│   │   └── middleware/
│   │       ├── auth.js               ← JWT validation, role enforcement, requireMFA stub
│   │       └── audit.js              ← Request audit logging
│   ├── prompts/
│   │   ├── compensability_analysis.txt
│   │   └── rfa_mtus_evaluation.txt
│   ├── mocks/
│   │   ├── mock_adp.py               ← Mock ADP server (port 8001, FastAPI)
│   │   └── mock_filehandler.py       ← Mock FileHandler server (port 8002, FastAPI)
│   ├── tests/
│   │   ├── setup.js
│   │   ├── __mocks__/
│   │   │   └── supabaseClient.js     ← In-memory Supabase mock (Map-based, QueryBuilder)
│   │   ├── unit/
│   │   │   ├── adp.test.js
│   │   │   ├── filehandler.test.js
│   │   │   ├── businessDays.test.js
│   │   │   ├── providers.test.js
│   │   │   ├── m6-schema.test.js     ← M6: constants/enum validation (CLAIM_STATUSES, SUBROGATION_STATUSES, DOCUMENT_CATEGORIES)
│   │   │   └── noticeService.test.js ← M9: trigger wiring, denial guard, notices table writes (14 tests)
│   │   └── integration/
│   │       ├── claim-flow.test.js         ← Full FROI → ADP → FH → AI flow
│   │       ├── intake-flow.test.js        ← M2: appointments, MPN, intake-progress
│   │       ├── admin-console.test.js      ← M3: analyze, reserves, status, PDF, diaries
│   │       ├── employer-portal.test.js    ← M4: FROI, employer auth, RLS, magic link
│   │       ├── supabase-swap.test.js      ← M5: Supabase persistence + RLS policies
│   │       ├── rfa-engine.test.js         ← M7: RFA pipeline, routing, AI paths (45 tests)
│   │       ├── reporting.test.js          ← M10: loss run, employer isolation, admin access, missed deadlines (20 tests)
│   │       ├── qme.test.js               ← M11: QME panel lifecycle, strike deadline, calendar days (17 tests)
│   │       ├── mmi.test.js               ← M12: MMI signal evaluation, PR-4 solicitation, response (12 tests)
│   │       └── pd.test.js                ← M13: PD calculation, advances, stip lifecycle, EAMS filing (12 tests)
│   ├── package.json
│   └── .env.example
├── supabase/
│   └── migrations/
│       ├── 20260101000001_initial_schema.sql  ← Core tables (users → claims → events)
│       ├── 20260101000002_seed_data.sql       ← Employer + MPN provider seed data
│       ├── 20260101000003_enable_rls.sql      ← Row-level security policies
│       ├── 20260101000004_missing_tables.sql  ← rfas, rfa_evaluations, ai_decisions, notices, audit_log
│       ├── 20260101000005_m6_retrofit.sql     ← M6: employer_contests, motor_vehicle_fields, subrogation_status, document indexing, automation_config, supplemental_requests
│       ├── 20260101000006_m11_qme.sql        ← M11: qme_panels table + diaries.no_snooze column
│       ├── 20260101000007_m12_mmi.sql        ← M12: mmi_evaluations, pr4_solicitations tables
│       └── 20260101000008_m13_pd.sql         ← M13: pdrs_lookup (seeded), pd_evaluations, pd_advances, stipulations tables
├── docs/
│   ├── architecture.md               ← Full system design
│   ├── integrations.md               ← API integration specs
│   ├── regulatory.md                 ← California WC compliance requirements
│   └── data-model.md                 ← PostgreSQL schema documentation
└── .github/
    └── workflows/
        └── ci.yml                    ← GitHub Actions (Node 24, starts mocks, runs tests)
```

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React (Vite) | Three portals: Admin, Employer, Employee |
| Backend | Express (Node.js) | REST API + background workers |
| Database | PostgreSQL via Supabase | Managed, with row-level security |
| Auth | Supabase Auth | Three roles: admin, employer, employee |
| AI Engine | Anthropic Claude API (`claude-sonnet-4-20250514`) | Compensability, reserves, RFA evaluation, diaries |
| CMS / Ledger | FileHandler Enterprise (JW Software) | Authoritative financial record |
| HR / Payroll | ADP Workforce Now API | Demographics, wages, AWW calculation |
| Health Data | Manifest MedEx (QHIO / DxF) | ADT notifications, clinical document queries |
| Lab Data | Health Gorilla | Lab subscription, FHIR queries |
| UR | Enlyte UR Services | Physician review for non-MTUS RFAs |
| Print / Mail | Lob.com | USPS first-class notice delivery |
| PDF Generation | pdf-lib (server-side) | DWC-1, AI reasoning docs, auth letters — no CDN scripts |
| File Storage | Supabase Storage or S3 | Uploaded media, generated PDFs |
| Email / SMS | SendGrid / Twilio | Magic links, appointment confirmations, notifications |

---

## Three User Portals

### 1. Employer Portal
- Accessible to: HR managers and risk managers at client home health agencies
- Auth: Email / password
- Key functions: Report new injury (FROI), send employee magic link, view active claims and status, see experience mod dashboard
- Data scope: Their own account and claims only (row-level security enforced)

### 2. Employee Portal
- Accessible to: Injured workers
- Auth: Magic link (JWT, 72-hour expiry, single-use) — no password required
- Key functions: Complete injury intake (voice + text), upload photos/video, select and book MPN provider, sign DWC-1 electronically, view claim status and benefits
- Data scope: Their own claim only
- Design principle: Plain language. Reassuring. Pre-populated from ADP. Works on mobile.

### 3. Admin Console
- Accessible to: Supervising adjuster (Akash)
- Auth: Email / password + MFA
- Key functions: Action queue (AI-surfaced edge cases only), claim review and decision, RFA approval/routing, diary management, notice center, FileHandler push, employer reporting
- Design principle: Dense, fast, information-complete. Built for expert users only.

---

## Automated Claim Lifecycle

The following sequence executes automatically on every new claim. No human action required unless the system flags an exception.

```
T+0:00   Employer submits FROI  OR  employee opens magic link
T+0:30   ADP pull → demographics, pay history, AWW, TD rate calculated
T+0:35   Claim record created in PostgreSQL + FileHandler via REST API
T+1:00   Claude AI analysis → compensability, reserves, priority, red flags, actions
T+1:30   AI reasoning PDF generated (pdf-lib) → pushed to FileHandler document store
T+2:00   MPN provider search (3 options by home zip) → employee selects + books
T+2:05   Authorization letter generated → emailed + faxed to facility
T+2:10   DWC-1 pre-filled → sent to employee for e-signature (DocuSign or similar)
T+2:15   DxF roster enrollment → Manifest MedEx passive monitoring begins
T+2:20   Required notices queued in Lob.com (DWC-7, benefit notice per LC §4650)
T+2:25   Initial diary set generated in FileHandler (all statutory deadlines)
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

> **Full details in `docs/regulatory.md`. This is a summary for orientation.**

| Rule | Requirement | Consequence of Violation |
|---|---|---|
| LC §4600 | MPN required to direct medical care | Loss of right to direct treatment |
| LC §4610 | UR must have licensed Medical Director | Penalties, void UR decisions |
| LC §4610 | RFA response within 5 business days | Treatment deemed approved by law |
| LC §4610(b) | First 30 days post-injury: no prospective UR | Treatment cannot be prospectively denied |
| LC §4650 | First TD payment within 14 days | 10% self-imposed penalty on delayed amount |
| CCR §9785 | PR-2 due within 5 working days of exam | Compliance exposure, WCAB sanctions |
| CCR §9792.9.1 | Expedited UR (urgent): 72 hours | Treatment deemed approved |
| LC §4610.5 | Denied UR → IMR rights notice required | WCAB sanctions |
| DWC UR Plan | UR plan must be filed with DWC | All UR decisions potentially void |

---

## AI Decision Framework

### Compensability Analysis
Claude evaluates: mechanism vs. accepted body part, AOE/COE indicators, prior claims history, witness statements, medical consistency, `employerContests` flag, and `motorVehicleFields` (going-and-coming rule, third-party liability). Returns: compensability rating (Likely / Questionable / Non-Compensable), confidence score 0-100, red flags (including `SUBROGATION_POTENTIAL` when another vehicle was involved), recommended actions, analysis narrative.

### Reserve Recommendations
Claude calculates initial reserves based on: injury type, body part, time off work, AWW/TD rate, medical treatment to date, presence of surgical indicators. Reserves are suggestions — final authority is always the adjuster.

### RFA / MTUS Evaluation
Claude compares the requested treatment against MTUS/ACOEM guidelines for the accepted diagnosis. `rfaService._resolveDecision()` applies the following routing logic in order:

1. **Surgical CPT override → route to URO:** Any CPT code in the surgical range (10000–69999) or Category III codes (`\d{4}T`) is unconditionally routed to Enlyte URO, regardless of AI recommendation. A physician must authorize surgical procedures.
2. **Auto-approve:** AI recommends `auto_approve` (MTUS-consistent, within frequency/duration limits). Decision recorded immediately; `RFA_RESPONSE_DUE` diary closed.
3. **Route to URO:** AI recommends `physician_review` AND treatment is MTUS-inconsistent. Packaged and submitted to Enlyte; `enlyte_referral_id` recorded.
4. **Adjuster review:** AI recommends `physician_review` but treatment IS MTUS-consistent (e.g., at upper guideline limit, complex clinical picture). Queued as `pending_adjuster_review` for human decision.
5. **Defer:** AI evaluation fails (API error, parse failure). Flagged for manual triage; never auto-approved on error.

> **Critical:** Only a licensed physician may modify or deny an RFA (DWC FAQ). Claude may only approve. The Enlyte URO physician modifies or denies. This constraint is enforced in code — `rfaService` has no denial path.

### Diary Generation
Claude generates the diary set from claim facts at claim creation and updates diaries on every significant event. Diaries are created in FileHandler via API, not maintained in our database.

---

## Milestones

| Milestone | Description | Status |
|---|---|---|
| M1 | Foundation: Express backend, FileHandler client, ADP client, auth middleware, CI pipeline, mock servers, unit + integration test suite | ✅ Complete |
| M2 | Employee intake: Voice (Whisper), media upload, provider finder, appointment booking, DWC-1 (pdf-lib), i18n (EN/ES) | ✅ Complete |
| M3 | Admin console: Action queue, AI analysis (backend-only), reserve approval, diaries, reasoning PDF, React Query | ✅ Complete |
| M4 | Employer portal: FROI submission, magic link generation, employer email/password auth, claim RLS per employer, LC §4650/§4652 DELAY_NOTICE_DUE diary | ✅ Complete |
| M5 | Supabase swap: Replace in-memory Maps with PostgreSQL via Supabase; schema migrations; in-memory mock for tests; `supabase-swap.test.js` | ✅ Complete |
| M6 | Schema retrofit: `employer_contests`, `motor_vehicle_fields`, `subrogation_status`, `future_medical_only` status, document indexing columns, `automation_config` + `supplemental_requests` tables; MV subrogation logic; AI payload fields; PHI disclaimer; constants module | ✅ Complete |
| M7 | RFA engine: MTUS evaluation, `_resolveDecision` routing (surgical override, auto-approve, URO, adjuster queue), Enlyte stub, diary lifecycle | ✅ Complete |
| M8 | DxF / QHIO: Manifest MedEx roster enrollment, ADT push notifications, clinical document pull | 🔲 Not started |
| M9 | Notice Center: `lobService` stub, `noticeService` (5 CA WC notice types), fire-and-forget triggers in `claimService` + `rfaService`, DWC I&A block structurally hardcoded, denial guard, notices table + audit_log writes | ✅ Complete |
| M10 | Reporting: Employer dashboard (summary cards, loss run table + CSV export, experience mod trend chart), admin cross-employer view, missed deadline compliance report (TD/DWC-7/RFA) | ✅ Complete |
| M11 | QME/AME process management: Panel lifecycle (request → issue → strikes → doctor selected → appointment → report), 10 cal day strike deadline (LC §4062.2, no_snooze), supplemental report AI evaluation (Claude), supplemental request drafting | ✅ Complete |
| M12 | MMI management + PR-4 solicitation: AI signal detection (7 weighted signals), PR-4 letter generation (pdf-lib + lobService), response recording (WPI, restrictions, future medical, apportionment), 30 cal day response deadline | ✅ Complete |
| M13 | Stipulation + PD closure + PD advances: PDRS lookup table, PD calculation with apportionment, PD advances (14 cal day deadline LC §4650(b), CRITICAL no_snooze), stip document (pdf-lib + LC §5405 + DWC I&A), full signature chain, EAMS filing (manual), claim closure | ✅ Complete |
| M14 | Compromise and Release (no MSA only) | 🔲 Not started |

**Current test count: 287 passing** (16 suites — unit + integration)

### M13 — What was built (current)

Stipulation + PD Closure + PD Advances. No existing tests broken; test count grew from 275 → 287.

- **`supabase/migrations/20260101000008_m13_pd.sql`** (new, staged) — `pdrs_lookup` table (2005 PDRS with 5 seed rows: WPI 5/10/15/25/50% at age_factor 1.0, occupation_group 1), `pd_evaluations` (WPI, PD%, weeks, rate, total, apportionment), `pd_advances` (td_end_date, advance_due_date, weekly_rate, status), `stipulations` (full lifecycle: draft → sent → signed → EAMS filed → closed).
- **`backend/src/services/pdService.js`** (new) — Complete PD lifecycle:
  - `calculatePD(claimId, pr4Id, {apportionmentPercent})` — Fetches PR-4 WPI, PDRS table lookup, computes age at DOI, PD weekly rate using 2026 statutory tiers (1%-69.75%: $160-$290/wk; 70%+: $240-$435/wk), applies apportionment, writes `pd_evaluations`, updates claim status to `pd_evaluation`.
  - `initiatePDAdvances(claimId, pdEvaluationId, {tdEndDate})` — 14 CALENDAR days from TD end (LC §4650(b)). Creates CRITICAL `no_snooze: true` diary with 10% penalty warning. Never uses `addBusinessDays`.
  - `recordPDAdvancePayment` / `waivePDAdvance` — Documented waiver with audit log.
  - `createStipulation` — Generates pdf-lib document with: accepted body parts, PD%, total value, apportionment clause, future medical reservation, **LC §5405 statute of limitations with specific date** (DOI + 5 years), signature lines, **DWC I&A block** (structurally required via `_drawIABlock`). Writes `notices` table row.
  - `sendStipToWorker` — **Represented workers**: creates attorney action item diary only, never contacts worker directly, never calls lobService. **Unrepresented**: sends via lobService + 21-day follow-up diary.
  - `recordWorkerSignature` / `recordAdjusterSignature` — EAMS package preparation.
  - `recordEAMSFiled` — Sets claim status to `closed` (no future medical) or `future_medical_only` (future medical reserved). EAMS filing is always manual.
- **`backend/src/routes/pd.js`** (new) — 10 endpoints, all `requireRole(['admin'])`.
- **`frontend/src/services/pd.js`** (new) — Fetch wrappers for all PD endpoints.
- **`frontend/src/App.jsx`** — PD/Stip tab in ClaimDrawer: PD calculation card (WPI/PD%/total/apportionment), PD advances with overdue detection + 10% penalty warning, stipulation step progression (Draft→Sent→Worker Signed→Adjuster Signed→EAMS Ready→Filed→Closed), modals for all actions.
- **`backend/tests/integration/pd.test.js`** (new, 12 tests) — calculatePD writes row + applies apportionment (25% on 16% → 12%); claim status → pd_evaluation; PD advance 14 cal days + CRITICAL no_snooze; waive writes audit log; EAMS filed → closed (no future medical) or future_medical_only; represented worker → attorney action item only; LC §5405 in notices table.

### M12 — What was built

MMI Management + PR-4 Solicitation. No existing tests broken; test count grew from 263 → 275.

- **`supabase/migrations/20260101000007_m12_mmi.sql`** (new, staged) — `mmi_evaluations` (signals JSONB, recommendation, adjuster_action), `pr4_solicitations` (solicitation/response tracking, WPI, work_restrictions, future_medical, apportionment_noted).
- **`backend/src/services/mmiService.js`** (new) — MMI signal detection and PR-4 solicitation:
  - `evaluateMMISignals(claimId)` — Calls Claude with claim snapshot. Evaluates 7 weighted signals (claim_age_exceeds_typical, pr2_stable_plateau, treatment_frequency_declining, rfas_shifting_maintenance, td_over_90_days_soft_tissue, td_104_week_approaching, no_active_treatment). Returns recommendation: no_action (0 signals) / monitor (weight 1-3) / solicit_pr4 (weight ≥4 or two weight-2 signals). Creates diary per recommendation level. **Never auto-changes claim status.**
  - `solicitPR4(claimId, mmiEvaluationId, {physicianName, physicianFax, physicianAddress})` — Generates PR-4 solicitation letter (pdf-lib, requests WPI per AMA 5th Ed, apportionment per LC §4663/4664), sends via lobService, 30 calendar day response deadline.
  - `recordPR4Response(pr4Id, {wpi, workRestrictions, futureMedical, apportionmentNoted})` — Closes response due diary, creates review diary. If `apportionmentNoted`: additional diary flagging QME/AME may be needed.
  - `dismissMMIEvaluation(mmiEvaluationId, adjusterId, note)` — Sets adjuster_action = dismissed with audit log.
- **`backend/src/routes/mmi.js`** (new) — 6 endpoints, all `requireRole(['admin'])`.
- **`frontend/src/services/mmi.js`** (new) — Fetch wrappers for all MMI endpoints.
- **`frontend/src/App.jsx`** — MMI/P&S tab in ClaimDrawer: signal evaluation cards with weight indicators, recommendation badges (green/amber/red), rationale, solicit PR-4 modal, record response modal (WPI, restrictions, apportionment checkbox), PR-4 solicitations list with overdue detection.
- **`backend/tests/integration/mmi.test.js`** (new, 12 tests) — evaluateMMISignals writes row; solicit_pr4 creates diary; monitor creates diary; no_action creates no diary; solicitPR4 30 cal day due + calls lobService; recordPR4Response apportionment=true → 2 diaries; dismiss sets adjuster_action.

### M11 — What was built

QME/AME Process Management. No existing tests broken; test count grew from 246 → 263.

- **`supabase/migrations/20260101000006_m11_qme.sql`** (new, staged) — `qme_panels` table (3 doctors, strikes, selected doctor, appointment, report tracking, QME/AME track). `diaries.no_snooze BOOLEAN` column added for CRITICAL strike deadlines.
- **`backend/src/services/qmeService.js`** (new) — Full QME panel lifecycle:
  - `requestPanel(claimId, specialty, adjusterNotes)` — Creates panel row + CRITICAL diary.
  - `issuePanel(panelId, {panelIssuedDate, doctor1, doctor2, doctor3})` — **10 CALENDAR days** strike deadline (LC §4062.2, NOT business days). CRITICAL `no_snooze: true` diary.
  - `recordStrikes(panelId, {strike1Npi, strike2Npi})` — Validates NPIs in panel, derives remaining doctor, rejects same-doctor-twice.
  - `scheduleAppointment(panelId, {appointmentDate})` — 30 calendar day report due (CCR §35).
  - `recordReportReceived(panelId)` — Triggers supplemental report AI evaluation (fire-and-forget).
- **`backend/src/services/supplementalRequestService.js`** (new) — `evaluateQmeReport(panelId)`: Claude identifies gaps (apportionment, future medical, work restrictions, body parts, PR-2 contradictions), drafts supplemental request letter, writes `supplemental_requests` row. `approveAndSend` / `dismiss` for adjuster workflow.
- **`backend/src/routes/qme.js`** (new) — 10 endpoints (7 panel + 3 supplemental), all `requireRole(['admin'])`.
- **`frontend/src/services/qme.js`** (new) — Fetch wrappers.
- **`frontend/src/App.jsx`** — QME/AME tab in ClaimDrawer: step progression, red strike deadline warning (within 3 days), modals (request panel, record issue with 3 doctors, record strikes with checkboxes, schedule appointment), supplemental request review.
- **`backend/tests/integration/qme.test.js`** (new, 17 tests) — Panel lifecycle through all states; strike deadline = 10 cal days (Friday+10=Monday); no_snooze diary; NPI validation + same-doctor rejection; report_due = appt+30; AME track: no automated worker comms; auth guards.

### M10 — What was built

Reporting: Employer Dashboard + Loss Run + Admin Compliance. No existing tests broken; test count grew from 226 → 246.

- **`backend/src/services/reportingService.js`** (new) — 5 query functions:
  - `getLossRun(employerId)` — All claims with reserve totals (adjuster reserves preferred, AI-suggested fallback). Returns: claim number, worker, DOI, injury type, status, medical/indemnity/expense/total incurred, open/closed.
  - `getEmployerSummary(employerId)` — Open claim count, total incurred YTD, TD weeks paid YTD, average days to first payment.
  - `getExperienceModInputs(employerId)` — Payroll by class code (8827/8835/8742 for home health), losses by class code, 5-year loss trend data, WCIRB experience period.
  - `getCrossEmployerReport()` — Admin-only: all employers aggregated (total claims, open claims, total incurred).
  - `getMissedDeadlineReport()` — Admin-only: TD late (>14 days, LC §4650), DWC-7 late (>5 days), RFA expired (response_due_at passed with no decision).
- **`backend/src/routes/reporting.js`** (new) — 5 GET endpoints with employer scope enforcement (employers see own data only, admins see all).
- **`frontend/src/services/reporting.js`** (new) — Fetch wrappers.
- **`frontend/src/App.jsx`** — Employer portal "Reports" tab: summary cards, loss run table with CSV export, experience mod tables, 5-year loss trend CSS bar chart. Admin nav "Reports" tab: cross-employer overview, missed deadline compliance report with violation type breakdown.
- **`backend/tests/__mocks__/supabaseClient.js`** — Extended `_attachRelations` to join `reserves` table when claims are fetched with `select('*, reserves(*)')`.
- **`backend/tests/integration/reporting.test.js`** (new, 20 tests) — Loss run totals + AI reserve fallback; employer A cannot see employer B (403); admin sees all; summary aggregates; experience mod class codes + trend data; TD/DWC-7/RFA missed deadline detection; completed diaries and decided RFAs not flagged.

### M9 — What was built

Notice Center infrastructure sprint. No existing tests broken; test count grew from 212 → 226.

- **`backend/src/services/lobService.js`** (new) — Lob.com print & mail stub following the `enlyteService.js` pattern exactly. `sendLetter(noticeType, claimId, recipientRole, payload)` returns `{ letterId: 'ltr_MOCK-{ts}', status: 'queued', estimatedDelivery }`. `getLetterStatus(lobId)` returns `{ letterId, status: 'in_transit' }`. One-line flag swap to production: set `LOB_LIVE=true` and provision `LOB_API_KEY`. Both functions return the same shape as the real Lob API so `noticeService.js` needs no changes when live integration lands.

- **`backend/src/services/noticeService.js`** (new) — Five CA WC statutory notice generators, all server-side pdf-lib (no client-side PDF). Each generator: builds PDF, writes `notices` table row, calls `lobService.sendLetter`, writes `audit_log` entry (7-year retention per CA WC regs).
  - `generateDwc7(claimId)` — DWC-7 "Notice of Rights" per LC §5401.7 and 8 CCR §9810. 5 business day deadline from claim receipt.
  - `generateTdNotice(claimId)` — TD benefit notice per LC §4650. AWW and TD rate breakdown, 14 calendar day deadline, payment schedule, 104-week cap, worker obligations.
  - `generateRfaLetter(rfaId)` — RFA determination letter per 8 CCR §9792.9.1. Addressed to requesting physician (cc to injured worker). Decision-aware body: approval → authorized treatment; denial → MTUS rationale + full IMR rights (Maximus Federal contact, 30-day LC §4610.5 deadline); other → status update.
  - `generateImrRightsNotice(rfaId)` — IMR rights notice per LC §4610.5. 30 calendar day filing deadline. Complete Maximus Federal contact block (phone `1-888-845-7100`, fax, website, mailing address). WCAB appeal path if IMR upholds denial.
  - `generateDenialNotice(claimId, adjusterId)` — Claim denial notice. **Hard guard**: throws synchronously if `adjusterId` is missing, empty, or whitespace — no PDF generated, no DB write, no Lob call. `adjusterId` stamped in audit log and PDF footer. WCAB appeal rights and LC §5405 statute of limitations.
  - **DWC I&A block**: `_drawIABlock()` is called directly from every generator — structurally hardcoded, no conditional path can omit it (LC §5401.7, 8 CCR §9812). Block includes: DWC I&A Unit 1-800-736-7401, website, local office finder, CA State Bar referral.
  - **Shared helpers**: `_drawLetterhead()`, `_drawIABlock()`, `_writeAuditLog()`, `_formatDate()`, `_wrapText()`, `_getClaimService()` (lazy require to avoid circular dependency).

- **`backend/src/services/claimService.js`** — Step 8 (new): after AI analysis trigger, fire-and-forget `generateDwc7(claimId)` via `setImmediate`. Errors caught and logged, never rethrown — claim creation never blocks or fails on notice generation.

- **`backend/src/services/rfaService.js`** — `_getNoticeService()` lazy require + `_fireNotice(fn, ...args)` helper (wraps every call in `setImmediate` + `.catch(logger.error)`). Notice triggers added:
  - `evaluateRFA`: `auto_approve` → `generateRfaLetter`; `route_to_uro` → `generateRfaLetter` + `generateImrRightsNotice`
  - `adjusterApproveRFA` → `generateRfaLetter`
  - `adjusterRouteToURO` → `generateRfaLetter` + `generateImrRightsNotice`

- **`backend/tests/unit/noticeService.test.js`** (new, 14 tests):
  - **Trigger wiring**: spy pattern — real claimService and rfaService with mocked deps, spied noticeService, `drainSetImmediates()` flush. Verifies `generateDwc7` called after claim creation; `generateRfaLetter` called on `auto_approve` and `route_to_uro`; `generateImrRightsNotice` called on `route_to_uro`, NOT on `auto_approve`.
  - **Denial guard**: 4 variants — `undefined`, empty string, whitespace-only, no argument. All throw `'adjusterId is required'` before any side effects.
  - **Notices table writes**: all 5 notice types verified against the supabase mock store after calling each generator directly. Confirms `_drawIABlock` executed (it runs synchronously before the DB write, so a successful `notices` insert proves the I&A block rendered).

### M6 — What was built (previous)

Additive retrofit sprint. No existing tests broken; test count grew from 197 → 212.

- **`supabase/migrations/20260101000005_m6_retrofit.sql`** (new) — Purely additive schema changes applied to staging (`uhgrggmcrrsftpusdgwh`):
  - `employees.ssdi_receiving BOOLEAN` — LC §4661.5 TD offset flag; MSA screening at settlement (M11 will use this).
  - `claims.employer_contests BOOLEAN` — populated by employer acknowledgment form in a future milestone; surfaced to AI as a compensability risk factor.
  - `claims.motor_vehicle_fields JSONB` — AOE/COE intake answers: `driving_between_patients`, `other_vehicle_involved`, `police_responded` (each bool or null).
  - `claims.subrogation_status VARCHAR(30)` — CHECK constraint: `not_applicable` (default) | `under_evaluation` | `waived` | `referred` | `recovered`. Set to `under_evaluation` automatically on Motor Vehicle claims.
  - `claims` status CHECK — extended to include `future_medical_only` (RTW with ongoing medical, no indemnity).
  - `documents` indexing columns — `confidence SMALLINT`, `category VARCHAR(30)`, `title VARCHAR(300)`, `source_type VARCHAR(30)`, `dos_range_start/end DATE`, `dos_is_range BOOLEAN`; partial indexes on `confidence` and `category` for M8 document processing queue.
  - `automation_config` table — key-value store for automation level settings (M9 will seed this).
  - `supplemental_requests` table — QME/PR-4 supplemental report tracking with RLS (M11 will use this).
- **`backend/src/constants.js`** (new) — Single source of truth for all controlled-vocabulary fields: `CLAIM_STATUSES`, `SETTABLE_CLAIM_STATUSES`, `SUBROGATION_STATUSES` (matches migration CHECK), `DOCUMENT_CATEGORIES` (11 values). Claims route now imports from here instead of maintaining inline arrays.
- **`backend/src/services/claimService.js`** — Three changes:
  - `_toClaim()` maps new DB columns to JS shape (`motorVehicleFields`, `employerContests`, `subrogationStatus`).
  - `claimRow` insert persists `motor_vehicle_fields`, `employer_contests`, `subrogation_status: null`.
  - Step 6.5 (new): after diary seeding, if `froiData.injuryType === 'Motor Vehicle'`, update `subrogation_status` to `under_evaluation`.
- **`backend/src/services/aiService.js`** — `analyzeCompensability` payload now includes `employerContests` (bool, default `false`) and `motorVehicleFields` (object or null). Both fields pass through to Claude on every claim analysis.
- **`backend/prompts/compensability_analysis.txt`** — Added `INPUT FIELD NOTES` block before the output format instructions. Explains `employerContests` as a compensability risk factor requiring investigation (not determinative). Explains `motorVehicleFields` with going-and-coming rule exception for home health workers; instructs Claude to include `"SUBROGATION_POTENTIAL"` in `redFlags` when `other_vehicle_involved` is true.
- **`frontend/src/App.jsx`** — Three UI changes:
  - `MediaUploader`: PHI disclaimer div rendered above the drop zone — warns against uploading patient faces or identifying information. No AI vision logic.
  - `EMPTY_M2` + intake Step 1: `motorVehicleFields: null` added to form state; conditional block renders three yes/no/unknown `RadioGroup` questions (`driving_between_patients`, `other_vehicle_involved`, `police_responded`) when `injuryType === 'Motor Vehicle'`. Fields included in submission payload via form spread.
  - Label cleanup: "FileHandler Sync" → "CMS Sync"; "sent to FileHandler" → "synced to CMS".
- **`backend/tests/unit/m6-schema.test.js`** (new) — 9 tests validating the constants module: `future_medical_only` in `CLAIM_STATUSES`; `SUBROGATION_STATUSES` matches migration CHECK exactly (and rejects `pursuing`, `closed`, etc.); all 11 `DOCUMENT_CATEGORIES` present.
- **`backend/tests/integration/claim-flow.test.js`** — Added `jest.mock` for `aiService` (prevents live Claude calls; enables payload inspection). Five new M6 tests: MV claim sets `subrogationStatus: 'under_evaluation'`; MV claim passes `motorVehicleFields` to `analyzeCompensability`; non-MV claim passes `motorVehicleFields: null`; `employerContests: true` propagates to AI payload; unset `employerContests` defaults to `false`.

### M7 — What was built

- **`backend/src/services/rfaService.js`** (new) — Full RFA lifecycle orchestration:
  - `createRFA(claimId, rfaData, receivedVia)` — inserts RFA row, calculates statutory deadline (5 business days standard / 72 hours expedited per CCR §9792.9.1), seeds `RFA_RESPONSE_DUE` diary, logs `rfa_received` claim event, triggers async AI evaluation via `setImmediate`.
  - `evaluateRFA(rfaId)` — fetches RFA + claim, calls `aiService.evaluateRFA`, persists `rfa_evaluations` row, routes via `_resolveDecision`.
  - `_resolveDecision(aiResult, rfa, claim)` — surgical CPT override → URO; AI auto_approve → approve; MTUS-inconsistent → URO; MTUS-consistent + physician_review → adjuster queue.
  - `_isSurgical(cptCodes)` — CPT range 10000–69999 plus Category III (`/^\d{4}T$/i`).
  - `adjusterApproveRFA(rfaId, adjusterEmail)` — sets `adjuster_approved`, closes diary, logs `rfa_approved` event.
  - `adjusterRouteToURO(rfaId, adjusterEmail, reason)` — calls Enlyte, sets `sent_to_uro`, records `enlyte_referral_id`.
  - Lazy `require('./claimService')` inside functions to break circular dependency.
- **`backend/src/services/enlyteService.js`** (new) — Enlyte URO stub. `submitReferral()` returns `ENL-MOCK-{timestamp}` referral IDs and a calculated estimated response time. Real API deferred to M8 — service shape is final so `rfaService.js` won't need changes.
- **`backend/src/routes/rfas.js`** (new) — Five endpoints with JWT auth and express-validator:
  - `POST /api/v1/rfas` — create RFA (admin/adjuster only)
  - `GET  /api/v1/rfas?claimId=` — list RFAs for a claim
  - `GET  /api/v1/rfas?status=` — list by decision status, admin/adjuster only (powers RFA Queue)
  - `GET  /api/v1/rfas/:id` — get RFA with latest evaluation
  - `POST /api/v1/rfas/:id/approve` — adjuster approval
  - `POST /api/v1/rfas/:id/route-to-uro` — adjuster URO escalation
- **`backend/src/index.js`** — Registered `/api/v1/rfas` router.
- **`backend/prompts/rfa_mtus_evaluation.txt`** — Added `withinFrequencyLimits`, `withinDurationLimits`, `formularyStatus` to required AI JSON response structure.
- **`backend/tests/integration/rfa-engine.test.js`** (new) — 45 tests across 9 describe blocks: `_isSurgical` helper (9 cases), `_resolveDecision` routing (5 cases), `_calcDeadline` (2 cases), HTTP endpoint coverage for all 5 routes, and direct `evaluateRFA` pipeline tests for all four decision paths (auto-approve, adjuster-review, route-to-URO, defer-on-error).
- **`frontend/src/services/rfas.js`** (new) — `fetchRFAs(filters)`, `fetchRFA`, `submitRFA`, `approveRFA`, `routeToURO` fetch wrappers.
- **`frontend/src/App.jsx`** — Added `RFACenter` component (React Query, 15-second polling) with `RFADrawer` slide-in (treatment details, AI evaluation panel, approve/route-to-URO action buttons). Added "RFAs" tab to admin nav. Added "Pending RFAs" stat card to Claims Console dashboard.
- **`supabase/migrations/20260101000004_missing_tables.sql`** (new) — Adds `rfas`, `rfa_evaluations`, `ai_decisions`, `notices`, `audit_log` to existing deployments. RLS policies for all five tables.

### M5 — What was built

- **`backend/src/services/supabase.js`** (new) — Service-role client (`supabase`) and anon-key client (`supabaseAuth`), both from `@supabase/supabase-js`. `verifyConnection()` runs a lightweight probe on startup; server refuses to start if Supabase is unreachable.
- **`backend/src/services/claimService.js`** — Rewrote all persistence from in-memory Maps to Supabase queries. `_toClaim(row)` maps DB column names (snake_case) to JS shape. `_testStore` Map preserved for test-only `_seedClaim()` — `getClaim()` checks it first so sync test seeding still works. `_fetchClaim` uses `select('*, claim_events(*), diaries(*)')` join.
- **`supabase/migrations/`** (new) — Three ordered migration files:
  - `20260101000001_initial_schema.sql` — All tables: `users`, `employers`, `employees`, `claims`, `claim_events`, `documents`, `reserves`, `diaries`, `appointments`, `providers`, `magic_link_tokens`.
  - `20260101000002_seed_data.sql` — Three employers with fixed UUIDs, 15 LA-area MPN providers.
  - `20260101000003_enable_rls.sql` — RLS enabled on all tables; admin/adjuster all-access policies; employer-scoped read policies via `auth.uid()`.
- **`backend/tests/__mocks__/supabaseClient.js`** (new) — In-memory Supabase mock for Jest. `QueryBuilder` class supports `select / insert / update / upsert / delete` with chained `.eq()` / `.neq()` / `.order()` / `.limit()` / `.single()`. Tables are `Map` objects; `_resetStore(tableNames?)` clears them between tests. `supabaseAuth.auth.signInWithPassword` validates against `MOCK_AUTH_USERS`.
- **`backend/tests/integration/supabase-swap.test.js`** (new) — Verifies that all claim CRUD operations, RLS-scoped queries, and employer portal flows work against the mock Supabase client.

### M4 — What was built

- **`backend/src/routes/auth.js`** — Added `POST /api/v1/auth/employer/login` (email + password → employer JWT cookie) and `GET /api/v1/auth/dev-employer-session` (dev auto-login, blocked in production). MFA stubs relabelled M5.
- **`backend/src/routes/employer.js`** (new) — `POST /api/v1/employer/froi`: auth-guarded (employer + admin roles), ADP pull, `claimService.createClaim`, magic token generation + single-use tracking, `notificationService.sendMagicLinkEmail`, 201 response with `magic_link_url`. `GET /api/v1/employer/employee-preview/:adpEmployeeId`: name/title preview before FROI submit, always returns 200.
- **`backend/src/services/notificationService.js`** (new) — `sendMagicLinkEmail`: no-op when `SENDGRID_API_KEY` absent (dev/test), otherwise sends via `@sendgrid/mail`. PHI constraint: only claim number + employer name in email body, no body part / AWW / diagnosis.
- **`backend/src/middleware/auth.js`** — Added `generateEmployerToken` (8-hour JWT, role: `employer`). Exported alongside existing helpers.
- **`backend/src/services/db.js`** — Added `users` store: two mock employer accounts, `findByEmail`, `checkPassword` (plain-text for dev; replace with Supabase Auth in M5). Added `magicLinkTokens` store with `create`, `findByJti`, `markUsed` for single-use token enforcement.
- **`backend/src/services/claimService.js`** — Added `filed_at: now` (LC §5400 FROI receipt timestamp). Added `DELAY_NOTICE_DUE` diary at `filed_at + 14 calendar days` (LC §4650/§4652 — delay notice required if compensability decision not made within 14 days of FROI receipt).
- **`backend/src/routes/claims.js`** — Changed `bodyPart` and `injuryType` from required to optional (employers often don't know exact body part at time of FROI).
- **`backend/src/index.js`** — Wired `employer` router at `/api/v1/employer`.
- **`frontend/src/services/employer.js`** (new) — Fetch wrappers: `loginEmployer`, `ensureDevEmployerSession`, `previewEmployee`, `submitFROI`.
- **`frontend/src/App.jsx`** — Added `EmployerLogin` (email/password form), `FROIForm` (ADP preview on blur, DOI date picker, optional body/injury dropdowns, loading states, success with magic link copy, no-email warning), updated `EmployerPortal` (React Query claims table with Link Status + Filed columns, RLS-scoped to employer JWT). Root `App` now handles `employerUser` state and calls `ensureDevEmployerSession` on role switch.
- **`backend/tests/integration/employer-portal.test.js`** (new) — 18 integration tests: employer login (valid / wrong password / unknown email), dev-employer-session (dev / production guard), FROI (happy path / unknown ADP ID / future DOI / missing fields / no auth / admin token / employee token), employee-preview (found / not found), claims RLS (employer-scoped / admin bypass), optional bodyPart/injuryType.
- **Jest mocks replace Python mock servers** — `tests/unit/adp.test.js` and `tests/unit/filehandler.test.js` rewritten with `jest.mock('axios')` and in-memory state. `tests/integration/claim-flow.test.js` uses module-level `jest.mock` for ADP and FileHandler. No external processes required to run the full test suite.

### M3 — What was built

- **Security fix (Issue #13)**: Removed `runAIAnalysis()` from the browser — it was calling `api.anthropic.com` directly and exposing `ANTHROPIC_API_KEY` in DevTools network traffic. AI analysis now runs server-side via `POST /api/v1/claims/:id/analyze`.
- **`backend/src/routes/claims.js`** — Added `POST /:id/analyze` (trigger/cache), `GET /:id/reasoning-pdf` (PDF download), `GET /:id/diaries` (list diaries).
- **`backend/src/services/claimService.js`** — Added `triggerAnalysis(claimId)` (sync, returns cache if exists), `getDiaries(claimId)`, and `claim.diaries[]` array populated by `_seedInitialDiaries`.
- **`backend/src/services/pdfService.js`** — Added `generateReasoningPDF(claim)` using `pdf-lib`. Sections: compensability/score/priority, reserves, red flags, next actions, rationale. No CDN dependencies.
- **`backend/src/middleware/auth.js`** — Added `requireMFA` middleware stub. No-op when `SUPABASE_URL` absent; checks `amr: ['totp']` in production.
- **`backend/src/routes/auth.js`** — Added `GET /api/v1/auth/dev-session` (auto-login for dev/test; blocked in production and when `NODE_ENV` is unset via allowlist guard), `POST /mfa/enroll` + `/mfa/verify` stubs for M4 Supabase wiring.
- **`frontend/src/services/claims.js`** — Thin fetch wrappers: `fetchClaims`, `fetchClaim`, `updateClaimStatus`, `approveReserves`, `triggerAnalysis`, `fetchDiaries`, `ensureDevSession`.
- **`frontend/src/services/providers.js`** — `fetchProviders(zipCode, limit)`.
- **`frontend/src/main.jsx`** — Wrapped `<App>` in `<QueryClientProvider>` (`@tanstack/react-query`).
- **`frontend/src/App.jsx`** — Replaced `useState(INIT_CLAIMS)` with `useQuery(['claims'], fetchClaims)`. Added `ActionQueue` component (priority-sorted, overdue-diary aware). Updated `ClaimDrawer` with live data, reserve approval form (`useMutation → PATCH /reserves`), diary section, status transition buttons. PDF download calls `GET /api/v1/claims/:id/reasoning-pdf`.
- **`backend/tests/integration/admin-console.test.js`** — 27 integration tests covering all M3 endpoints (includes dev-session production/undefined-env guard tests).

### M2 — What was built

- **`backend/src/services/voiceService.js`** — OpenAI Whisper transcription + Claude structured extraction (body part, mechanism, time-off flag).
- **`backend/src/routes/voice.js`** — `POST /api/v1/voice` (audio upload → Whisper → Claude extraction), `POST /api/v1/voice/text` (text → Claude extraction).
- **`backend/src/services/providerService.js`** — MPN provider search by zip code, distance calculation, specialty and walk-in filters.
- **`backend/src/routes/providers.js`** — `GET /api/v1/providers`, `GET /api/v1/providers/:id`, `GET /api/v1/providers/near`.
- **`backend/src/services/appointmentService.js`** — Appointment lifecycle: create, confirm, reschedule.
- **`backend/src/routes/appointments.js`** — Full CRUD + MPN acknowledge endpoint.
- **`backend/src/routes/documents.js`** — DWC-1 PDF generation and storage.
- **`backend/src/routes/auth.js`** — Magic link generate + validate with ADP demographic pre-fill.
- **`backend/src/services/pdfService.js`** — `generateDWC1()` and `generateAuthorizationLetter()` using `pdf-lib` (server-side, no CDN).
- **`frontend/src/App.jsx`** — `EmployeeIntakeWizard` (6 steps: personal info, injury details, voice/text, media upload, MPN provider selection + appointment booking, DWC-1).
- **`frontend/src/i18n.js`** + **`locales/`** — Full EN/ES localization for all intake wizard strings.
- **`backend/tests/integration/intake-flow.test.js`** — 23 integration tests for appointments, MPN flow, intake-progress tracking.
- **`backend/utils/businessDays.js`** — California holiday calendar (all 15 statutory holidays) for LC compliance date calculations.

### M1 — What was built

- **`backend/src/services/filehandler.js`** — Full FileHandler Enterprise HTTP client: create claim, set reserves, attach documents (base64), create/complete diaries, record payments, get audit ledger. Exponential back-off retry on 429/5xx.
- **`backend/src/services/adp.js`** — ADP Workforce Now OAuth2 client with in-memory token caching. Employee lookup, 26-period pay statement pull, California LC §4453 AWW calculation, 2026 TD rate (floor $252.03 / ceiling $1,680.29).
- **`backend/src/services/claimService.js`** — Full FROI → ADP pull → FileHandler create → initial statutory diaries → async Claude analysis lifecycle. State machine with valid status transitions.
- **`backend/src/services/aiService.js`** — Claude API wrapper for compensability analysis and RFA/MTUS evaluation. Prompt files in `backend/prompts/`. Hard-rejects non-JSON responses — never auto-approves on parse failure.
- **`backend/src/routes/`** — REST API: `POST /api/v1/claims`, `GET`, `PATCH /reserves`, `PATCH /status`, plus webhook receivers for DxF ADT, Enlyte determination, and Lob delivery events.
- **`backend/src/middleware/`** — JWT auth (cookie + Bearer), role enforcement (`admin` / `employer` / `employee`), request audit logging.
- **`backend/mocks/mock_adp.py`** — Mock ADP server (port 8001). 7 test employees covering standard claims, TD floor/ceiling edge cases, surgical, needlestick, sparse pay history.
- **`backend/mocks/mock_filehandler.py`** — Mock FileHandler server (port 8002). Full in-memory ledger, all endpoints, `/mock/reset` for clean test runs.
- **`.github/workflows/ci.yml`** — GitHub Actions CI: starts both mocks, runs Jest suite, injects `ANTHROPIC_API_KEY` from repository secret.
- **`backend/tests/`** — Unit tests (ADP + FileHandler services), integration tests (full claim flow including live Claude assertions when key is present).

---

## Development Principles

1. **Every claim is a data asset.** Structured fields everywhere. No free-text where typed data belongs. Schema decisions made now determine ML capability in year 3.

2. **The system of record is FileHandler.** Our database is operational state. FileHandler is the auditable financial ledger. When they conflict, FileHandler wins.

3. **AI recommends, humans authorize decisions that require a license.** Approvals by non-physicians: legal. Denials or modifications: physician only (DWC). This constraint is hard-coded into the RFA routing logic.

4. **Audit trail on everything.** Every AI decision, every human override, every API call to FileHandler is logged with timestamp, user, and rationale. DWC PAR audits are a reality.

5. **Mobile-first for employee and employer portals.** Most injured home health workers will complete intake on a phone. Design and test there first.

6. **Fail safe, not fail open.** If the AI is uncertain, escalate to human. Never auto-approve if confidence is below threshold. Never auto-deny under any circumstances.

---

## Getting Started (Local Development)

```bash
git clone https://github.com/aksiomatixx/homecare-tpa.git
cd homecare-tpa
```

### Mock servers (optional — manual API exploration only)

The Jest test suite uses `jest.mock('axios')` and does not require external processes.
The Python mock servers are only needed if you want to test raw ADP/FileHandler HTTP calls
directly (e.g. with Postman or curl against a running backend).

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
ANTHROPIC_API_KEY=          # from console.anthropic.com (stored as GitHub repo secret)

# Mock values — change only when connecting to real services
FILEHANDLER_API_KEY=mock-fh-key
FILEHANDLER_BASE_URL=http://localhost:8002
ADP_CLIENT_ID=mock
ADP_CLIENT_SECRET=mock
ADP_AUTH_URL=http://localhost:8001/auth/oauth/v2/token
ADP_BASE_URL=http://localhost:8001

# M4 — optional; magic-link emails are no-op without this
SENDGRID_API_KEY=           # from sendgrid.com
FRONTEND_URL=http://localhost:5173
```

Full variable reference: `backend/.env.example`

---

## Questions / Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| Apr 2026 | GitHub Issues over email for specs | Searchable, version-controlled, linked to commits |
| Apr 2026 | PostgreSQL / Supabase | Structured claims data, row-level security, managed infra |
| Apr 2026 | FileHandler Enterprise as CMS | Purpose-built TPA ledger, auditable, WC-specific |
| Apr 2026 | Manifest MedEx as QHIO | Largest CA nonprofit QHIO, covers 90%+ of CA population, free ADT network |
| Apr 2026 | Enlyte as URO | Dominant CA WC UR vendor, April 2026 regulation updates already incorporated |

---

*HomeCare TPA — Confidential. For authorized contributors only.*
