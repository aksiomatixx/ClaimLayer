# HomeCare TPA

**Claude-powered agentic deployment reference for regulated insurance workflows**

HomeCare TPA is a **pre-release, production-oriented reference implementation** of an AI-assisted workers’ compensation claims administration platform. It is designed to demonstrate how Claude-powered agents can be deployed into high-stakes, regulated enterprise workflows with bounded outputs, human-in-the-loop controls, audit logging, and compliance guardrails.

This project is not presented as a live customer production system. It is a technical and product architecture artifact showing how I would scope, build, govern, and deploy agentic AI into a regulated claims environment.

---

## For Anthropic Reviewers

This repository was built to demonstrate the skills most relevant to Anthropic’s **Technical Deployment Lead** role:

- Translating a complex regulated business process into an AI-assisted workflow
- Defining safe MVP boundaries for high-stakes agentic systems
- Designing agent workflows with explicit guardrails and human decision checkpoints
- Building auditability into every model-assisted decision
- Mapping domain rules, statutory deadlines, and compliance constraints into system behavior
- Packaging a technical solution so both business stakeholders and engineering reviewers can understand it quickly

### Best 90-second review path

1. Watch the short demo video: **[insert demo video link]**
2. Open the clickable demo: **[insert deployed demo link]**
3. Review the system architecture: `docs/architecture.md`
4. Inspect Claude integration and structured output handling: `backend/src/services/aiService.js`
5. Inspect the RFA guardrail workflow: `backend/src/services/rfaService.js`
6. Inspect model audit logging: `backend/src/services/aiDecisionsService.js`
7. Inspect regulatory source discipline: `docs/regulatory/sources.json`

### What this demonstrates

HomeCare TPA demonstrates an agentic deployment pattern for regulated enterprise workflows:


```text
Operational workflow + domain rules + source-grounded regulatory constraints
        ↓
Claude-powered task-specific agents
        ↓
Bounded outputs + deterministic guardrails
        ↓
Human review for legally sensitive decisions
        ↓
Auditable action trail for compliance and quality control
```



---

## Why This Project Exists

Workers’ compensation claims administration is a dense, deadline-driven, highly regulated workflow. Claims teams must evaluate compensability, manage medical treatment, issue statutory notices, calculate benefits, track diaries, coordinate utilization review, manage litigation milestones, and document every material decision.

AI can help, but unsafe automation is not acceptable. A system that hallucinates deadlines, denies treatment without physician review, bypasses a licensed adjuster, or fails to preserve an audit trail would create legal and compliance risk.

HomeCare TPA explores a safer deployment pattern:

- Let AI analyze, summarize, classify, and recommend
- Use deterministic code for statutory deadlines and hard legal thresholds
- Require human approval for legally sensitive claim decisions
- Preserve every model input, output, guardrail trigger, and human override
- Keep authoritative regulatory sources explicit and reviewable

---

## Project Status

**Current state:** Pre-release reference implementation  
**Customer status:** No live customers  
**Data status:** Demo/mock/synthetic data only  
**Purpose:** Portfolio-grade demonstration of regulated agentic AI architecture  
**Primary model:** Anthropic Claude API  
**Primary domain:** California workers’ compensation claims administration  
**Target users:** Claims administrators, employers, injured workers, and supervising adjusters  

This repository should be evaluated as a demonstration of product thinking, regulated workflow mapping, agent architecture, guardrail design, and technical implementation depth — not as evidence of a currently operating third-party administrator.

---

## Core Product Concept

HomeCare TPA is designed around three portals:

### 1. Employer Portal

For HR and risk managers at home health or home care agencies.

Core workflows:

- Report a new workplace injury
- Initiate employee intake
- View claim status
- Review loss-run and experience-mod inputs
- Track high-level claim activity

### 2. Employee Portal

For injured workers completing intake and claim-related tasks.

Core workflows:

- Complete mobile-first injury intake
- Use voice or text to describe injury facts
- Upload photos or documents
- Select and book an MPN provider
- Review claim status and benefit information
- Complete DWC-1 related steps

### 3. Admin Console

For licensed claims professionals and supervisors.

Core workflows:

- Review AI-surfaced claim issues
- Evaluate compensability recommendations
- Review reserves and benefit calculations
- Manage diaries and statutory deadlines
- Review and route RFAs
- Generate notices and claim documents
- Review model decision logs and human overrides

---

## Agentic Workflow Design

The system is organized around task-specific agents and deterministic control logic.

### Compensability Agent

Analyzes injury facts, job duties, mechanism of injury, body parts, timing, employer contest information, and red flags.

Outputs:

