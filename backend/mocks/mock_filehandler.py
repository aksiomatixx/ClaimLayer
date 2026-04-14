"""
Mock FileHandler Enterprise API Server
========================================
Mimics the FileHandler Enterprise REST API responses for local development.
Use this during development and testing before connecting to the live system.

Endpoints implemented:
  POST   /claims                              → Create claim record
  GET    /claims                              → List claims
  GET    /claims/:id                          → Get single claim
  PATCH  /claims/:id                          → Update claim
  POST   /claims/:id/reserves                 → Set / update reserves
  GET    /claims/:id/reserves                 → Get reserve history
  POST   /claims/:id/documents               → Attach document (base64)
  GET    /claims/:id/documents               → List documents on claim
  POST   /claims/:id/diaries                  → Create diary entry
  GET    /claims/:id/diaries                  → List diaries on claim
  PATCH  /claims/:id/diaries/:diary_id        → Complete / update diary
  POST   /claims/:id/payments                 → Record payment
  GET    /claims/:id/payments                 → List payments
  GET    /claims/:id/ledger                   → Full audit ledger
  GET    /claims/:id/notes                    → Claim notes
  POST   /claims/:id/notes                    → Add note

Run with:
  pip install fastapi uvicorn
  python mock_filehandler.py

Server starts on http://localhost:8002
Set FILEHANDLER_BASE_URL=http://localhost:8002 in your .env.test
Set FILEHANDLER_API_KEY=mock-fh-key in your .env.test
"""

from fastapi import FastAPI, Header, HTTPException, Path
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, date
from uuid import uuid4
import base64

app = FastAPI(title="Mock FileHandler Enterprise", version="1.0.0")

MOCK_API_KEY = "mock-fh-key"

# ─────────────────────────────────────────────────────────────────────────────
# IN-MEMORY STORE
# Resets on server restart — clean slate for every test run.
# ─────────────────────────────────────────────────────────────────────────────

db = {
    "claims": {},       # claim_id → claim record
    "reserves": {},     # claim_id → list of reserve records
    "documents": {},    # claim_id → list of document records
    "diaries": {},      # claim_id → list of diary records
    "payments": {},     # claim_id → list of payment records
    "ledger": {},       # claim_id → list of all financial events
    "notes": {},        # claim_id → list of notes
}

def now_str():
    return datetime.utcnow().isoformat() + "Z"

def short_id(prefix="fh"):
    return f"{prefix}_{str(uuid4()).replace('-','')[:12]}"

def auth(key: str):
    if key != f"Bearer {MOCK_API_KEY}":
        raise HTTPException(status_code=401, detail="Invalid API key")

def get_claim_or_404(claim_id: str):
    c = db["claims"].get(claim_id)
    if not c:
        raise HTTPException(status_code=404, detail=f"Claim {claim_id} not found")
    return c

def append_ledger(claim_id: str, event_type: str, amount: float, description: str, user: str = "API"):
    db["ledger"].setdefault(claim_id, []).append({
        "ledger_id": short_id("ldg"),
        "claim_id": claim_id,
        "event_type": event_type,
        "amount": amount,
        "description": description,
        "performed_by": user,
        "timestamp": now_str()
    })


# ─────────────────────────────────────────────────────────────────────────────
# PYDANTIC MODELS (request bodies)
# Mirrors what our backend services will POST to FileHandler.
# ─────────────────────────────────────────────────────────────────────────────

class CreateClaimRequest(BaseModel):
    claimNumber: str
    claimantFirstName: str
    claimantLastName: str
    claimantDOB: Optional[str] = None
    employerName: str
    dateOfInjury: str
    bodyPart: Optional[str] = None
    injuryType: Optional[str] = None
    stateOfJurisdiction: str = "CA"
    lineOfBusiness: str = "WC"
    adjusterName: Optional[str] = None
    adjusterEmail: Optional[str] = None

class UpdateClaimRequest(BaseModel):
    status: Optional[str] = None
    adjusterName: Optional[str] = None
    adjusterEmail: Optional[str] = None
    compensabilityDecision: Optional[str] = None
    denialReason: Optional[str] = None

class SetReservesRequest(BaseModel):
    medicalReserve: float
    indemnityReserve: float
    expenseReserve: float
    reason: str
    setBy: str = "ADJUSTER"
    approvedBy: Optional[str] = None

class AttachDocumentRequest(BaseModel):
    docType: str
    description: str
    receivedDate: Optional[str] = None
    file: str                          # base64-encoded file content
    fileName: Optional[str] = None
    mimeType: str = "application/pdf"

