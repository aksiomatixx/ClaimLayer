# California Workers' Compensation — Regulatory Constraints

This document captures **why** certain features are built the way they are, and which deadlines are statutory (enforced by law with penalties) versus operational (best practice). Every deadline in this document is reflected in the diary engine.

**When in doubt:** Escalate to Akash. Do not make assumptions about California WC law.

---

## The Most Important Rules (Read These First)

### 1. AI Can Approve. AI Cannot Deny.
**Source:** DWC FAQ on UR — "Decisions to approve treatment requests may be made by claims adjusters, other non-physician reviewers, nurses, or physicians. Decisions to modify or deny treatment requests may only be made by physicians."

**Implication for the codebase:** The RFA evaluation logic must have exactly two output paths:
- `approve` → system issues authorization, logged by Akash (non-physician approval is legal)
- `route_to_uro` → packaged and sent to Enlyte, a licensed physician makes the modification or denial

There is no third path where the system denies an RFA. If you see code that auto-denies an RFA, it is wrong and must be removed.

### 2. Missed RFA Response = Deemed Approved
**Source:** CCR §9792.9.1(c)(3) and LC §4610

The clock starts the moment an RFA is received — whether by the claims administrator, the adjuster, or the URO. Standard review: 5 business days. Expedited review: 72 hours.

If we don't respond in time, the treatment is **deemed approved by operation of law** — regardless of medical necessity.

**Implication for the codebase:** RFA receipt triggers an immediate high-priority diary. The diary escalates to Akash's action queue at T-48 hours. If the diary is not completed by the deadline, it becomes a critical alert. There is no scenario where an RFA ages past its deadline silently.

### 3. First TD Payment: 14 Days from Knowledge of Disability
**Source:** LC §4650

If an injured worker is taken off work, the first TD payment must be issued within 14 days of the employer's knowledge of the disability. Late payment incurs a 10% self-imposed penalty on the delayed amount.

**Implication for the codebase:** When a PR-2 or DWC-5020 indicates the worker is off work, a diary is created immediately: `TD_PAYMENT_DUE` with due date = today + 14 days. This diary cannot be snoozed.

### 4. First 30 Days: No Prospective UR
**Source:** LC §4610(b)

For injuries on or after January 1, 2018: treatment from an MPN provider within the first 30 days of the injury date that is consistent with MTUS does not require prospective UR. Do not send these RFAs to Enlyte. Auto-approve them.

**Exception:** Certain drugs and procedures listed in CCR §9792.6.1 are excluded from this rule. Check the exclusion list before auto-approving under the 30-day rule.

---

## Statutory Deadlines Table

| Trigger | Deadline | Penalty for Violation | Source |
|---|---|---|---|
| Claim form (DWC-1) received | Issue within 1 day of receipt | WCAB sanctions | LC §5401 |
| Claim filed | Accept or deny within 90 days | Presumed compensable after 90 days | LC §5402 |
| Compensability investigation | Benefits must begin within 14 days of DOI | 10% late payment penalty | LC §4650 |
| First TD payment | Within 14 days of knowledge of disability | 10% self-imposed penalty | LC §4650 |
| Subsequent TD payments | Every 14 days | 10% penalty per late payment | LC §4650 |
| TD terminated | Notice to worker required | WCAB sanctions | LC §4650(b) |
| RFA received (standard) | UR decision within 5 business days | Treatment deemed approved | CCR §9792.9.1 |
| RFA received (expedited) | UR decision within 72 hours | Treatment deemed approved | LC §4610(i)(3) |
| UR denial issued | Written decision to worker within 2 business days | Void UR decision | LC §4610(h)(1)(B) |
| UR denial issued | IMR rights notice to worker | WCAB sanctions | LC §4610.5 |
| PR-2 submitted by physician | Within 5 working days of exam | CCR §9785 sanctions | CCR §9785 |
| DWC-7 (notice of representation) | Within 5 days of claim receipt | CDI regulatory action | CCR §10072 |
| MPN notification to employee | Within 30 days of employment / hire | Loss of right to direct care | CCR §9767.12 |
| IMR request by worker | Within 30 days of UR denial | IMR right forfeited | LC §4610.5(h) |
| QME panel request | Within 10 days of dispute | Waiver of QME rights | CCR §31.1 |

---

## The Claim State Machine

Every claim moves through defined statuses. Invalid transitions should be rejected by the database.