- Compensability rating
- Confidence score
- Red flags
- Recommended next actions
- Suggested reserve ranges
- Rationale for licensed adjuster review

Human control:

- AI does not accept or deny claims
- Licensed adjuster retains final authority
- AI output is logged for review and override tracking

### RFA / MTUS Agent

Evaluates medical treatment requests against MTUS/ACOEM-style treatment logic and claim context.

Outputs:

- MTUS consistency assessment
- Recommended routing
- Rationale
- Urgency indicators
- Physician review trigger when required

Hard guardrails:

- AI may recommend approval where treatment is consistent and low-risk
- AI may not deny medical treatment
- MTUS-inconsistent treatment routes to utilization review organization / physician review
- Surgical CPT codes route to physician review regardless of AI recommendation
- AI failure or invalid output routes to manual review

### Settlement Pricing Agent

Assists with compromise-and-release valuation by generating a range and rationale rather than a final settlement decision.

Outputs:

- Settlement value range
- Rationale
- Future medical considerations
- Risk factors
- Adjuster review recommendation

Hard guardrails:

- AI does not issue final settlement authority
- Settlement values are compared against stipulated value
- Outlier pricing triggers adjuster review
- Medicare Set-Aside screening gates settlement workflow where applicable

### Medicare Set-Aside Screening Gate

Uses deterministic rules to flag potential MSA review requirements based on age, Medicare/SSDI indicators, and projected settlement value.

Design principle:

- MSA screening is deterministic and source-grounded
- AI does not invent thresholds
- Settlement workflows are blocked or escalated when MSA review is indicated

### Voice Intake Extraction Agent

Extracts structured claim intake data from injured-worker voice or text input.

Outputs:

- Injury description
- Body parts
- Mechanism of injury
- Date/time information
- Potential red flags
- Missing intake fields

Human control:

- Extracted facts are presented for review
- Claim decisions are not made from intake extraction alone

---

## Guardrail Philosophy

The central design principle is simple:

> AI may assist with analysis, prioritization, drafting, and routing. AI may not make legally sensitive final decisions where licensed human or physician judgment is required.

### Examples of hard guardrails

- No AI denial path for medical RFAs
- Surgical CPT codes always route to physician review
- AI parse failure never defaults to approval or denial
- Claim acceptance and denial remain licensed adjuster decisions
- Settlement pricing remains human-reviewed
- Statutory deadlines are calculated by code, not generated by the model
- MSA screening uses deterministic thresholds and explicit source tracking
- Generated notices use controlled templates
- Human override status is logged for model decision review

---

## Auditability and Model Governance

Every meaningful model-assisted decision is designed to be reviewable.

The AI decision log captures:

- Claim ID or workflow ID
- Decision type
- Prompt name
- Model used
- Input snapshot
- Raw model output
- Parsed structured output
- Confidence score where applicable
- Token usage
- Latency
- Guardrail actions
- Human reviewer decision
- Human override timestamp

This creates a defensible audit trail for compliance review, quality control, and future evaluation.

---

## Regulatory Source Discipline

The system avoids asking the model to invent legal or regulatory values.

Authoritative sources are tracked in `docs/regulatory/sources.json`, including:

- California Labor Code sections
- DWC regulations
- PDRS references
- MTUS / ACOEM treatment guidance
- WCIS EDI implementation references
- CMS WCMSA guidance
- DWC notice and procedural requirements

Design principle:

> The model may reason over a workflow, but statutory values, deadlines, and hard compliance thresholds should come from controlled sources and deterministic code.

---

## Architecture Overview


```text
Frontend: React / Vite
        ↓
Backend: Node.js / Express REST API
        ↓
Service layer: claims, RFAs, notices, settlement, PD, MMI, QME, reporting
        ↓
AI layer: Claude-powered task-specific agents
        ↓
Data layer: PostgreSQL / Supabase
        ↓
Audit layer: model decision logs, claim events, admin actions
        ↓
External integrations: mocked or scaffolded enterprise services
```



### Frontend

- React / Vite
- Employer portal
- Employee portal
- Admin console
- Architecture and agent-review views

### Backend

- Node.js / Express
- REST API routes
- Service-layer business logic
- Claude API integration
- PDF generation with `pdf-lib`
- JWT / role-based middleware
- Structured logging

### Data Layer

- PostgreSQL via Supabase
- Claims, employees, employers
- RFAs and RFA evaluations
- Diaries and claim events
- Settlement and PD workflow tables
- AI decision logs
- Audit logs
- Regulatory source references

### Integrations

Several integrations are mocked, stubbed, or scaffolded for pre-release demonstration:

- ADP-style payroll / employee data
- Claims-system / ledger integration
- Enlyte / Mitchell-style utilization review routing
- SendGrid-style email
- Twilio-style SMS
- Lob-style print/mail
- Supabase storage
- Claude API

---

## Repository Structure


```text
homecare-tpa/
├── README.md
├── frontend/
│   └── src/
│       ├── App.jsx
│       ├── Architecture.jsx
│       ├── services/
│       └── locales/
├── backend/
│   ├── src/
│   │   ├── index.js
│   │   ├── config.js
│   │   ├── logger.js
│   │   ├── middleware/
│   │   ├── routes/
│   │   ├── services/
│   │   │   ├── aiService.js
│   │   │   ├── aiDecisionsService.js
│   │   │   ├── claimService.js
│   │   │   ├── rfaService.js
│   │   │   ├── msaScreeningService.js
│   │   │   ├── pdPricingService.js
│   │   │   ├── noticeService.js
│   │   │   └── reportingService.js
│   │   └── utils/
│   ├── prompts/
│   │   ├── compensability_analysis.txt
│   │   ├── rfa_mtus_evaluation.txt
│   │   └── cnr_pricing.txt
│   ├── tests/
│   ├── mocks/
│   └── package.json
├── supabase/
│   └── migrations/
├── docs/
│   ├── architecture.md
│   ├── data-model.md
│   ├── integrations.md
│   ├── regulatory.md
│   └── regulatory/
│       └── sources.json
└── .github/
    └── workflows/
        └── ci.yml
```



---

## Key Files for Technical Reviewers

### `backend/src/services/aiService.js`

Claude API integration layer.

Demonstrates:

- Prompt loading from file
- Structured JSON response handling
- Markdown fence cleanup
- Parse failure handling
- Token and latency logging
- PDF/document input support
- No silent fallback on invalid model output

### `backend/src/services/rfaService.js`

Medical treatment request routing workflow.

Demonstrates:

- AI-assisted MTUS evaluation
- No AI denial path
- Surgical CPT override
- URO / physician review routing
- Manual adjuster review path
- Statutory deadline diary creation
- Notice-generation triggers

### `backend/src/services/aiDecisionsService.js`

Model audit log and human override linkage.

Demonstrates:

- Input/output capture
- Parsed and raw model result storage
- Confidence and metadata tracking
- Guardrail action logging
- Human review linkage
- Aggregated model-decision stats

### `docs/regulatory/sources.json`

Regulatory source registry.

Demonstrates:

- Explicit source tracking
- Last-verified dates
- Source-to-service mapping
- Avoidance of model-invented statutory values

### `.github/workflows/ci.yml`

Backend CI workflow.

Demonstrates:

- Mock enterprise services
- Automated backend tests
- GitHub Actions workflow
- Repeatable test execution

---

## Example Workflow: RFA Review


```text
1. RFA is received
2. System creates RFA record
3. Statutory response diary is generated
4. Claude evaluates treatment request against claim context
5. Deterministic guardrails run
6. Decision routes to one of:
   - Auto-approve
   - Adjuster review
   - URO / physician review
   - Deferred manual review on error
7. Notices are generated where appropriate
8. AI decision is logged
9. Human review or override is linked back to model output
```



Important safety constraint:

> Claude may help identify when treatment appears consistent with guidelines, but Claude may not deny or modify treatment. Denial/modification requires physician review.

---

## Example Workflow: Settlement Review


```text
1. Claim reaches settlement evaluation stage
2. System calculates stipulated-value reference point
3. MSA screening gate runs
4. Claude generates settlement value range and rationale
5. Guardrails compare C&R pricing against stipulated value
6. Outlier values trigger adjuster review
7. Human adjuster retains settlement authority
8. Decision and rationale are logged
```



Important safety constraint:

> The model provides a valuation range and reasoning support. It does not issue settlement authority.

---

## Example Workflow: AI-Assisted Claim Intake


```text
1. Injured worker submits voice or text intake
2. System extracts structured injury facts
3. Missing fields and red flags are identified
4. Claim record is created or updated
5. Compensability agent analyzes the claim context
6. Adjuster reviews recommendation, rationale, and red flags
7. Final claim decision remains human-owned
```



---

## Technical Stack

| Layer | Technology |
|---|---|
| Frontend | React, Vite |
| Backend | Node.js, Express |
| Database | PostgreSQL via Supabase |
| AI | Anthropic Claude API |
| Auth | JWT / role-based middleware, Supabase-oriented architecture |
| Testing | Jest, Supertest |
| CI | GitHub Actions |
| PDF generation | pdf-lib |
| Email/SMS | SendGrid / Twilio scaffolding |
| Print/mail | Lob.com scaffolding |
| Mock integrations | ADP-style and claims-system mock services |

