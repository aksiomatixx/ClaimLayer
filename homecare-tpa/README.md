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
├── README.md                    ← You are here
├── frontend/                    ← React application
│   ├── src/
│   │   ├── App.jsx              ← Main platform (v3)
│   │   ├── Wireframes.jsx       ← Interactive wireframes / user stories
│   │   └── components/
│   └── package.json
├── backend/                     ← FastAPI or Express API (TBD by Matt)
│   ├── api/
│   ├── services/
│   ├── models/
│   └── workers/                 ← Background jobs (DxF polling, diary engine, etc.)
├── docs/
│   ├── architecture.md          ← Full system design
│   ├── integrations.md          ← API integration specs
│   ├── regulatory.md            ← California WC compliance requirements
│   └── data-model.md            ← PostgreSQL schema documentation
└── .github/
    ├── ISSUE_TEMPLATE/
    │   ├── feature.md
    │   └── bug.md
    └── PULL_REQUEST_TEMPLATE.md
```

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React (Vite) | Three portals: Admin, Employer, Employee |
| Backend | FastAPI (Python) or Express (Node) | Matt's choice based on preference |
| Database | PostgreSQL via Supabase | Managed, with row-level security |
| Auth | Supabase Auth | Three roles: admin, employer, employee |
| AI Engine | Anthropic Claude API (`claude-sonnet-4-20250514`) | Compensability, reserves, RFA evaluation, diaries |
| CMS / Ledger | FileHandler Enterprise (JW Software) | Authoritative financial record |
| HR / Payroll | ADP Workforce Now API | Demographics, wages, AWW calculation |
| Health Data | Manifest MedEx (QHIO / DxF) | ADT notifications, clinical document queries |
| Lab Data | Health Gorilla | Lab subscription, FHIR queries |
| UR | Enlyte UR Services | Physician review for non-MTUS RFAs |
| Print / Mail | Lob.com | USPS first-class notice delivery |
| PDF Generation | jsPDF | DWC-1, AI reasoning docs, benefit notices |
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
T+1:30   AI reasoning PDF generated (jsPDF) → pushed to FileHandler document store
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
| M1 | Foundation: Auth + DB schema + FileHandler + ADP + end-to-end proof of concept | 🔲 Not started |
| M2 | Employee intake: Voice, media upload, provider finder, appointment booking, DWC-1 | 🔲 Not started |
| M3 | Admin console: Claim review, AI analysis, reserve approval, FileHandler sync | 🔲 Not started |
| M4 | Employer portal: FROI, magic link, status dashboard | 🔲 Not started |
| M5 | DxF / QHIO: Manifest MedEx roster, ADT push, clinical document pull | 🔲 Not started |
| M6 | RFA engine: MTUS evaluation, auto-approval, Enlyte URO routing | 🔲 Not started |
| M7 | Diary engine: Auto-generation, event-triggered updates, escalation | 🔲 Not started |
| M8 | Notice center: Lob.com integration, statutory notice generation | 🔲 Not started |
| M9 | Reporting: Employer dashboard, loss run, experience mod tracking | 🔲 Not started |

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
# Clone the repo
git clone https://github.com/[org]/homecare-tpa.git
cd homecare-tpa

# Frontend
cd frontend
npm install
npm run dev

# Backend (once scaffolded by Matt)
cd backend
# Python: pip install -r requirements.txt && uvicorn main:app --reload
# Node:   npm install && npm run dev
```

Environment variables required — see `.env.example` (never commit `.env`):

```
ANTHROPIC_API_KEY=
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=
ADP_CLIENT_ID=
ADP_CLIENT_SECRET=
FILEHANDLER_API_KEY=
FILEHANDLER_BASE_URL=
MANIFEST_MEDEX_API_KEY=
HEALTH_GORILLA_API_KEY=
ENLYTE_UR_API_KEY=
LOB_API_KEY=
SENDGRID_API_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
```

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
