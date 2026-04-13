# System Architecture

## Overview

HomeCare TPA is a three-tier web application with an event-driven backend. The frontend serves three distinct portals. The backend exposes a REST API, runs background workers for event-driven processing, and orchestrates all third-party integrations. PostgreSQL is the operational database. FileHandler Enterprise is the auditable financial ledger.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         FRONTEND (React)                        │
│  ┌─────────────┐  ┌──────────────────┐  ┌───────────────────┐  │
│  │   Employer  │  │    Employee      │  │   Admin Console   │  │
│  │   Portal    │  │    Portal        │  │   (Adjuster)      │  │
│  └──────┬──────┘  └────────┬─────────┘  └─────────┬─────────┘  │
└─────────┼───────────────────┼────────────────────┼─────────────┘
          │                   │                    │
          └───────────────────┴────────────────────┘
                              │  HTTPS / REST
┌─────────────────────────────▼───────────────────────────────────┐
│                      BACKEND API LAYER                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │  Auth Router │  │  Claims API  │  │   Webhooks / Events   │  │
│  │  (Supabase)  │  │  (REST)      │  │   (DxF ADT, etc.)     │  │
│  └──────────────┘  └──────┬───────┘  └───────────┬───────────┘  │
│                            │                      │              │
│  ┌─────────────────────────▼──────────────────────▼───────────┐  │
│  │                    SERVICE LAYER                            │  │
│  │  ClaimService  │  AIService  │  DiaryService  │  URService  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                            │                                    │
│  ┌─────────────────────────▼───────────────────────────────────┐  │
│  │                  BACKGROUND WORKERS                         │  │
│  │  DxFWorker  │  DiaryWorker  │  NoticeWorker  │  RFAWorker   │  │
│  └─────────────────────────────────────────────────────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                    EXTERNAL INTEGRATIONS                        │
│                                                                 │
│  PostgreSQL    FileHandler    ADP          Manifest MedEx       │
│  (Supabase)    Enterprise     Workforce    (QHIO / DxF)         │
│                               Now                               │
│                                                                 │
│  Claude API    Enlyte UR      Lob.com      SendGrid / Twilio    │
│  (Anthropic)   Services       (Print/Mail) (Email / SMS)        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Frontend Architecture

### Framework
React with Vite. Three separate route groups, each with its own layout component:

```
/employer/*     → EmployerLayout  (simple, mobile-friendly, status-focused)
/claim/*        → EmployeeLayout  (mobile-first, voice-enabled, reassuring)
/admin/*        → AdminLayout     (dense, data-rich, desktop-optimized)
```

### Auth Flow
- **Employer / Admin:** Email + password via Supabase Auth. JWT stored in httpOnly cookie.
- **Employee:** Magic link. No password. Backend generates a signed JWT containing `{ claimId, employerId, adpEmployeeId, exp: 72hr }`. Employee opens link, JWT validated, ADP pull fires, form pre-populated.

### State Management
React Query (TanStack Query) for all server state. No Redux. Claims data lives on the server — frontend queries and caches, never owns state independently.

### Key Frontend Services
```
services/
├── claims.js        → CRUD operations on claims
├── auth.js          → Supabase auth wrapper
├── adp.js           → ADP lookup (proxied through backend)
├── providers.js     → MPN provider search by zip
├── appointments.js  → Booking flow
├── pdf.js           → jsPDF generation (DWC-1, reasoning docs)
└── voice.js         → Web Speech API wrapper with fallback
```

---

## Backend Architecture

### Framework Choice
Matt's decision — FastAPI (Python) or Express (Node). Either is appropriate. FastAPI preferred if Matt is comfortable with Python — cleaner async handling for the background workers and better type safety with Pydantic models.

### API Structure
```
/api/v1/
├── /auth           → Login, token refresh, magic link generation
├── /claims         → CRUD, status updates
├── /employers      → Employer account management
├── /employees      → Employee record (read-only after intake)
├── /rfa            → RFA submission, routing, status
├── /diaries        → Diary CRUD (proxies to FileHandler)
├── /notices        → Notice generation and Lob queuing
├── /documents      → Document upload, FileHandler push
├── /providers      → MPN provider search
├── /webhooks       → DxF ADT receiver, Lob delivery events
└── /admin          → Reporting, audit log, system health
```

### Service Layer
Business logic lives in services, not route handlers. Route handlers validate input and call services. Services call integrations.

```python
# Example: ClaimService.create_claim()
async def create_claim(froi_data: FROIInput, employer_id: str) -> Claim:
    # 1. Pull ADP data
    employee = await adp_service.get_employee(froi_data.adp_employee_id)
    
    # 2. Calculate AWW / TD rate
    financials = calculate_td_rate(employee.pay_statements)
    
    # 3. Create in our DB
    claim = await db.claims.create({...froi_data, ...financials})
    
    # 4. Create in FileHandler
    fh_id = await filehandler_service.create_claim(claim)
    await db.claims.update(claim.id, { filehandler_id: fh_id })
    
    # 5. Enqueue async jobs
    await queue.enqueue('analyze_claim', claim.id)
    await queue.enqueue('enroll_dxf_roster', claim.id)
    await queue.enqueue('generate_initial_diaries', claim.id)
    
    return claim
```