class CreateDiaryRequest(BaseModel):
    diaryType: str
    dueDate: str                       # ISO date string YYYY-MM-DD
    assignedTo: Optional[str] = None
    priority: str = "normal"           # critical | high | normal | low
    notes: Optional[str] = None
    autoGeneratedBy: Optional[str] = None

class CompleteDiaryRequest(BaseModel):
    status: str                        # completed | cancelled | escalated
    completedDate: Optional[str] = None
    completedBy: Optional[str] = None
    resolutionNotes: Optional[str] = None

class RecordPaymentRequest(BaseModel):
    paymentType: str                   # TD | MED | EXP | PD | CR
    amount: float
    payee: str
    payeeTaxId: Optional[str] = None
    periodFrom: Optional[str] = None
    periodTo: Optional[str] = None
    checkDate: Optional[str] = None
    memo: Optional[str] = None
    checkNumber: Optional[str] = None

class AddNoteRequest(BaseModel):
    noteText: str
    noteType: str = "general"          # general | diary | payment | reserve | document
    addedBy: str = "SYSTEM"
    isPrivate: bool = False


# ─────────────────────────────────────────────────────────────────────────────
# CLAIMS
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/claims", status_code=201)
async def create_claim(body: CreateClaimRequest, authorization: str = Header(None)):
    auth(authorization)

    # Check for duplicate claim number
    for c in db["claims"].values():
        if c["claimNumber"] == body.claimNumber:
            raise HTTPException(status_code=409, detail=f"Claim {body.claimNumber} already exists")

    claim_id = short_id("clm")
    claim = {
        "claimId": claim_id,
        "claimNumber": body.claimNumber,
        "claimantFirstName": body.claimantFirstName,
        "claimantLastName": body.claimantLastName,
        "claimantDOB": body.claimantDOB,
        "claimantFullName": f"{body.claimantFirstName} {body.claimantLastName}",
        "employerName": body.employerName,
        "dateOfInjury": body.dateOfInjury,
        "bodyPart": body.bodyPart,
        "injuryType": body.injuryType,
        "stateOfJurisdiction": body.stateOfJurisdiction,
        "lineOfBusiness": body.lineOfBusiness,
        "adjusterName": body.adjusterName,
        "adjusterEmail": body.adjusterEmail,
        "status": "open",
        "compensabilityDecision": "pending",
        "currentMedicalReserve": 0.0,
        "currentIndemnityReserve": 0.0,
        "currentExpenseReserve": 0.0,
        "totalReserve": 0.0,
        "totalPaid": 0.0,
        "totalIncurred": 0.0,
        "createdAt": now_str(),
        "updatedAt": now_str(),
        "createdBy": "API",
    }

    db["claims"][claim_id] = claim
    db["reserves"][claim_id] = []
    db["documents"][claim_id] = []
    db["diaries"][claim_id] = []
    db["payments"][claim_id] = []
    db["ledger"][claim_id] = []
    db["notes"][claim_id] = []

    append_ledger(claim_id, "CLAIM_CREATED", 0, f"Claim {body.claimNumber} created")

    return {
        "claimId": claim_id,
        "claimNumber": body.claimNumber,
        "status": "open",
        "message": "Claim created successfully",
        "createdAt": claim["createdAt"]
    }


@app.get("/claims")
async def list_claims(authorization: str = Header(None)):
    auth(authorization)
    return {
        "claims": list(db["claims"].values()),
        "totalCount": len(db["claims"])
    }


@app.get("/claims/{claim_id}")
async def get_claim(claim_id: str, authorization: str = Header(None)):
    auth(authorization)
    return get_claim_or_404(claim_id)


@app.patch("/claims/{claim_id}")
async def update_claim(claim_id: str, body: UpdateClaimRequest, authorization: str = Header(None)):
    auth(authorization)
    claim = get_claim_or_404(claim_id)

    if body.status: claim["status"] = body.status
    if body.adjusterName: claim["adjusterName"] = body.adjusterName
    if body.adjusterEmail: claim["adjusterEmail"] = body.adjusterEmail
    if body.compensabilityDecision: claim["compensabilityDecision"] = body.compensabilityDecision
    if body.denialReason: claim["denialReason"] = body.denialReason
    claim["updatedAt"] = now_str()

    append_ledger(claim_id, "CLAIM_UPDATED", 0, f"Claim updated: {body.dict(exclude_none=True)}")
    return {"message": "Claim updated", "claimId": claim_id}


