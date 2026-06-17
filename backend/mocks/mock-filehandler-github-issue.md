# GitHub Issue — Copy this into GitHub as a new Issue

**Title:** `[FOUNDATION] Mock FileHandler Enterprise server for local development and testing`

**Labels:** `foundation` `testing` `milestone-1`

---

## User Story

> As a developer, I want a mock FileHandler Enterprise server that responds exactly like the real system so that I can build and test the entire financial ledger integration without needing a live FileHandler account or affecting any auditable records.

---

## Background

JW Software does not provide a public sandbox or developer portal for FileHandler Enterprise. API access is gated behind a signed contract and a demo call. Development cannot wait for that commercial process. The mock server lets us build, test, and verify the complete FileHandler integration against realistic data today.

The mock implements all endpoints specced in `docs/integrations.md` Section 1. When the real FileHandler API credentials arrive, swapping `FILEHANDLER_BASE_URL=http://localhost:8002` for the real URL should require zero code changes in our backend services. Any discrepancies between mock and real API behavior will be surfaced at that point and handled as a separate issue.

---

## Acceptance Criteria

- [ ] Mock server runs on `http://localhost:8002` via `python mock_filehandler.py`
- [ ] `POST /claims` creates a claim, returns `{ claimId, claimNumber, status, createdAt }`
- [ ] `GET /claims/:id` returns full claim record including current reserves and totals
- [ ] `POST /claims/:id/reserves` sets reserves, updates claim totals, appends to ledger
- [ ] `GET /claims/:id/reserves` returns full reserve history
- [ ] `POST /claims/:id/documents` accepts base64 PDF, validates it, returns document ID
- [ ] `GET /claims/:id/documents` returns list of all documents on the claim
- [ ] `POST /claims/:id/diaries` creates a diary with type, due date, priority
- [ ] `PATCH /claims/:id/diaries/:diary_id` completes or cancels a diary
- [ ] `GET /claims/:id/diaries` returns diaries, supports `?status=open` filter
- [ ] `POST /claims/:id/payments` records payment, updates `totalPaid` and `totalIncurred` on claim
- [ ] `GET /claims/:id/ledger` returns every financial and operational event in chronological order
- [ ] `DELETE /mock/reset` wipes all in-memory data for a clean test run
- [ ] `GET /health` returns 200
- [ ] Interactive docs available at `http://localhost:8002/docs` (FastAPI auto-generates this)
- [ ] All endpoints return 401 if `Authorization: Bearer mock-fh-key` header is missing
- [ ] All endpoints return 404 with a clear message if claim ID does not exist
- [ ] Duplicate claim number returns 409 Conflict

---

## Technical Specification

**File location:** `backend/mock_filehandler.py`

**Dependencies:**
```bash
pip install fastapi uvicorn pydantic
```
(All already in requirements.txt from backend scaffold)

**Run command:**
```bash
python backend/mock_filehandler.py
```

**Environment config for testing:**
```bash
# .env.test
FILEHANDLER_BASE_URL=http://localhost:8002
FILEHANDLER_API_KEY=mock-fh-key
```

**Important:** In-memory store resets on server restart. This is intentional — every test run starts with clean state. Use `DELETE /mock/reset` mid-test if you need to wipe state without restarting.

---

## Key Behavioral Notes for Integrators

**Reserve totals cascade to the claim record.** When reserves are set, `currentMedicalReserve`, `currentIndemnityReserve`, `currentExpenseReserve`, `totalReserve`, and `totalIncurred` on the claim all update immediately. Our backend can read the claim record to get current reserve state without a separate reserves query.

**Payments update `totalPaid` and `totalIncurred`.** When a payment is recorded, the claim's `totalPaid` increments and `totalIncurred` recalculates as `totalReserve + totalPaid`. This mirrors how a real financial ledger works.

**The ledger is append-only.** Every operation appends an event to the claim's ledger. The ledger is what a DWC PAR auditor reads. In production, FileHandler's ledger is immutable — never update or delete ledger entries.

**Documents are base64.** Real FileHandler accepts multipart/form-data or base64-encoded files. The mock accepts base64 in JSON for simplicity. Our `FileHandlerService` class should handle the encoding before calling either mock or real API.

---

## Test Scenarios to Verify

After implementing `FileHandlerService` (Issue #4), run these end-to-end to confirm everything works:

| Scenario | Steps | Expected |
|---|---|---|
| Create claim | POST /claims with valid body | 201, claimId returned |
| Duplicate claim | POST /claims with same claimNumber | 409 Conflict |
| Set reserves | POST /claims/:id/reserves | Claim totalReserve updated |
| Reserve history | GET /claims/:id/reserves | All previous reserve sets returned |
| Attach PDF | POST /claims/:id/documents with valid base64 | 201, documentId returned |
| Invalid base64 | POST /claims/:id/documents with bad file | 400 error |
| Create diary | POST /claims/:id/diaries | 201, diaryId returned |
| Complete diary | PATCH /claims/:id/diaries/:id with status=completed | Diary status = completed |
| Record TD payment | POST /claims/:id/payments with paymentType=TD | Claim totalPaid updated |
| Full audit ledger | GET /claims/:id/ledger after all above | All events present in order |
| Auth failure | Any request without Authorization header | 401 |
| Not found | GET /claims/nonexistent | 404 |
| Clean reset | DELETE /mock/reset then GET /claims | Empty list |

---

## Dependencies

- Issue #1 (repo structure) — mock file needs a home in the backend directory
- This issue should be completed **before** Issue #4 (FileHandlerService) so Issue #4 is built and tested against the mock
- Run both mock servers simultaneously during full integration testing: mock ADP on port 8001, mock FileHandler on port 8002