---

## Local Development

### Prerequisites

- Node.js
- npm
- Supabase project or local test configuration
- Anthropic API key for live AI calls

### Backend setup


```bash
cd backend
npm install
cp .env.example .env
npm run dev
```



### Run tests


```bash
cd backend
npm test
```



### Frontend setup


```bash
cd frontend
npm install
npm run dev
```



---

## Environment Variables

The backend expects environment variables for:

- JWT secret
- Anthropic API key
- Supabase URL and keys
- Mock or live enterprise integration credentials
- SendGrid / Twilio / Lob credentials where used

See:


```text
backend/.env.example
```


Do not commit real secrets.

---

## Security and Compliance Notes

This is a pre-release reference implementation. Some security controls are implemented, while others are documented as deployment requirements for a real customer environment.

Implemented or scaffolded patterns include:

- Role-based access middleware
- Supabase-oriented row-level security architecture
- JWT-based session handling
- Audit logging middleware
- Model decision logs
- Human override linkage
- Controlled prompt files
- Structured output parsing
- Manual fallback on model failure

Controls that would require hardening before real production use:

- Formal SSO / SAML integration
- Fully enforced MFA in production
- Tenant-isolation review
- Field-level encryption review
- PHI / PII handling review
- HIPAA / BAA vendor review
- Secrets management
- SOC 2-style logging and monitoring
- Formal incident response process
- Data retention and deletion policy
- Production penetration testing
- Customer security review package

---

## Deployment Readiness Framing

This repository is best understood as a **deployment blueprint** rather than a launched SaaS product.

It demonstrates:

- How to map a regulated workflow into agent-assisted workstreams
- Where to place deterministic controls instead of model discretion
- How to preserve human authority over regulated decisions
- How to structure audit logging for model-assisted workflows
- How to design a safe MVP for enterprise AI adoption
- How to communicate architecture and compliance tradeoffs to stakeholders

It does not claim:

- Live customer adoption
- Paid production use
- Real claim-data processing
- Completed vendor contracts
- Fully hardened enterprise security posture

---

## Relevance to Enterprise AI Deployment

The deployment pattern used here generalizes beyond workers’ compensation.

Comparable regulated workflows include:

- Insurance claims triage
- Underwriting review
- Prior authorization support
- Compliance investigations
- Financial services case review
- Healthcare operations workflows
- Legal intake and matter triage
- Risk and control testing
- Government benefits administration

The shared challenge is the same:

> Use AI to accelerate analysis and task generation while preserving human accountability, auditability, source grounding, and compliance boundaries.

---

## What I Would Validate in a Real Customer Deployment

Before deploying this pattern with a real enterprise customer, I would define:

### Workflow scope

- Which tasks are in-scope for AI assistance?
- Which decisions are explicitly out-of-scope?
- Which users review and approve outputs?
- What is the escalation path for uncertainty?

### Data boundaries

- What data can the model access?
- What data must be excluded or masked?
- What retention rules apply?
- Are there tenant-isolation requirements?

### Evaluation plan

- What is the baseline workflow performance?
- What accuracy or usefulness metrics matter?
- What false-positive and false-negative risks exist?
- How often do humans override model recommendations?
- What output categories require sampling and QA?

### Success criteria

- Reduction in manual review time
- Reduction in missed deadlines
- Faster task identification
- Improved consistency of documentation
- Higher quality supervisor review
- Reduced backlog
- Clearer audit trail

### Rollout plan

- Pilot with limited users and synthetic or low-risk data
- Human review required for all outputs
- Weekly QA review and prompt iteration
- Gradual expansion by workflow type
- Executive reporting on adoption, value, and risk

---

## Related Real-World Experience

In my current role at Liberty Mutual, I designed and deployed an internal AI-assisted claims supervision workflow for the Amazon national workers’ compensation account. That workflow used Liberty GPT, daily Power BI exports, client service instructions, and internal knowledge-base materials to generate daily and weekly action lists for an examiner team.

That internal deployment focused on the same pattern demonstrated here:

- Use approved internal AI tooling
- Ground outputs in operational data and account-specific guidance
- Generate actionable tasking rather than final claim decisions
- Preserve licensed human judgment for regulated decisions
- Deliver output through existing team workflows to reduce adoption friction

HomeCare TPA extends that experience into a deeper technical reference implementation using Claude-powered agents, explicit guardrails, audit logging, and deployment-oriented architecture.

---

## License

This repository is a portfolio and reference implementation. Add license terms before reuse or commercial deployment.

---

## Contact

Akash Dixit  
Los Angeles, CA  
akashdixit@gmail.com  
github.com/aksiomatixx/Homecare-tpa
