# Environment configuration

All backend configuration is read from environment variables (`backend/src/config.js`, plus a
few direct reads). Copy `backend/.env.example` to `backend/.env` for local work. **Never commit
`.env`.** In deployed environments, inject variables from a secrets manager. They should never
come from files on disk.

## Environments

ClaimLayer currently ships no deployment configuration (see the readiness doc, "Deployment and
infrastructure"). The target is three isolated environments, each with its own Supabase/Postgres
project, credentials, and vendor accounts:

| Environment | Data | Purpose |
|---|---|---|
| `development` | Synthetic only (`npm run dev:demo`) | Local work; dev auto-login endpoints enabled |
| `staging` | Synthetic or de-identified only | Pre-release verification, contract tests, pen tests |
| `production` | Live claims, PII, medical information | `NODE_ENV=production`; no dev endpoints; secrets from a manager |

Production data must never be copied into a non-production environment.

## Variables

### Core

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `production` in production. This enables `Secure` cookies, fails webhooks closed, and blocks the dev auto-login and demo-reset endpoints. **Anything other than `production` enables dev auto-login** — never deploy with `development` |
| `PORT` | no | Default `3001` |
| `LOG_LEVEL` | no | Default `info` |
| `TRUST_PROXY` | behind a proxy | Hop count (usually `1`), so rate limits key on the client IP |
| `JWT_SECRET` | yes | 64+ random bytes. Signs every session and magic-link token (separate keys per token type are on the roadmap) |
| `MAGIC_LINK_SECRET` | no | Defaults to `JWT_SECRET` |
| `FRONTEND_URL` | yes | Used in magic links |
| `DEFAULT_TENANT_ID` | no | Fallback tenant for sessions not tied to a provisioned tenant. Default `00000000-0000-0000-0000-000000000001` |

### Database and identity (Supabase)

| Variable | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | yes | **Also switches MFA enforcement on**: `requireMFA` and the approval gate for MFA-flagged actions (reserve changes, payments) require an MFA-verified session whenever this is set |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server only. Bypasses RLS — never expose to a browser |
| `SUPABASE_ANON_KEY` | yes | Used only for Supabase Auth calls |

Supabase project settings required outside local development:

- **Disable public sign-ups.** Authorization no longer trusts `user_metadata` (ADR-0002), but
  self-registered accounts should not exist.
- **Require email confirmation** for any account created.
- **Enable TOTP MFA** for staff accounts.
- **Provision users** by inserting a `public.users` row with `role`, `tenant_id`, `employer_id`
  (employer users), and `active`. Without a row, login is refused.

### AI providers

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | no | Without it, agents are unavailable and claim work continues manually. Before live data: confirm data-processing terms (no training, retention settings) |
| `OPENAI_API_KEY` | no | Voice transcription (Whisper). Same data-processing caveat — voice intake contains PHI |

### Integrations

All of these are currently mocks or stubs.

| Variable | Notes |
|---|---|
| `FILEHANDLER_API_KEY`, `FILEHANDLER_BASE_URL` | Required to boot (mock: `mock-fh-key`, `http://localhost:8002`) |
| `ADP_CLIENT_ID`, `ADP_CLIENT_SECRET`, `ADP_AUTH_URL`, `ADP_BASE_URL` | Required to boot (mock values in `.env.example`) |
| `LOB_API_KEY`, `LOB_LIVE`, `LOB_WEBHOOK_SECRET` | Print-mail; stub until `LOB_LIVE=true` |
| `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_TEMPLATE_INTAKE_COMPLETE`, `NOTIFY_ADAPTER` | Email |
| `TWILIO_*` | Voice / SMS |
| `EMAIL_INBOUND_TOKEN` | Required in production for the inbound-email document webhook |
| `DXF_WEBHOOK_SECRET`, `ENLYTE_WEBHOOK_SECRET` | Webhook HMAC secrets. Production fails closed without them |
| `WCIS_ADAPTER`, `WCIS_ENVIRONMENT`, `WCIS_CLAIM_ADMIN_*` | State EDI. `stub` only today |
| `ADJUSTER_NAME`, `ADJUSTER_PHONE`, `ADJUSTER_EMAIL` | Single default adjuster identity used on letters and diary assignment (a known prototype limitation) |

## Production checklist (security-relevant)

Required before any live data:

- [ ] `NODE_ENV=production`, served over HTTPS only (session cookies are `Secure`).
- [ ] Migrations applied in order, *before* the matching backend (`migrate → deploy`),
  including `20261001000001`–`20261001000004`.
- [ ] Public sign-ups disabled; every user provisioned in `public.users`; staff enrolled in MFA.
- [ ] Webhook secrets and `EMAIL_INBOUND_TOKEN` set.
- [ ] Secrets in a secrets manager; per-environment credentials; key rotation documented.
- [ ] Backups with point-in-time recovery, and a tested restore.
- [ ] `app.audit_ledger_head()` anchored to WORM storage on a schedule (ADR-0003).

Remaining **launch blockers** are listed in `CLAIMLAYER_TPA_PRODUCTION_READINESS.md`. This
checklist does not make the system production-ready on its own.