### Background Workers
Long-running and event-driven work happens in workers, not in the request cycle. Use a job queue — Redis + BullMQ (Node) or Celery + Redis (Python).

```
Workers:
├── ClaimAnalysisWorker     → Calls Claude, generates PDF, pushes to FileHandler
├── DxFRosterWorker         → Enrolls/removes claimants from Manifest MedEx roster
├── ADTProcessingWorker     → Receives ADT, fires document query, updates claim
├── DocumentProcessingWorker → Reads new clinical docs, extracts key data, updates claim
├── RFAEvaluationWorker     → MTUS check, auto-approve or package for URO
├── DiaryWorker             → Generates/updates diaries, sends escalation alerts
├── NoticeWorker            → Generates PDFs, queues in Lob.com
└── TDPaymentWorker         → Calculates and schedules benefit payments
```

### Error Handling Philosophy
- **External API failures:** Retry with exponential backoff (3 attempts). After third failure, create an admin alert in the action queue. Never silently fail on anything that affects a statutory deadline.
- **AI failures:** If Claude returns an error or low-confidence result, create a manual review task. Never auto-approve or auto-deny on AI failure.
- **FileHandler failures:** Queue the operation and retry. FileHandler is the system of record — if a write fails, it must eventually succeed. Log every attempt.

---

## Database Architecture

> Full schema in `docs/data-model.md`. This section covers design principles.

### Design Principles

**Claims are state machines.** Every claim has a `status` field with a defined set of valid transitions. Status changes are logged in `claim_events`. You can reconstruct the full history of any claim from events alone.

**Every AI decision is logged.** Table `ai_decisions` stores every Claude analysis — the input (claim snapshot), the output (JSON), the confidence score, and whether it was approved, modified, or overridden by the adjuster. This is the training data for future model fine-tuning and the audit trail for DWC.

**Financial data mirrors FileHandler.** Our `reserves` and `payments` tables are a read replica of FileHandler for fast querying. FileHandler is authoritative. If they diverge, a reconciliation job flags the discrepancy and creates an admin alert.

**Row-level security everywhere.** Supabase RLS policies enforce data isolation at the database level, not just the application level. An employer can only read rows where `employer_id = auth.uid()`. An employee can only read rows where `claim_id` matches their JWT claim.

### Key Tables
```
employers          → Client home health agencies
employees          → Injured workers (created from ADP pull)
claims             → Core claim record (state machine)
claim_events       → Immutable event log for every claim state change
documents          → All documents (PDFs, media, clinical records)
rfas               → Request for authorization records
rfa_evaluations    → AI MTUS evaluation results per RFA
diaries            → Cached diary state (source of truth: FileHandler)
reserves           → Reserve history (source of truth: FileHandler)
payments           → Payment history (source of truth: FileHandler)
ai_decisions       → Every Claude analysis logged
notices            → Generated notices + Lob tracking
appointments       → Booked MPN appointments
providers          → MPN provider directory (cached, refreshed weekly)
audit_log          → Every admin action with user + timestamp
```

---

## Security Architecture

### Authentication
- Supabase Auth handles token issuance, refresh, and revocation
- Admin MFA enforced — TOTP required
- Magic links are single-use JWTs signed with server secret, 72-hour expiry
- All tokens transmitted in httpOnly cookies, never localStorage

### Authorization
- Role-based access control: `admin`, `employer`, `employee`
- Row-level security enforced at database layer (not just API layer)
- Admin actions require re-authentication for destructive operations

### Data Protection
- All data encrypted at rest (Supabase default + FileHandler's own encryption)
- All API calls over TLS 1.2+
- PII (SSN last 4, DOB, address) encrypted at field level before storage
- Uploaded media scanned for malware before storage
- HIPAA Business Associate Agreement required with all external vendors (FileHandler, Manifest MedEx, Health Gorilla, Enlyte)

### Audit
- Every API call logged with: user ID, role, endpoint, timestamp, request summary
- Every AI decision logged with full input/output
- Every FileHandler API call logged (we are audited by DWC — this is not optional)
- Logs retained for 7 years per California WC record retention requirements

---

## Deployment Architecture

### Recommended Stack
- **Frontend:** Vercel (automatic deploys from `main` branch)
- **Backend API:** Railway or Render (containerized, auto-scaling)
- **Workers:** Same Railway/Render deployment, separate process
- **Database:** Supabase (managed PostgreSQL)
- **Redis (job queue):** Upstash (serverless Redis, pay-per-use)
- **File storage:** Supabase Storage (HIPAA-eligible plan required)

### Environments
```
main branch     → production.homecare-tpa.com
staging branch  → staging.homecare-tpa.com   (use sandbox credentials for all APIs)
feature branches → preview deployments (Vercel) + local backend
```

### CI/CD
GitHub Actions:
- On PR: run tests, lint, type check
- On merge to `staging`: deploy to staging, run integration tests against API sandboxes
- On merge to `main`: deploy to production, smoke tests, alert on failure

---

*See `docs/integrations.md` for detailed API specs for each external service.*  
*See `docs/data-model.md` for full PostgreSQL schema.*  
*See `docs/regulatory.md` for California WC compliance requirements.*
