# GitHub Issue — Copy this into GitHub as a new Issue

**Title:** `[FOUNDATION] Mock ADP server for local development and testing`

**Labels:** `foundation` `testing` `milestone-1`

---

## User Story

> As a developer, I want a mock ADP server that responds exactly like the real ADP Workforce Now API so that I can build and test the full claim intake flow without needing live ADP credentials or affecting real employee data.

---

## Background

ADP Workforce Now requires applying for API access, receiving a practitioner certificate, and going through a formal onboarding process before live credentials are available. Development cannot wait for that. The mock server lets us build, test, and verify the entire ADP integration layer against realistic data today.

The mock must respond to the exact same endpoints with the exact same JSON shape as real ADP. This means when we swap `ADP_BASE_URL=http://localhost:8001` for the real ADP URL, the integration code requires zero changes.

See `docs/integrations.md` — Section 2 for the real ADP API specification this mock must match.

---

## Acceptance Criteria

- [ ] Mock server runs on `http://localhost:8001` via `python mock_adp.py`
- [ ] `POST /auth/oauth/v2/token` returns a token in the real ADP OAuth2 response shape
- [ ] `GET /hr/v2/workers?$filter=...` supports lookup by employee ID, associateOID, last name, and full name
- [ ] `GET /hr/v2/workers/{associate_oid}` returns a single employee record
- [ ] `GET /payroll/v1/workers/{associate_oid}/pay-statements?$top=26` returns 26 biweekly pay periods
- [ ] Pay statements have realistic variation (not identical amounts every period)
- [ ] AWW and TD rate calculations verified correct for all seven test employees
- [ ] All seven test scenarios are covered (see table below)
- [ ] `GET /mock/employees` convenience endpoint lists all test employees and their scenarios
- [ ] Setting `ADP_BASE_URL=http://localhost:8001` in `.env.test` is the only change needed to use the mock
- [ ] The mock file contains a clear comment: **"Remove this file before connecting to production ADP"**
- [ ] `GET /health` returns 200

---

## Test Employees and Scenarios

| Employee ID | Name | Scenario | What It Tests |
|---|---|---|---|
| BC-001 | Maria Santos | `standard_lifting_injury` | Normal home health lifting claim, standard AWW |
| BC-002 | Rosa Gutierrez | `repeat_claimant` | Employee with prior claims — tests prior history handling |
| CF-014 | James Okonkwo | `needlestick_exposure` | LVN, Hep-C exposure — tests occupational disease flow |
| SR-022 | Lupe Hernandez | `surgical_knee` | Meniscus tear, surgical case — tests high-reserve path |
| CW-007 | Thanh Nguyen | `td_minimum_floor` | Part-time, AWW × 2/3 < $252.03 — TD must floor at $252.03 |
| BC-099 | Priya Krishnamurthy | `td_maximum_ceiling` | RN, AWW × 2/3 > $1,680.29 — TD must cap at $1,680.29 |
| HH-003 | Devon Washington | `new_hire_sparse_pay_history` | Hired 3 weeks ago — only 1-2 pay periods exist |

---

## Technical Specification

**File location:** `backend/mock_adp.py`
(Move to `backend/tests/mocks/mock_adp.py` before Milestone 2 when the test suite is structured)

**Dependencies:**
```bash
pip install fastapi uvicorn
```
(Both already in requirements.txt from backend scaffold)

**Run command:**
```bash
python backend/mock_adp.py
```

**Environment config for testing:**
```bash
# .env.test  (never commit this file)
ADP_BASE_URL=http://localhost:8001
ADP_CLIENT_ID=mock
ADP_CLIENT_SECRET=mock
```

**Switching between mock and real ADP:**
The `ADPService` class (Issue #5) reads `ADP_BASE_URL` from environment. No code changes needed — only the env var changes between mock and real.

```python
# This works against both mock and real ADP:
adp = ADPService(
    base_url=settings.ADP_BASE_URL,    # http://localhost:8001 (mock) or https://api.adp.com (real)
    client_id=settings.ADP_CLIENT_ID,
    client_secret=settings.ADP_CLIENT_SECRET
)
```

---

## TD Rate Verification Table

Use these expected values to verify the calculation logic is correct:

| Employee | Pay Rate | Avg Hrs/Wk | Expected AWW (approx) | Expected TD Rate | Floor/Ceiling Applied? |
|---|---|---|---|---|---|
| BC-001 Maria Santos | $19.50 | 38.5 | ~$750 | ~$500 | Neither |
| BC-002 Rosa Gutierrez | $21.75 | 40.0 | ~$870 | ~$580 | Neither |
| CF-014 James Okonkwo | $28.00 | 40.0 | ~$1,120 | ~$747 | Neither |
| SR-022 Lupe Hernandez | $17.25 | 36.0 | ~$621 | ~$414 | Neither |
| CW-007 Thanh Nguyen | $16.90 | 18.0 | ~$304 | **$252.03** | **Floor applied** |
| BC-099 Priya Krishnamurthy | $65.00 | 40.0 | ~$2,600 | **$1,680.29** | **Ceiling applied** |
| HH-003 Devon Washington | $17.50 | 32.0 | ~$560 (few periods) | ~$373 | Neither |

CA 2026 TD constants: min = $252.03/wk, max = $1,680.29/wk, rate = 2/3 of AWW (LC §4453)

---

## Notes

- Pay statements are procedurally generated — amounts will vary slightly each run. This is intentional and realistic. The AWW and TD rate should be in the expected ranges, not exact values.
- The `_mockCalculations` field in the pay statements response is a convenience for development. It does **not** appear in real ADP responses. Strip it or ignore it in the `ADPService` implementation.
- The mock `/mock/employees` endpoint also does not exist in real ADP. It is only for developer reference.
- Add a new mock employee whenever a new test scenario is needed (e.g., bilingual employee, terminated employee, salary vs. hourly). Do not modify the claim data to work around missing mock scenarios — fix the mock instead.

---

## Dependencies

- Issue #1 (repo structure) — mock file needs a home in the backend directory
- This issue should be completed **before** Issue #5 (ADPService) so that Issue #5 can be built and tested against the mock