# ─────────────────────────────────────────────────────────────────────────────
# RESERVES
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/claims/{claim_id}/reserves", status_code=201)
async def set_reserves(claim_id: str, body: SetReservesRequest, authorization: str = Header(None)):
    auth(authorization)
    claim = get_claim_or_404(claim_id)

    reserve_id = short_id("res")
    total = body.medicalReserve + body.indemnityReserve + body.expenseReserve

    # Snapshot previous reserves for ledger
    prev_total = claim["totalReserve"]

    record = {
        "reserveId": reserve_id,
        "claimId": claim_id,
        "medicalReserve": body.medicalReserve,
        "indemnityReserve": body.indemnityReserve,
        "expenseReserve": body.expenseReserve,
        "totalReserve": total,
        "reason": body.reason,
        "setBy": body.setBy,
        "approvedBy": body.approvedBy,
        "createdAt": now_str()
    }

    db["reserves"][claim_id].append(record)

    # Update claim's current reserves
    claim["currentMedicalReserve"] = body.medicalReserve
    claim["currentIndemnityReserve"] = body.indemnityReserve
    claim["currentExpenseReserve"] = body.expenseReserve
    claim["totalReserve"] = total
    claim["totalIncurred"] = total + claim["totalPaid"]
    claim["updatedAt"] = now_str()

    append_ledger(claim_id, "RESERVE_SET", total,
                  f"Reserves set: Med ${body.medicalReserve:,.2f} / Ind ${body.indemnityReserve:,.2f} / Exp ${body.expenseReserve:,.2f} — {body.reason}",
                  body.setBy)

    return {
        "reserveId": reserve_id,
        "claimId": claim_id,
        "previousTotal": prev_total,
        "newTotal": total,
        "change": total - prev_total,
        "createdAt": record["createdAt"]
    }


@app.get("/claims/{claim_id}/reserves")
async def get_reserves(claim_id: str, authorization: str = Header(None)):
    auth(authorization)
    get_claim_or_404(claim_id)
    records = db["reserves"].get(claim_id, [])
    return {
        "reserves": records,
        "totalCount": len(records),
        "current": records[-1] if records else None
    }


# ─────────────────────────────────────────────────────────────────────────────
# DOCUMENTS
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/claims/{claim_id}/documents", status_code=201)
async def attach_document(claim_id: str, body: AttachDocumentRequest, authorization: str = Header(None)):
    auth(authorization)
    get_claim_or_404(claim_id)

    # Validate base64
    try:
        file_bytes = base64.b64decode(body.file)
        file_size = len(file_bytes)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 file content")

    doc_id = short_id("doc")
    record = {
        "documentId": doc_id,
        "claimId": claim_id,
        "docType": body.docType,
        "description": body.description,
        "fileName": body.fileName or f"{body.docType.lower()}_{claim_id}.pdf",
        "mimeType": body.mimeType,
        "fileSizeBytes": file_size,
        "receivedDate": body.receivedDate or date.today().isoformat(),
        "uploadedAt": now_str(),
        "uploadedBy": "API",
        # In mock: we store a truncated preview. Real FH stores the file.
        "storageRef": f"mock://documents/{claim_id}/{doc_id}",
        "downloadUrl": f"http://localhost:8002/claims/{claim_id}/documents/{doc_id}/download"
    }

    db["documents"][claim_id].append(record)
    append_ledger(claim_id, "DOCUMENT_ATTACHED", 0, f"Document attached: {body.docType} — {body.description}")

    return {
        "documentId": doc_id,
        "claimId": claim_id,
        "docType": body.docType,
        "fileSizeBytes": file_size,
        "uploadedAt": record["uploadedAt"],
        "downloadUrl": record["downloadUrl"]
    }


@app.get("/claims/{claim_id}/documents")
async def list_documents(claim_id: str, authorization: str = Header(None)):
    auth(authorization)
    get_claim_or_404(claim_id)
    records = db["documents"].get(claim_id, [])
    return {"documents": records, "totalCount": len(records)}


@app.get("/claims/{claim_id}/documents/{doc_id}/download")
async def download_document(claim_id: str, doc_id: str, authorization: str = Header(None)):
    """Returns a mock PDF placeholder — real FileHandler returns the actual file."""
    auth(authorization)
    # Return a minimal valid PDF as bytes
    mock_pdf = base64.b64encode(b"%PDF-1.4 mock document content").decode()
    return {"documentId": doc_id, "content": mock_pdf, "mimeType": "application/pdf"}


