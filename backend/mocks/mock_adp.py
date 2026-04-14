"""
Mock ADP Workforce Now API Server
==================================
Mimics the real ADP Workforce Now API responses exactly.
Use this during development and testing before connecting to live ADP.

Endpoints implemented:
  POST /auth/oauth/v2/token          → OAuth2 token (always succeeds in mock)
  GET  /hr/v2/workers                → Employee lookup by ID or name
  GET  /payroll/v1/workers/:oid/pay-statements → Last N pay periods

Run with:
  pip install fastapi uvicorn
  python mock_adp.py

Server starts on http://localhost:8001
Set ADP_BASE_URL=http://localhost:8001 in your .env.test
"""

from fastapi import FastAPI, Header, Query, HTTPException
from fastapi.responses import JSONResponse
from datetime import datetime, date, timedelta
import random
import math

app = FastAPI(title="Mock ADP Workforce Now", version="1.0.0")

# ─────────────────────────────────────────────────────────────────────────────
# MOCK EMPLOYEE DATABASE
# Mirrors the ADP Workforce Now /hr/v2/workers response shape exactly.
# Add more employees here as needed for testing different scenarios.
# ─────────────────────────────────────────────────────────────────────────────

MOCK_EMPLOYEES = {
    # ── BrightCare Home Health ────────────────────────────────────────────────
    "BC-001": {
        "associateOID": "aoid-bc-001",
        "workerID": { "idValue": "BC-001" },
        "person": {
            "legalName": {
                "givenName": "Maria",
                "middleName": "Elena",
                "familyName": "Santos",
                "formattedName": "Maria Elena Santos"
            },
            "birthDate": "1981-03-15",
            "homeAddress": {
                "lineOne": "1842 W 7th St",
                "lineTwo": "Apt 4",
                "cityName": "Los Angeles",
                "countrySubdivisionLevel1": { "codeValue": "CA", "shortName": "California" },
                "postalCode": "90057",
                "countryCode": "US"
            },
            "preferredLanguage": { "codeValue": "es" }
        },
        "businessCommunication": {
            "landlines": [{ "formattedNumber": "(213) 555-0142", "nameCode": { "codeValue": "Mobile" } }],
            "emails": [{ "emailUri": "m.santos@gmail.com", "nameCode": { "codeValue": "Personal" } }]
        },
        "workerDates": {
            "originalHireDate": "2019-01-14",
            "adjustedHireDate": "2019-01-14",
            "terminationDate": None
        },
        "primaryOrganizationUnit": {
            "nameCode": { "codeValue": "BrightCare Home Health" },
            "department": { "codeValue": "Personal Care Services" }
        },
        "jobCode": { "codeValue": "HHA2", "shortName": "Home Health Aide II" },
        "standardPayPeriod": { "codeValue": "Biweekly" },
        "basePayRate": {
            "rateValue": 19.50,
            "currencyCode": "USD",
            "unitCode": { "codeValue": "Hourly" }
        },
        "workerStatus": { "statusCode": { "codeValue": "Active" } },
        # Metadata used for lookup — not part of real ADP response
        "_meta": {
            "employer": "BrightCare Home Health",
            "avg_hours_per_week": 38.5,
            "pay_rate": 19.50,
            "scenario": "standard_lifting_injury"
        }
    },

    "BC-002": {
        "associateOID": "aoid-bc-002",
        "workerID": { "idValue": "BC-002" },
        "person": {
            "legalName": {
                "givenName": "Rosa",
                "middleName": None,
                "familyName": "Gutierrez",
                "formattedName": "Rosa Gutierrez"
            },
            "birthDate": "1975-08-22",
            "homeAddress": {
                "lineOne": "4521 Beverly Blvd",
                "lineTwo": None,
                "cityName": "Los Angeles",
                "countrySubdivisionLevel1": { "codeValue": "CA" },
                "postalCode": "90004",
                "countryCode": "US"
            },
            "preferredLanguage": { "codeValue": "es" }
        },
        "businessCommunication": {
            "landlines": [{ "formattedNumber": "(323) 555-0189", "nameCode": { "codeValue": "Mobile" } }],
            "emails": [{ "emailUri": "rgutierrez@yahoo.com" }]
        },
        "workerDates": {
            "originalHireDate": "2017-06-01",
            "terminationDate": None
        },
        "primaryOrganizationUnit": {
            "nameCode": { "codeValue": "BrightCare Home Health" },
            "department": { "codeValue": "Personal Care Services" }
        },
        "jobCode": { "codeValue": "HHA3", "shortName": "Home Health Aide III" },
        "basePayRate": {
            "rateValue": 21.75,
            "currencyCode": "USD",
            "unitCode": { "codeValue": "Hourly" }
        },
        "workerStatus": { "statusCode": { "codeValue": "Active" } },
        "_meta": {
            "employer": "BrightCare Home Health",
            "avg_hours_per_week": 40.0,
            "pay_rate": 21.75,
            "scenario": "repeat_claimant"  # Has prior claims — tests prior history logic
        }
    },

    # ── ComfortFirst Healthcare ───────────────────────────────────────────────
    "CF-014": {
        "associateOID": "aoid-cf-014",
        "workerID": { "idValue": "CF-014" },
        "person": {
            "legalName": {
                "givenName": "James",
                "middleName": "Emeka",
                "familyName": "Okonkwo",
                "formattedName": "James Emeka Okonkwo"
            },
            "birthDate": "1975-07-22",
            "homeAddress": {
                "lineOne": "4320 Crenshaw Blvd",
                "lineTwo": "Apt 8",
                "cityName": "Los Angeles",
                "countrySubdivisionLevel1": { "codeValue": "CA" },
                "postalCode": "90008",
                "countryCode": "US"
            },
            "preferredLanguage": { "codeValue": "en" }
        },
        "businessCommunication": {
            "landlines": [{ "formattedNumber": "(323) 555-0198", "nameCode": { "codeValue": "Mobile" } }],
            "emails": [{ "emailUri": "jokonkwo@gmail.com" }]
        },
        "workerDates": {
            "originalHireDate": "2021-03-02",
            "terminationDate": None
        },
        "primaryOrganizationUnit": {
            "nameCode": { "codeValue": "ComfortFirst Healthcare" },
            "department": { "codeValue": "Skilled Nursing" }
        },
        "jobCode": { "codeValue": "LVN", "shortName": "LVN Home Health" },
        "basePayRate": {
            "rateValue": 28.00,
            "currencyCode": "USD",
            "unitCode": { "codeValue": "Hourly" }
        },
        "workerStatus": { "statusCode": { "codeValue": "Active" } },
        "_meta": {
            "employer": "ComfortFirst Healthcare",
            "avg_hours_per_week": 40.0,
            "pay_rate": 28.00,
            "scenario": "needlestick_exposure"
        }
    },

    # ── SunRise Home Care ─────────────────────────────────────────────────────
    "SR-022": {
        "associateOID": "aoid-sr-022",
        "workerID": { "idValue": "SR-022" },
        "person": {
            "legalName": {
                "givenName": "Lupe",
                "middleName": "Consuela",
                "familyName": "Hernandez",
                "formattedName": "Lupe Consuela Hernandez"
            },
            "birthDate": "1990-11-08",
            "homeAddress": {
                "lineOne": "7715 Sepulveda Blvd",
                "lineTwo": None,
                "cityName": "Van Nuys",
                "countrySubdivisionLevel1": { "codeValue": "CA" },
                "postalCode": "91405",
                "countryCode": "US"
            },
            "preferredLanguage": { "codeValue": "es" }
        },
        "businessCommunication": {
            "landlines": [{ "formattedNumber": "(818) 555-0077", "nameCode": { "codeValue": "Mobile" } }],
            "emails": [{ "emailUri": "lhernandez@hotmail.com" }]
        },
        "workerDates": {
            "originalHireDate": "2022-07-19",
            "terminationDate": None
        },
        "primaryOrganizationUnit": {
            "nameCode": { "codeValue": "SunRise Home Care" },
            "department": { "codeValue": "Personal Care Services" }
        },
        "jobCode": { "codeValue": "PCW", "shortName": "Personal Care Worker" },
        "basePayRate": {
            "rateValue": 17.25,
            "currencyCode": "USD",
            "unitCode": { "codeValue": "Hourly" }
        },
        "workerStatus": { "statusCode": { "codeValue": "Active" } },
        "_meta": {
            "employer": "SunRise Home Care",
            "avg_hours_per_week": 36.0,
            "pay_rate": 17.25,
            "scenario": "surgical_knee"
        }
    },

    # ── Edge case: Part-time / low AWW (tests TD minimum floor) ──────────────
    "CW-007": {
        "associateOID": "aoid-cw-007",
        "workerID": { "idValue": "CW-007" },
        "person": {
            "legalName": {
                "givenName": "Thanh",
                "middleName": None,
                "familyName": "Nguyen",
                "formattedName": "Thanh Nguyen"
            },
            "birthDate": "1968-04-30",
            "homeAddress": {
                "lineOne": "2210 Glendale Blvd",
                "lineTwo": "Unit 12",
                "cityName": "Los Angeles",
                "countrySubdivisionLevel1": { "codeValue": "CA" },
                "postalCode": "90039",
                "countryCode": "US"
            },
            "preferredLanguage": { "codeValue": "vi" }
        },
        "businessCommunication": {
            "landlines": [{ "formattedNumber": "(323) 555-0234" }],
            "emails": [{ "emailUri": "tnguyen2210@gmail.com" }]
        },
        "workerDates": {
            "originalHireDate": "2023-09-05",
            "terminationDate": None
        },
        "primaryOrganizationUnit": {
            "nameCode": { "codeValue": "CareWell Services" },
            "department": { "codeValue": "Companion Care" }
        },
        "jobCode": { "codeValue": "CC", "shortName": "Companion Care Worker" },
        "basePayRate": {
            "rateValue": 16.90,   # CA minimum wage 2026
            "currencyCode": "USD",
            "unitCode": { "codeValue": "Hourly" }
        },
        "workerStatus": { "statusCode": { "codeValue": "Active" } },
        "_meta": {
            "employer": "CareWell Services",
            "avg_hours_per_week": 18.0,   # Part-time — AWW will hit TD minimum floor
            "pay_rate": 16.90,
            "scenario": "td_minimum_floor"  # Tests: AWW × 2/3 < $252.03, so TD = $252.03
        }
    },

    # ── Edge case: High earner (tests TD maximum ceiling) ────────────────────
    "BC-099": {
        "associateOID": "aoid-bc-099",
        "workerID": { "idValue": "BC-099" },
        "person": {
            "legalName": {
                "givenName": "Priya",
                "middleName": None,
                "familyName": "Krishnamurthy",
                "formattedName": "Priya Krishnamurthy"
            },
            "birthDate": "1983-12-01",
            "homeAddress": {
                "lineOne": "500 S Grand Ave",
                "lineTwo": "Apt 2201",
                "cityName": "Los Angeles",
                "countrySubdivisionLevel1": { "codeValue": "CA" },
                "postalCode": "90071",
                "countryCode": "US"
            },
            "preferredLanguage": { "codeValue": "en" }
        },
        "businessCommunication": {
            "landlines": [{ "formattedNumber": "(213) 555-0310" }],
            "emails": [{ "emailUri": "pkrishnamurthy@outlook.com" }]
        },
        "workerDates": {
            "originalHireDate": "2015-02-16",
            "terminationDate": None
        },
        "primaryOrganizationUnit": {
            "nameCode": { "codeValue": "BrightCare Home Health" },
            "department": { "codeValue": "Skilled Nursing Management" }
        },
        "jobCode": { "codeValue": "RN_CM", "shortName": "RN Case Manager" },
        "basePayRate": {
            "rateValue": 65.00,
            "currencyCode": "USD",
            "unitCode": { "codeValue": "Hourly" }
        },
        "workerStatus": { "statusCode": { "codeValue": "Active" } },
        "_meta": {
            "employer": "BrightCare Home Health",
            "avg_hours_per_week": 40.0,
            "pay_rate": 65.00,
            "scenario": "td_maximum_ceiling"  # Tests: AWW × 2/3 > $1680.29, so TD = $1680.29
        }
    },

    # ── Edge case: Recently hired (few pay periods — tests sparse pay history) ─
    "HH-003": {
        "associateOID": "aoid-hh-003",
        "workerID": { "idValue": "HH-003" },
        "person": {
            "legalName": {
                "givenName": "Devon",
                "middleName": None,
                "familyName": "Washington",
                "formattedName": "Devon Washington"
            },
            "birthDate": "1998-06-14",
            "homeAddress": {
                "lineOne": "8834 Vermont Ave",
                "lineTwo": None,
                "cityName": "Los Angeles",
                "countrySubdivisionLevel1": { "codeValue": "CA" },
                "postalCode": "90044",
                "countryCode": "US"
            },
            "preferredLanguage": { "codeValue": "en" }
        },
        "businessCommunication": {
            "landlines": [{ "formattedNumber": "(323) 555-0412" }],
            "emails": [{ "emailUri": "devon.washington@gmail.com" }]
        },
        "workerDates": {
            "originalHireDate": "2026-03-10",   # Only 3 weeks ago
            "terminationDate": None
        },
        "primaryOrganizationUnit": {
            "nameCode": { "codeValue": "HomeHope Inc." },
            "department": { "codeValue": "Personal Care Services" }
        },
        "jobCode": { "codeValue": "HHA1", "shortName": "Home Health Aide I" },
        "basePayRate": {
            "rateValue": 17.50,
            "currencyCode": "USD",
            "unitCode": { "codeValue": "Hourly" }
        },
        "workerStatus": { "statusCode": { "codeValue": "Active" } },
        "_meta": {
            "employer": "HomeHope Inc.",
            "avg_hours_per_week": 32.0,
            "pay_rate": 17.50,
            "scenario": "new_hire_sparse_pay_history"  # Only 1-2 pay periods available
        }
    },
}