```
new_claim
    ↓
intake_complete          (employee intake submitted)
    ↓
under_investigation      (compensability being evaluated — UR may be deferred)
    ↓
accepted                 (compensability confirmed — benefits flowing)
    ↓
active_medical           (treatment ongoing, reserves adjusting)
    ↓
p_and_s                  (Permanent and Stationary — worker reached MMI)
    ↓
pd_evaluation            (Permanent Disability rating pending)
    ↓
settlement_discussions   (C&R or Stipulated Award negotiations)
    ↓
closed                   (claim resolved — reserves zeroed, FileHandler closed)

Parallel statuses (can exist alongside the above):
    litigated            (WCAB Application for Adjudication filed)
    denied               (compensability denied — denial letter issued, IMR rights provided)
    deferred             (UR deferred pending liability determination)
```

---

## RFA Decision Logic

```
RFA received
    │
    ├── Is claim under compensability investigation?
    │   YES → Issue deferral notice within 5 days (CCR §9792.9.1(b))
    │          Create diary: LIABILITY_DETERMINATION_PENDING
    │
    ├── Is this within first 30 days AND MPN provider AND MTUS-consistent?
    │   YES → AUTO-APPROVE (no prospective UR required per LC §4610(b))
    │          Exception: check CCR §9792.6.1 exclusion list first
    │
    ├── Does treatment type, frequency, and duration fall within MTUS parameters
    │   for the accepted diagnosis?
    │   YES + HIGH CONFIDENCE → AUTO-APPROVE
    │   YES + LOW CONFIDENCE  → ADJUSTER REVIEW (Akash approves)
    │
    ├── Is this a surgical procedure?
    │   YES → ROUTE TO ENLYTE URO (physician review required)
    │
    ├── Is the drug on the MTUS Drug Formulary (exempt list)?
    │   YES → AUTO-APPROVE
    │   NO  → ROUTE TO ENLYTE URO
    │
    ├── Does the treatment exceed MTUS frequency or duration limits?
    │   YES → ROUTE TO ENLYTE URO
    │
    └── Is the treatment experimental or not addressed by MTUS?
        YES → ROUTE TO ENLYTE URO (physician review required)
```

---

## UR Plan Requirements

HomeCare TPA is required to file a UR plan with the DWC. The plan must describe:

1. The UR process, including who makes approval vs. denial decisions
2. The medical director (contracted with Enlyte — confirm name and license number)
3. The criteria used for treatment decisions (MTUS/ACOEM)
4. The timeline for decisions
5. The process for expedited reviews
6. How disputes are resolved (IMR)
7. How the UR plan is communicated to treating physicians

**The UR plan must be updated when the process changes.** If the RFA routing logic changes materially, Akash must update the filed UR plan before the new logic goes live.

---

## HIPAA in the WC Context

**The HIPAA Privacy Rule does not apply to WC insurers, TPAs, administrative agencies, or employers.** (45 CFR §164.512(l))

This means:
- We do not need patient authorization to request records from treating physicians on WC claims
- Providers may disclose PHI to us without patient authorization as authorized by California WC law
- We are not a HIPAA "covered entity" in the traditional sense

**However:**
- Our vendors (FileHandler, Manifest MedEx, Health Gorilla, Enlyte) ARE HIPAA covered entities or business associates
- We must sign BAAs with all of them
- We must maintain data security standards consistent with HIPAA even if not strictly required (best practice and contractually required by vendors)
- We are subject to California CMIA (Confidentiality of Medical Information Act) which has stricter protections than HIPAA in some areas

---

## California DxF Compliance

HomeCare TPA must sign the CalHHS Data Exchange Framework Data Sharing Agreement (DSA) to participate in DxF. This is required to connect to Manifest MedEx as a QHIO participant.

**As a DxF participant:**
- We are entitled to request health information for treatment, payment, and healthcare operations purposes
- Providers are required to respond to our payment-purpose queries
- We must follow DxF policies and procedures for data use and security
- We are subject to the DxF's privacy standards (in addition to HIPAA)

**Data use limitations:**
- DxF data may only be used for the exchange purpose stated in the request (payment, treatment, etc.)
- DxF data may not be sold or used for secondary commercial purposes
- Patient data must be deleted from our systems in accordance with DxF retention policies when a claim closes

---

## Audit Readiness

The DWC conducts Performance Audit Reviews (PARs) that include UR investigations. They pull random RFA samples and check:

1. Was the RFA received and date-stamped?
2. Was the UR decision made within the statutory timeframe?
3. Does the written decision contain all required elements?
4. Was the IMR rights notice provided if the decision was a denial?
5. Were required notices sent to all required parties (physician, worker, attorney)?

**Everything in this system must be logged with timestamp.** The DWC auditor should be able to pull any RFA from any claim and see: date received, who evaluated it, what the decision was, when it was communicated, and what notices were sent. This is not optional. It is the difference between a clean audit and a penalty assessment.

---

*This document should be reviewed by Akash whenever California DWC publishes regulatory updates. The DWC publishes updates at dir.ca.gov/dwc/. Subscribe to the DWC mailing list for automatic notifications.*