# ─────────────────────────────────────────────────────────────────────────────
# DIARIES
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/claims/{claim_id}/diaries", status_code=201)
async def create_diary(claim_id: str, body: CreateDiaryRequest, authorization: str = Header(None)):
    auth(authorization)
    get_claim_or_404(claim_id)

    diary_id = short_id("diy")
    record = {
        "diaryId": diary_id,
        "claimId": claim_id,
        "diaryType": body.diaryType,
        "dueDate": body.dueDate,
        "assignedTo": body.assignedTo,
        "priority": body.priority,
        "notes": body.notes,
        "autoGeneratedBy": body.autoGeneratedBy,
        "status": "open",
        "completedAt": None,
        "completedBy": None,
        "resolutionNotes": None,
        "createdAt": now_str(),
        "updatedAt": now_str()
    }

    db["diaries"][claim_id].append(record)
    append_ledger(claim_id, "DIARY_CREATED", 0,
                  f"Diary created: {body.diaryType} due {body.dueDate} [{body.priority}]")

    return {
        "diaryId": diary_id,
        "claimId": claim_id,
        "diaryType": body.diaryType,
        "dueDate": body.dueDate,
        "priority": body.priority,
        "status": "open",
        "createdAt": record["createdAt"]
    }


@app.get("/claims/{claim_id}/diaries")
async def list_diaries(
    claim_id: str,
    status: Optional[str] = None,
    authorization: str = Header(None)
):
    auth(authorization)
    get_claim_or_404(claim_id)
    records = db["diaries"].get(claim_id, [])
    if status:
        records = [d for d in records if d["status"] == status]
    open_count = sum(1 for d in db["diaries"].get(claim_id, []) if d["status"] == "open")
    return {
        "diaries": records,
        "totalCount": len(records),
        "openCount": open_count
    }


@app.patch("/claims/{claim_id}/diaries/{diary_id}")
async def update_diary(
    claim_id: str,
    diary_id: str,
    body: CompleteDiaryRequest,
    authorization: str = Header(None)
):
    auth(authorization)
    get_claim_or_404(claim_id)

    diary = next((d for d in db["diaries"].get(claim_id, []) if d["diaryId"] == diary_id), None)
    if not diary:
        raise HTTPException(status_code=404, detail=f"Diary {diary_id} not found on claim {claim_id}")

    diary["status"] = body.status
    diary["completedAt"] = body.completedDate or now_str()
    diary["completedBy"] = body.completedBy or "SYSTEM"
    diary["resolutionNotes"] = body.resolutionNotes
    diary["updatedAt"] = now_str()

    append_ledger(claim_id, f"DIARY_{body.status.upper()}", 0,
                  f"Diary {diary['diaryType']} {body.status}: {body.resolutionNotes or 'no notes'}")

    return {
        "diaryId": diary_id,
        "status": body.status,
        "completedAt": diary["completedAt"],
        "message": f"Diary {body.status}"
    }


# ─────────────────────────────────────────────────────────────────────────────
# PAYMENTS
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/claims/{claim_id}/payments", status_code=201)
async def record_payment(claim_id: str, body: RecordPaymentRequest, authorization: str = Header(None)):
    auth(authorization)
    claim = get_claim_or_404(claim_id)

    payment_id = short_id("pay")
    check_num = body.checkNumber or f"CHK{str(uuid4().int)[:8]}"

    record = {
        "paymentId": payment_id,
        "claimId": claim_id,
        "paymentType": body.paymentType,
        "amount": body.amount,
        "payee": body.payee,
        "payeeTaxId": body.payeeTaxId,
        "periodFrom": body.periodFrom,
        "periodTo": body.periodTo,
        "checkDate": body.checkDate or date.today().isoformat(),
        "checkNumber": check_num,
        "memo": body.memo,
        "status": "issued",
        "issuedAt": now_str()
    }

    db["payments"][claim_id].append(record)

    # Update claim totals
    claim["totalPaid"] = claim["totalPaid"] + body.amount
    claim["totalIncurred"] = claim["totalReserve"] + claim["totalPaid"]
    claim["updatedAt"] = now_str()

    append_ledger(claim_id, f"PAYMENT_{body.paymentType}", body.amount,
                  f"Payment issued: {body.paymentType} ${body.amount:,.2f} to {body.payee} — {body.memo or 'no memo'}",
                  "PAYMENT_ENGINE")

    return {
        "paymentId": payment_id,
        "claimId": claim_id,
        "checkNumber": check_num,
        "amount": body.amount,
        "payee": body.payee,
        "checkDate": record["checkDate"],
        "status": "issued"
    }