# Build lookup indexes
BY_OID = {v["associateOID"]: v for v in MOCK_EMPLOYEES.values()}
BY_NAME = {}
for emp in MOCK_EMPLOYEES.values():
    full = emp["person"]["legalName"]["formattedName"].lower()
    BY_NAME[full] = emp
    # Also index by last name alone
    last = emp["person"]["legalName"]["familyName"].lower()
    BY_NAME[last] = emp


# ─────────────────────────────────────────────────────────────────────────────
# PAY STATEMENT GENERATOR
# Generates realistic biweekly pay statements going back N periods.
# Includes overtime, variable hours, and occasional anomalies for realism.
# ─────────────────────────────────────────────────────────────────────────────

def generate_pay_statements(employee: dict, periods: int = 26) -> list[dict]:
    """
    Generate realistic pay statement history.
    Mirrors ADP /payroll/v1/workers/{oid}/pay-statements response shape.
    """
    meta = employee["_meta"]
    rate = meta["pay_rate"]
    avg_hrs = meta["avg_hours_per_week"]
    scenario = meta.get("scenario", "standard")

    statements = []
    today = date.today()

    for i in range(periods):
        # Each period is 2 weeks (biweekly pay)
        period_end = today - timedelta(weeks=i * 2)
        period_start = period_end - timedelta(days=13)

        # New hire edge case: skip periods before hire date
        hire_date = date.fromisoformat(employee["workerDates"]["originalHireDate"])
        if period_end < hire_date:
            break

        # Variable hours with slight randomness (±3 hrs/week for realism)
        weekly_variation = random.uniform(-3.0, 3.0)
        hours_week1 = max(0, avg_hrs + weekly_variation)
        hours_week2 = max(0, avg_hrs + random.uniform(-3.0, 3.0))
        total_regular_hours = min(hours_week1 + hours_week2, 80)  # Cap at 80 regular
        overtime_hours = max(0, (hours_week1 + hours_week2) - 80) * 0.1  # Occasional OT

        regular_pay = round(total_regular_hours * rate, 2)
        overtime_pay = round(overtime_hours * rate * 1.5, 2)
        gross_pay = regular_pay + overtime_pay

        # Occasional anomaly: very low hours (vacation, illness) — tests AWW calculation
        if random.random() < 0.08:  # ~8% chance of low-hours period
            gross_pay = round(gross_pay * 0.4, 2)
            regular_pay = gross_pay
            overtime_pay = 0
            total_regular_hours = round(total_regular_hours * 0.4, 1)

        statement = {
            "payStatementID": { "idValue": f"PS-{employee['associateOID']}-{i:03d}" },
            "payPeriodStartDate": period_start.isoformat(),
            "payPeriodEndDate": period_end.isoformat(),
            "checkDate": (period_end + timedelta(days=4)).isoformat(),  # Paid 4 days after period end
            "payFrequency": { "codeValue": "Biweekly" },
            "earnings": [
                {
                    "typeCode": { "codeValue": "REG", "shortName": "Regular Pay" },
                    "hours": round(total_regular_hours, 2),
                    "rate": rate,
                    "amount": regular_pay,
                    "currencyCode": "USD"
                },
                {
                    "typeCode": { "codeValue": "OT", "shortName": "Overtime" },
                    "hours": round(overtime_hours, 2),
                    "rate": round(rate * 1.5, 2),
                    "amount": overtime_pay,
                    "currencyCode": "USD"
                }
            ],
            "grossPay": { "amount": gross_pay, "currencyCode": "USD" },
            "netPay": { "amount": round(gross_pay * 0.72, 2), "currencyCode": "USD" },  # Approx after tax
            "deductions": [
                { "typeCode": { "codeValue": "FIT" }, "amount": round(gross_pay * 0.12, 2) },
                { "typeCode": { "codeValue": "SIT" }, "amount": round(gross_pay * 0.06, 2) },
                { "typeCode": { "codeValue": "FICA" }, "amount": round(gross_pay * 0.0765, 2) },
                { "typeCode": { "codeValue": "MEDI" }, "amount": round(gross_pay * 0.0145, 2) },
            ]
        }
        statements.append(statement)

    return statements


