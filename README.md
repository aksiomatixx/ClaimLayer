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
│           └── providers.js          ← fetchProviders(zipCode, limit)
├── backend/                          ← Express (Node.js) API
│   ├── src/
│   │   ├── index.js                  ← Express app entry point (port 3001)
│   │   ├── config.js                 ← All environment variables
│   │   ├── logger.js                 ← Structured JSON logging (Winston)
│   │   ├── services/
│   │   │   ├── filehandler.js        ← FileHandler Enterprise client
│   │   │   ├── adp.js                ← ADP OAuth2 client + AWW/TD calculation
│   │   │   ├── claimService.js       ← Claim lifecycle orchestration + diaries
│   │   │   ├── aiService.js          ← Claude API integration
│   │   │   ├── pdfService.js         ← DWC-1, AI reasoning, auth letter (pdf-lib)
│   │   │   ├── appointmentService.js ← MPN appointment booking
│   │   │   ├── providerService.js    ← Provider search by zip + specialty
│   │   │   ├── db.js                 ← In-memory DB helpers (M2, replace with Supabase in M4)
│   │   │   └── voiceService.js       ← OpenAI Whisper transcription + Claude extraction
│   │   ├── routes/
│   │   │   ├── claims.js             ← /api/v1/claims (CRUD + analyze + pdf + diaries)
│   │   │   ├── providers.js          ← /api/v1/providers
│   │   │   ├── appointments.js       ← /api/v1/appointments
│   │   │   ├── voice.js              ← /api/v1/voice (Whisper + text extraction)
│   │   │   ├── documents.js          ← /api/v1/documents
│   │   │   ├── auth.js               ← /api/v1/auth (magic link + dev-session)
│   │   │   └── webhooks.js           ← DxF ADT, Enlyte, Lob receivers
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
│   │   ├── unit/
│   │   │   ├── adp.test.js
│   │   │   ├── filehandler.test.js
│   │   │   ├── businessDays.test.js
│   │   │   └── providers.test.js
│   │   └── integration/
│   │       ├── claim-flow.test.js         ← Full FROI → ADP → FH → AI flow
│   │       ├── intake-flow.test.js        ← M2: appointments, MPN, intake-progress
│   │       └── admin-console.test.js      ← M3: analyze, reserves, status, PDF, diaries
│   ├── package.json
│   └── .env.example
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
Claude evaluates: mechanism vs. accepted body part, AOE/COE indicators, prior claims history, witness statements, medical consistency. Returns: compensability rating (Likely / Questionable / Non-Compensable), confidence score 0-100, red flags, recommended actions, analysis narrative.

### Reserve Recommendations
Claude calculates initial reserves based on: injury type, body part, time off work, AWW/TD rate, medical treatment to date, presence of surgical indicators. Reserves are suggestions — final authority is always the adjuster.

### RFA / MTUS Evaluation
Claude compares the requested treatment against MTUS/ACOEM guidelines for the accepted diagnosis:
- **Auto-approve:** Treatment type, frequency, and duration within MTUS parameters for accepted condition from MPN provider
- **Adjuster review:** MTUS-consistent but at upper limit of guidelines or complex clinical picture
- **Route to URO:** Outside MTUS parameters, surgical, experimental, off-formulary, or insufficient supporting documentation
- **Defer:** Claim under compensability investigation (LC §4610(l))

> **Critical:** Only a licensed physician may modify or deny an RFA (DWC FAQ). Claude may approve. The URO physician modifies or denies. This is not optional.

### Diary Generation
Claude generates the diary set from claim facts at claim creation and updates diaries on every significant event. Diaries are created in FileHandler via API, not maintained in our database.

---

## Milestones

| Milestone | Description | Status |
|---|---|---|
| M1 | Foundation: Express backend, FileHandler client, ADP client, auth middleware, CI pipeline, mock servers, unit + integration test suite | ✅ Complete |
| M2 | Employee intake: Voice (Whisper), media upload, provider finder, appointment booking, DWC-1 (pdf-lib), i18n (EN/ES) | ✅ Complete |
| M3 | Admin console: Action queue, AI analysis (backend-only), reserve approval, diaries, reasoning PDF, React Query | ✅ Complete |
| M4 | Supabase Auth + MFA, Employer portal FROI, magic link status dashboard | 🔲 Not started |
| M5 | DxF / QHIO: Manifest MedEx roster, ADT push, clinical document pull | 🔲 Not started |
| M6 | RFA engine: MTUS evaluation, auto-approval, Enlyte URO routing | 🔲 Not started |
| M7 | Diary engine: Auto-generation, event-triggered updates, escalation | 🔲 Not started |
| M8 | Notice center: Lob.com integration, statutory notice generation | 🔲 Not started |
| M9 | Reporting: Employer dashboard, loss run, experience mod tracking | 🔲 Not started |

### M3 — What was built (current)

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

### Mock servers (required for backend)

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
npm test                    # requires both mock servers running
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
