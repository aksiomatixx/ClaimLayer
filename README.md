<div align="center">

<img src="docs/assets/claimlayer-mark.png" width="84" alt="ClaimLayer logo"/>

# ClaimLayer

**Compliance-grade agentic AI for workers' compensation claims**

A regulatory-aware execution layer that runs AI agents on top of existing claims systems — without replacing them.

`911 tests · 52 suites` · Node.js / Express · React / Vite · PostgreSQL · Anthropic Claude API

</div>

## What this is

ClaimLayer is a production-grade reference implementation of how to deploy AI agents into a highly regulated workflow — California workers' compensation claims — safely.

A team of Claude-powered agents draft compensability analyses, evaluate treatment authorizations, price settlements, and screen for Medicare interests. Each agent operates inside guardrails enforced in code, with a licensed human at every consequential decision and a queryable audit trail behind every model call.

It exists as both an active project and a public worked example of a question I think matters: how do you get real leverage from LLM agents in an environment where a wrong automated decision has legal consequences?

## Why it's different

Most AI in the claims space does prediction — scoring which claims are likely to be expensive, litigate, or go sideways. ClaimLayer does execution: it carries out the regulatory workflow itself — drafting the analysis, applying the statutory math, generating the notices, tracking the deadlines — inside compliance guardrails a licensed adjuster designed.

The wedge is agentic execution within hard regulatory limits, where every AI decision is bounded, auditable, and reversible by a human.

## Architecture at a glance

The system is a layer, not a replacement: it runs agentic workflows on top of a customer's retained system of record via a pluggable integration layer. ([Full architecture writeup →](docs/architecture.md) and an in-app `/architecture` view.)

- **Five specialized agents** — compensability assessment, MTUS treatment authorization, C&R settlement pricing, MSA screening, and voice-intake extraction — each with authored prompts, explicit invocation triggers, and bounded output schemas.
- **Guardrails enforced in code** — not in prompts. The model cannot take certain actions regardless of what it returns (see below).
- **Human-in-the-loop checkpoints** at every compensability, authorization, and settlement decision, backed by a licensed adjuster's judgment.
- **Full AI decision audit trail** — every model call is logged with its input snapshot, output, guardrails triggered, and human-override status, surfaced in an in-app `/agents` review console.
- **Legacy-system integration layer** — pluggable adapters ingest claims from an existing system and push diaries, documents, and notices back, so agents deploy onto a system of record rather than demanding migration off it.
- **Regulatory data discipline** — statutory values come from authoritative DWC sources, never from the model.

## Engineering decisions that signal the intent

These are the choices that make the system safe to point at a regulated workflow:

- **No auto-deny pathway exists anywhere in the system.** On treatment authorizations, an agent may only return `auto_approve` or `physician_review` — never a denial. Denials are a licensed-human-only action by construction.
- **Settlement offers are hard-capped at 1.15× and 5.0×** of stipulated value; the pricing agent physically cannot return a number outside that band.
- **A deterministic MSA screen gates every settlement** — Medicare-interest screening is not left to the model's discretion.
- **Statutory values are never model-generated.** Rating schedules, fee schedules, and caps are sourced from authoritative DWC publications and version-controlled; the model reasons over them but never invents them.
- **Penalty and deadline diaries cannot be snoozed**, and statutory deadlines use the correct calendar/business-day basis per the governing code section.

## Testing

911 automated tests across 52 suites, covering benefits-calculation math, statutory-deadline logic, state-machine transitions, and adversarial guardrail tests that attempt to push agents past their bounds and assert that the guardrails hold.

## Tech stack

Node.js / Express · React / Vite · PostgreSQL (Supabase) · Anthropic Claude API · server-side PDF generation (pdf-lib).

## How this was built

Designed, architected, and built solo by directing Claude Code. I'm a workers' compensation claims professional with a decade in the field, not a career engineer — ClaimLayer is what domain expertise plus AI-assisted development can produce when the architecture, the regulatory constraints, and the judgment about where AI belongs come from someone who has lived inside the workflow. The hard part was never the keystrokes; it was knowing what to build, where the model must not be trusted, and how to make a regulated workflow safe.

## Status & scope

A reference implementation and active project — not a live system processing real claims. It runs on synthetic demo data and is not affiliated with any employer. It's meant to demonstrate the deployment patterns, not to serve as legal or claims-handling advice.

## Try the demo

### Prerequisites

The demo runs against a real PostgreSQL database via Supabase — there is no in-memory fallback, because the audit trail and row-level security are part of what's being demonstrated.

1. **Node.js 20+** (CI runs on 24).
2. **A Supabase project** — the free tier works. Either [supabase.com](https://supabase.com) or a local stack via `supabase start` ([Supabase CLI](https://supabase.com/docs/guides/cli)).
3. **Apply the migrations** in `supabase/migrations/` in filename order (SQL editor, `psql`, or `supabase db push`).
4. **Environment** — copy `backend/.env.example` to `backend/.env` and fill in at minimum:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`
   - `JWT_SECRET` (any random string for local use)
   - `ANTHROPIC_API_KEY` — optional; without it the app runs but agent analyses are unavailable
   - ADP / FileHandler / SendGrid / Twilio / Lob keys are **not** required for the demo

### Run it

```bash
npm install
npm run dev:demo      # wipes demo-flagged rows, seeds 8 synthetic claims, starts backend (:3001) + frontend (:5173)
```

Then open the `/architecture` and `/agents` views to see the agent registry, guardrail catalog, and live decision audit trail.

## Repository structure

```
backend/    Express API, agent services, prompts/, guardrails, tests
frontend/   React/Vite app — workspace, /architecture, /agents views
supabase/   schema migrations (staged, applied manually)
docs/       architecture writeup, case study, regulatory sources
```
