# Milestone 1 — Foundation
# Copy each issue below into GitHub as a separate Issue.
# Label all with: `milestone-1` `foundation`

---

## ISSUE 1 of 6
**Title:** `[FOUNDATION] Repository structure, environment config, CI/CD`

### User Story
> As a developer, I want a properly structured repository with working CI/CD so that all future features can be built on a consistent, deployable foundation.

### Acceptance Criteria
- [ ] Repo has `frontend/`, `backend/`, `docs/` structure per README
- [ ] `.env.example` in root lists all required environment variables (no values)
- [ ] `.gitignore` excludes `.env`, `node_modules`, `__pycache__`, build artifacts
- [ ] Frontend scaffolded with Vite + React, existing JSX files committed to `frontend/src/`
- [ ] Backend scaffolded (FastAPI or Express — Matt's choice, document the decision)
- [ ] GitHub Actions workflow: on PR → lint + type check; on merge to `main` → deploy
- [ ] `staging` branch created, deploys to staging environment
- [ ] README.md at root matches the file in `docs/`

### Technical Specification
Frontend scaffold:
```bash
cd frontend
npm create vite@latest . -- --template react
npm install
```

Copy existing JSX files:
- `homecare-tpa-v3.jsx` → `frontend/src/App.jsx`
- `homecare-tpa-wireframes.jsx` → `frontend/src/Wireframes.jsx`

Backend scaffold (FastAPI example):
```bash
cd backend
python -m venv venv
pip install fastapi uvicorn sqlalchemy asyncpg python-dotenv pydantic
```

GitHub Actions (`.github/workflows/ci.yml`):
```yaml
on: [pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cd frontend && npm ci && npm run lint
```

### Dependencies
None — this is the first issue.

---

## ISSUE 2 of 6
**Title:** `[FOUNDATION] Supabase project, PostgreSQL schema, row-level security`

### User Story
> As the system, I need a properly structured database with enforced data isolation so that employer data never leaks between accounts and every claim is a structured data asset from day one.

### Acceptance Criteria
- [ ] Supabase project created (staging and production, separate projects)
- [ ] All tables from `docs/data-model.md` created via numbered migration files
- [ ] Row-level security policies applied per `docs/data-model.md`
- [ ] All indexes from data-model.md created
- [ ] Seed script creates: 1 test employer, 1 test employee, 1 test claim
- [ ] `SUPABASE_URL` and `SUPABASE_ANON_KEY` added to `.env.example`

### Technical Specification
Use Supabase migrations (not manual SQL). Each migration is a numbered file:

```
backend/migrations/
├── 001_create_employers.sql
├── 002_create_employees.sql
├── 003_create_claims.sql
├── 004_create_claim_events.sql
├── 005_create_documents.sql
├── 006_create_rfas.sql
├── 007_create_rfa_evaluations.sql
├── 008_create_reserves.sql
├── 009_create_diaries.sql
├── 010_create_ai_decisions.sql
├── 011_create_notices.sql
├── 012_create_providers.sql
├── 013_create_users.sql
├── 014_create_audit_log.sql
├── 015_create_indexes.sql
└── 016_rls_policies.sql
```

Run with: `supabase db push` or equivalent.

Full schema in `docs/data-model.md`. Implement exactly as specified — field names, types, and constraints are intentional.

### Regulatory Notes
Audit log table must be created with a 7-year retention policy. Never delete rows. See `docs/regulatory.md`.

### Dependencies
- Issue 1 must be complete (repo structure)

---

## ISSUE 3 of 6
**Title:** `[FOUNDATION] Auth system — three roles, magic links, session management`

### User Story
> As an employer, I want to log in with email and password and see only my company's claims.
> As an injured employee, I want to open a magic link and complete my claim without creating a password.
> As the admin adjuster, I want secure login with MFA to access the full system.

### Acceptance Criteria
- [ ] Supabase Auth configured
- [ ] Three roles defined: `admin`, `employer`, `employee`
- [ ] Employer login: email + password → JWT → httpOnly cookie
- [ ] Admin login: email + password + TOTP (MFA enforced, cannot be disabled for admin)
- [ ] Employee magic link: backend generates signed JWT containing `{ claim_id, employer_id, adp_employee_id, exp: 72h }`, single-use
- [ ] Magic link validated on open: JWT decoded, ADP pull queued, claim pre-populated
- [ ] Magic link invalidated after first use (cannot be reused)
- [ ] Expired or used magic links return a clear, friendly error message (not a raw 401)
- [ ] All authenticated routes reject requests without valid session
- [ ] RLS policies verified: employer user cannot query claims from another employer

### Technical Specification

**Magic link generation (backend):**
```python
import jwt
from datetime import datetime, timedelta

def generate_magic_link(claim_id: str, employer_id: str, adp_employee_id: str) -> str:
    payload = {
        "claim_id": claim_id,
        "employer_id": employer_id,
        "adp_employee_id": adp_employee_id,
        "exp": datetime.utcnow() + timedelta(hours=72),
        "jti": str(uuid4()),   # Unique token ID — store in DB to enforce single use
        "type": "magic_link"
    }
    token = jwt.encode(payload, settings.MAGIC_LINK_SECRET, algorithm="HS256")
    return f"https://homecare-tpa.com/claim?t={token}"
```

Store `jti` in a `magic_link_tokens` table with `used_at` column. On validation, check `used_at IS NULL`, then set `used_at = NOW()` atomically.

**Route protection middleware:**
```python
async def require_role(required_role: str, token: str = Depends(get_session_token)):
    user = await get_current_user(token)
    if user.role != required_role and user.role != 'admin':
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    return user
```

### Dependencies
- Issue 2 must be complete (database)

---

## ISSUE 4 of 6
**Title:** `[FOUNDATION] FileHandler Enterprise — sandbox connection, claim CRUD`

### User Story
> As the system, I need a working connection to FileHandler Enterprise so that every claim we create is immediately mirrored in the auditable financial ledger.

### Acceptance Criteria
- [ ] FileHandler sandbox credentials obtained (Akash to provide)
- [ ] `FileHandlerService` class created with methods: `create_claim`, `set_reserves`, `attach_document`, `create_diary`, `complete_diary`, `record_payment`, `get_ledger`
- [ ] All calls wrapped in retry logic: 3 attempts, exponential backoff (1s, 2s, 4s)
- [ ] All calls logged to `audit_log` with: endpoint, status code, latency, claim_id
- [ ] Test: create a claim in FileHandler sandbox and verify it appears in the FileHandler UI
- [ ] `FILEHANDLER_API_KEY` and `FILEHANDLER_BASE_URL` in `.env.example`

### Technical Specification
```python
# backend/services/filehandler.py
class FileHandlerService:
    def __init__(self, api_key: str, base_url: str):
        self.headers = {"Authorization": f"Bearer {api_key}"}
        self.base_url = base_url

    async def create_claim(self, claim: Claim) -> str:
        """Returns FileHandler claim ID. Store in claims.filehandler_claim_id."""
        payload = {
            "claimNumber": claim.id,
            "claimantFirstName": claim.employee.first_name,
            "claimantLastName": claim.employee.last_name,
            # ... full mapping per docs/integrations.md
        }
        response = await self._post("/claims", payload)
        return response["claimId"]

    async def set_reserves(self, fh_id: str, reserves: ReserveUpdate) -> None:
        await self._post(f"/claims/{fh_id}/reserves", reserves.dict())

    async def attach_document(self, fh_id: str, pdf_bytes: bytes, doc_type: str, description: str) -> str:
        """Returns FileHandler document ID."""
        # multipart/form-data upload
        ...

    async def _post(self, path: str, payload: dict) -> dict:
        """POST with retry and logging."""
        for attempt in range(3):
            try:
                response = await httpx.post(f"{self.base_url}{path}", json=payload, headers=self.headers)
                response.raise_for_status()
                await self._log(path, response.status_code, ...)
                return response.json()
            except Exception as e:
                if attempt == 2:
                    raise
                await asyncio.sleep(2 ** attempt)
```

Full endpoint specifications in `docs/integrations.md` — Section 1 (FileHandler Enterprise).

### Dependencies
- Issue 2 (database — need audit_log table)
- Issue 3 (auth — service runs as system user)

---

## ISSUE 5 of 6
**Title:** `[FOUNDATION] ADP Workforce Now — OAuth2 connection, employee demographics pull`

### User Story
> As the system, when a new claim is created, I want to automatically pull the injured employee's demographics, job title, pay history, and calculated AWW from ADP so that the DWC-1 and benefit calculations are accurate without anyone typing them manually.

### Acceptance Criteria
- [ ] ADP sandbox credentials obtained (Akash to provide — apply at marketplace.adp.com)
- [ ] OAuth2 client credentials flow implemented and token cached with auto-refresh
- [ ] `ADPService.get_employee(employee_id_or_name)` returns structured employee record
- [ ] `ADPService.get_pay_statements(associate_oid, periods=26)` returns last 26 pay periods
- [ ] `calculate_td_rate(pay_statements)` correctly applies CA 2026 min ($252.03) and max ($1,680.29)
- [ ] Employee record stored in `employees` table after pull
- [ ] Test with sandbox employee IDs: verify AWW and TD rate calculations with known values
- [ ] `ADP_CLIENT_ID` and `ADP_CLIENT_SECRET` in `.env.example`

### Technical Specification
Full spec in `docs/integrations.md` — Section 2 (ADP Workforce Now).

CA 2026 TD rate constants (update January 1 each year per DWC announcement):
```python
CA_TD_MIN_2026 = 252.03
CA_TD_MAX_2026 = 1680.29
CA_TD_FRACTION = 2/3

def calculate_td_rate(pay_statements: list[PayStatement]) -> TDCalculation:
    if not pay_statements:
        return TDCalculation(aww=None, td_rate=None, note="Insufficient pay history")
    
    total_gross = sum(p.gross_pay for p in pay_statements)
    weeks = len(pay_statements)
    aww = total_gross / weeks
    
    td_raw = aww * CA_TD_FRACTION
    td_rate = max(CA_TD_MIN_2026, min(CA_TD_MAX_2026, td_raw))
    
    return TDCalculation(
        aww=round(aww, 2),
        td_rate=round(td_rate, 2),
        pay_periods_used=weeks,
        calculated_at=datetime.utcnow()
    )
```

### Regulatory Notes
AWW calculation per LC §4453. TD rate per LC §4453(c). 2026 rates published by DWC annually — create a constants file and update each January.

### Dependencies
- Issue 2 (database — employee table)
- Issue 3 (auth)

---

## ISSUE 6 of 6
**Title:** `[FOUNDATION] End-to-end proof of concept — employer submits FROI, claim created, Claude analyzes`

### User Story
> As Akash, I want to submit a test First Report of Injury, see the claim created in both our database and FileHandler, and see Claude's compensability analysis appear in the admin console — so we have proven the core loop works before building any additional features.

### Acceptance Criteria
- [ ] `POST /api/v1/claims` endpoint accepts FROI payload, returns claim ID
- [ ] ADP pull fires automatically on claim creation (or uses provided data if ADP unavailable in sandbox)
- [ ] Claim record created in PostgreSQL with all structured fields
- [ ] Claim record created in FileHandler sandbox via `FileHandlerService.create_claim()`
- [ ] Background job `ClaimAnalysisWorker` runs Claude analysis on new claim
- [ ] Claude returns JSON: compensability, confidence, reserves, priority, red flags, actions, analysis notes
- [ ] AI decision logged in `ai_decisions` table
- [ ] AI reasoning PDF generated (jsPDF on frontend or server-side) and pushed to FileHandler
- [ ] Admin console `/admin/claims` shows the new claim with AI analysis populated
- [ ] Full round-trip time from FROI submission to AI analysis visible in console: under 3 minutes

### Technical Specification

**FROI endpoint:**
```python
@router.post("/claims")
async def create_claim(froi: FROIInput, user: User = Depends(require_role("employer"))):
    # 1. Create claim ID
    claim_id = generate_claim_id()  # Format: HHW-YYYY-NNN
    
    # 2. Pull ADP (or use form data if ADP unavailable)
    try:
        employee = await adp_service.get_employee(froi.adp_employee_id)
        financials = calculate_td_rate(await adp_service.get_pay_statements(employee.associate_oid))
    except ADPException:
        employee = froi.employee_data   # Fallback to manually entered data
        financials = froi.financials
    
    # 3. Create in DB
    claim = await db.claims.create({...})
    
    # 4. Create in FileHandler
    fh_id = await filehandler_service.create_claim(claim)
    await db.claims.update(claim.id, {"filehandler_claim_id": fh_id})
    
    # 5. Enqueue analysis job
    await queue.enqueue("analyze_claim", {"claim_id": claim.id})
    
    return {"claim_id": claim.id, "status": "created"}
```

**ClaimAnalysisWorker:**
```python
async def analyze_claim(claim_id: str):
    claim = await db.claims.get_with_relations(claim_id)
    
    # Call Claude
    analysis = await ai_service.analyze_compensability(claim)
    
    # Store AI decision
    await db.ai_decisions.create({
        "claim_id": claim_id,
        "decision_type": "compensability_analysis",
        "model_used": "claude-sonnet-4-20250514",
        "input_snapshot": claim.to_dict(),
        "output_raw": analysis.raw_response,
        "output_parsed": analysis.parsed,
        "confidence": analysis.confidence_score,
        "recommendation": analysis.compensability
    })
    
    # Update claim with AI results
    await db.claims.update(claim_id, {
        "ai_compensability": analysis.compensability,
        "ai_confidence": analysis.confidence_score,
        "ai_priority": analysis.priority,
        "reserve_medical": analysis.suggested_medical_reserve,
        "reserve_indemnity": analysis.suggested_indemnity_reserve,
        "reserve_expense": analysis.suggested_expense_reserve,
        "ai_analyzed_at": datetime.utcnow()
    })
    
    # Generate and push AI reasoning PDF
    pdf_bytes = generate_reasoning_pdf(claim, analysis)
    await filehandler_service.attach_document(
        claim.filehandler_claim_id, pdf_bytes,
        "AI_REASONING_PDF", f"AI Decision Analysis — {claim_id}"
    )
```

Claude prompt is in `backend/prompts/compensability_analysis.txt`. Full Claude API spec in `docs/integrations.md` — Section 4.

### Dependencies
- Issues 1–5 must all be complete
- This issue is the milestone completion gate — when this works end-to-end, Milestone 1 is done