# ─────────────────────────────────────────────────────────────────────────────
# AWW / TD CALCULATION (mirrors what the real backend service will do)
# Included here so tests can verify the calculation logic end-to-end
# ─────────────────────────────────────────────────────────────────────────────

CA_TD_MIN_2026 = 252.03
CA_TD_MAX_2026 = 1680.29
CA_TD_FRACTION = 2 / 3

def calculate_td(statements: list[dict]) -> dict:
    if not statements:
        return { "aww": None, "td_rate": None, "error": "No pay statements found" }

    # ADP pay statements are biweekly — each is 2 weeks of wages
    # AWW = total gross / total weeks
    total_gross = sum(s["grossPay"]["amount"] for s in statements)
    total_weeks = len(statements) * 2  # Each statement = 2 weeks

    aww = total_gross / total_weeks
    td_raw = aww * CA_TD_FRACTION
    td_rate = max(CA_TD_MIN_2026, min(CA_TD_MAX_2026, td_raw))

    return {
        "aww": round(aww, 2),
        "td_raw": round(td_raw, 2),
        "td_rate": round(td_rate, 2),
        "td_min_applied": td_raw < CA_TD_MIN_2026,
        "td_max_applied": td_raw > CA_TD_MAX_2026,
        "pay_periods_used": len(statements),
        "weeks_used": total_weeks,
        "total_gross": round(total_gross, 2),
        "calculated_at": datetime.utcnow().isoformat() + "Z"
    }


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/auth/oauth/v2/token")
async def get_token():
    """
    Mock OAuth2 token endpoint.
    Always returns a valid token — no credential validation in mock.
    Real ADP requires: grant_type, client_id, client_secret as form fields.
    """
    return {
        "access_token": "mock_adp_token_" + datetime.utcnow().strftime("%Y%m%d%H%M%S"),
        "token_type": "Bearer",
        "expires_in": 3600,
        "scope": "openid profile hr-confidential payroll",
        "id_token": "mock_id_token"
    }