@app.get("/claims/{claim_id}/payments")
async def list_payments(claim_id: str, authorization: str = Header(None)):
    auth(authorization)
    get_claim_or_404(claim_id)
    records = db["payments"].get(claim_id, [])
    total = sum(p["amount"] for p in records)
    return {
        "payments": records,
        "totalCount": len(records),
        "totalPaid": round(total, 2)
    }


# ─────────────────────────────────────────────────────────────────────────────
# LEDGER
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/claims/{claim_id}/ledger")
async def get_ledger(claim_id: str, authorization: str = Header(None)):
    """
    Returns every financial and operational event on the claim in chronological order.
    This is what the DWC PAR auditor pulls during an audit.
    """
    auth(authorization)
    claim = get_claim_or_404(claim_id)
    events = db["ledger"].get(claim_id, [])

    return {
        "claimId": claim_id,
        "claimNumber": claim["claimNumber"],
        "totalEvents": len(events),
        "totalReserve": claim["totalReserve"],
        "totalPaid": claim["totalPaid"],
        "totalIncurred": claim["totalIncurred"],
        "events": events
    }


# ─────────────────────────────────────────────────────────────────────────────
# NOTES
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/claims/{claim_id}/notes")
async def get_notes(claim_id: str, authorization: str = Header(None)):
    auth(authorization)
    get_claim_or_404(claim_id)
    return {"notes": db["notes"].get(claim_id, []), "totalCount": len(db["notes"].get(claim_id, []))}


@app.post("/claims/{claim_id}/notes", status_code=201)
async def add_note(claim_id: str, body: AddNoteRequest, authorization: str = Header(None)):
    auth(authorization)
    get_claim_or_404(claim_id)

    note_id = short_id("nte")
    record = {
        "noteId": note_id,
        "claimId": claim_id,
        "noteText": body.noteText,
        "noteType": body.noteType,
        "addedBy": body.addedBy,
        "isPrivate": body.isPrivate,
        "addedAt": now_str()
    }
    db["notes"][claim_id].append(record)
    return {"noteId": note_id, "addedAt": record["addedAt"]}


# ─────────────────────────────────────────────────────────────────────────────
# MOCK-ONLY UTILITY ENDPOINTS
# Not present in real FileHandler. For testing convenience only.
# Remove references before connecting to production.
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/mock/claims")
async def list_all_claims_summary():
    """Dev convenience: list all claims with summary stats. Not in real FH."""
    return {
        "totalClaims": len(db["claims"]),
        "claims": [
            {
                "claimId": c["claimId"],
                "claimNumber": c["claimNumber"],
                "claimant": c["claimantFullName"],
                "employer": c["employerName"],
                "status": c["status"],
                "totalReserve": c["totalReserve"],
                "totalPaid": c["totalPaid"],
                "documents": len(db["documents"].get(c["claimId"], [])),
                "diariesOpen": sum(1 for d in db["diaries"].get(c["claimId"], []) if d["status"] == "open"),
                "payments": len(db["payments"].get(c["claimId"], []))
            }
            for c in db["claims"].values()
        ]
    }


@app.delete("/mock/reset")
async def reset_database():
    """Dev convenience: wipe all data for a clean test run. Not in real FH."""
    for key in db:
        db[key] = {}
    return {"message": "Mock database reset", "timestamp": now_str()}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "Mock FileHandler Enterprise",
        "claimsInMemory": len(db["claims"]),
        "timestamp": now_str()
    }


# ─────────────────────────────────────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    print("\n" + "="*60)
    print("  Mock FileHandler Enterprise")
    print("  http://localhost:8002")
    print("="*60)
    print("\n  Endpoints:")
    print("  POST   /claims                          → Create claim")
    print("  GET    /claims/:id                      → Get claim")
    print("  POST   /claims/:id/reserves             → Set reserves")
    print("  POST   /claims/:id/documents            → Attach document")
    print("  POST   /claims/:id/diaries              → Create diary")
    print("  PATCH  /claims/:id/diaries/:id          → Complete diary")
    print("  POST   /claims/:id/payments             → Record payment")
    print("  GET    /claims/:id/ledger               → Full audit ledger")
    print("  GET    /mock/claims                     → Summary of all claims")
    print("  DELETE /mock/reset                      → Reset all data")
    print("  GET    /health                          → Health check")
    print("\n  Set in .env.test:")
    print("  FILEHANDLER_BASE_URL=http://localhost:8002")
    print("  FILEHANDLER_API_KEY=mock-fh-key")
    print("\n  Interactive docs:")
    print("  http://localhost:8002/docs")
    print("="*60 + "\n")
    uvicorn.run(app, host="0.0.0.0", port=8002)