@app.get("/hr/v2/workers")
async def get_workers(
    filter: str = Query(None, alias="$filter"),
    top: int = Query(25, alias="$top"),
    authorization: str = Header(None)
):
    """
    Mock employee lookup.
    Supports filter by:
      - workers/workerID/idValue eq 'BC-001'           → exact ID match
      - workers/person/legalName/familyName eq 'Santos' → last name match
      - Any string containing the employee ID or name   → fuzzy match
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    if not filter:
        # Return first 25 employees if no filter
        workers = list(MOCK_EMPLOYEES.values())[:top]
        return { "workers": [_clean_worker(w) for w in workers], "totalCount": len(workers) }

    # Parse filter string to find the search value
    # Handles: eq 'BC-001', eq 'Santos', contains 'Santos', etc.
    search_value = ""
    if "eq '" in filter:
        search_value = filter.split("eq '")[1].rstrip("'").strip().lower()
    elif "contains '" in filter:
        search_value = filter.split("contains '")[1].rstrip("'").strip().lower()
    else:
        search_value = filter.lower()

    # Find matching employee
    matched = []

    # Exact ID match
    for emp_id, emp in MOCK_EMPLOYEES.items():
        if emp_id.lower() == search_value:
            matched.append(emp)
            break

    # associateOID match
    if not matched and search_value in BY_OID:
        matched.append(BY_OID[search_value])

    # Name match (exact then partial)
    if not matched:
        for name, emp in BY_NAME.items():
            if name == search_value:
                matched.append(emp)
                break

    if not matched:
        for name, emp in BY_NAME.items():
            if search_value in name:
                matched.append(emp)
                break

    if not matched:
        return { "workers": [], "totalCount": 0 }

    return {
        "workers": [_clean_worker(w) for w in matched[:top]],
        "totalCount": len(matched)
    }


@app.get("/hr/v2/workers/{associate_oid}")
async def get_worker_by_oid(
    associate_oid: str,
    authorization: str = Header(None)
):
    """Fetch a single employee by associateOID."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")

    emp = BY_OID.get(associate_oid)
    if not emp:
        raise HTTPException(status_code=404, detail=f"Worker {associate_oid} not found")

    return { "workers": [_clean_worker(emp)] }


@app.get("/payroll/v1/workers/{associate_oid}/pay-statements")
async def get_pay_statements(
    associate_oid: str,
    top: int = Query(26, alias="$top"),
    authorization: str = Header(None)
):
    """
    Return pay statements for an employee.
    Generates realistic biweekly statements going back `top` periods (default 26 = 52 weeks).
    Also returns the calculated AWW and TD rate for convenience.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")

    emp = BY_OID.get(associate_oid)
    if not emp:
        raise HTTPException(status_code=404, detail=f"Worker {associate_oid} not found")

    statements = generate_pay_statements(emp, periods=top)
    td_calc = calculate_td(statements)

    return {
        "payStatements": statements,
        "totalCount": len(statements),
        # Mock convenience field — not in real ADP response
        # Strip this before connecting to real ADP
        "_mockCalculations": {
            "aww": td_calc["aww"],
            "td_rate": td_calc["td_rate"],
            "td_min_applied": td_calc["td_min_applied"],
            "td_max_applied": td_calc["td_max_applied"],
            "pay_periods_used": td_calc["pay_periods_used"],
            "scenario": emp["_meta"]["scenario"],
            "note": "Remove _mockCalculations before connecting to real ADP"
        }
    }


@app.get("/mock/employees")
async def list_mock_employees():
    """
    Non-ADP endpoint — lists all available mock employees for testing reference.
    Not present in real ADP. Remove this route before connecting to production.
    """
    return {
        "employees": [
            {
                "id": emp_id,
                "associateOID": emp["associateOID"],
                "name": emp["person"]["legalName"]["formattedName"],
                "employer": emp["_meta"]["employer"],
                "pay_rate": emp["_meta"]["pay_rate"],
                "avg_hours_per_week": emp["_meta"]["avg_hours_per_week"],
                "scenario": emp["_meta"]["scenario"],
                "home_zip": emp["person"]["homeAddress"]["postalCode"]
            }
            for emp_id, emp in MOCK_EMPLOYEES.items()
        ],
        "test_scenarios": {
            "standard_lifting_injury": "BC-001 — Maria Santos — normal AWW, routine claim",
            "repeat_claimant": "BC-002 — Rosa Gutierrez — prior claims history",
            "needlestick_exposure": "CF-014 — James Okonkwo — LVN, Hep-C exposure",
            "surgical_knee": "SR-022 — Lupe Hernandez — meniscus tear, surgical case",
            "td_minimum_floor": "CW-007 — Thanh Nguyen — part-time, AWW × 2/3 < $252.03",
            "td_maximum_ceiling": "BC-099 — Priya Krishnamurthy — RN, AWW × 2/3 > $1680.29",
            "new_hire_sparse_pay_history": "HH-003 — Devon Washington — hired 3 weeks ago"
        }
    }


@app.get("/health")
async def health():
    return { "status": "ok", "service": "Mock ADP Workforce Now", "timestamp": datetime.utcnow().isoformat() }


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _clean_worker(emp: dict) -> dict:
    """Remove mock-only _meta field before returning to caller."""
    return { k: v for k, v in emp.items() if k != "_meta" }


# ─────────────────────────────────────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    print("\n" + "="*60)
    print("  Mock ADP Workforce Now")
    print("  http://localhost:8001")
    print("="*60)
    print("\n  Available employees:")
    for emp_id, emp in MOCK_EMPLOYEES.items():
        name = emp["person"]["legalName"]["formattedName"]
        scenario = emp["_meta"]["scenario"]
        print(f"  {emp_id:10s}  {name:<30s}  [{scenario}]")
    print("\n  Test endpoints:")
    print("  GET  /mock/employees                          → list all test employees")
    print("  POST /auth/oauth/v2/token                     → get mock token")
    print("  GET  /hr/v2/workers?$filter=...               → look up employee")
    print("  GET  /payroll/v1/workers/{oid}/pay-statements → get pay history")
    print("  GET  /health                                  → health check")
    print("\n  Set in .env.test:")
    print("  ADP_BASE_URL=http://localhost:8001")
    print("  ADP_CLIENT_ID=mock")
    print("  ADP_CLIENT_SECRET=mock")
    print("="*60 + "\n")
    uvicorn.run(app, host="0.0.0.0", port=8001)
