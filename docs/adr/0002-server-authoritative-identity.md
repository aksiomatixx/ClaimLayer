# ADR-0002: Server-authoritative identity

- Status: Accepted — implemented
- Date: 2026-10-01
- Addresses: finding S-1 (CLAIMLAYER_TPA_PRODUCTION_READINESS.md)

## Context

Staff and employer login authenticated against Supabase Auth, then copied `role`, `tenant_id`,
and `employer_id` from the Supabase user's `user_metadata` into the session JWT
(`backend/src/routes/auth.js`).

`user_metadata` is writable by the user:

- at sign-up, via `options.data`;
- at any later time, via `auth.updateUser({ data })`.

`supabase/config.toml` enables public sign-ups without email confirmation. Anyone holding the
publishable anon key could therefore register with `role: "admin"` and receive a full staff
session. Any employer user could change their `employer_id` or `tenant_id`.

## Decision

Supabase Auth answers only *who* the person is (password, MFA factor, AAL level). Everything
that grants access comes from the provisioned `public.users` row, read with the service-role
client by the authenticated user's id:

- role
- tenant
- employer
- active status

`backend/src/services/identityService.js` implements this, and every login path uses it:
`/auth/login`, `/auth/login/mfa`, and `/auth/employer/login`.

| Situation | Staff login | Employer login |
|---|---|---|
| No `users` row | 403 `not_provisioned` | 401 `invalid_credentials` |
| `users.active = false` | 403 `account_inactive` | 401 `invalid_credentials` |
| Role mismatch | 403 `not_staff` | 401 `invalid_credentials` |

Employer failures are uniform so the endpoint does not reveal account state.

Session cookies are set through `sessionCookieOptions()`: `HttpOnly`, `SameSite=Lax`, and
`Secure` in production.

## Consequences

- **Provisioning is an operator action.** Inserting a `public.users` row is now required before
  anyone can log in (see `docs/DEVELOPMENT.md` for local setup).
- **Deactivation takes effect at the next login.** Already-issued 8-hour sessions are not
  revoked. A server-side session store with revocation is on the roadmap (finding S-8).
- **Disable public sign-ups** in every non-local Supabase project. With this ADR, a
  self-registered account gets nothing, but it should not exist.
- `users.active` and `users.display_name` were added by migration
  `20261001000001_schema_truth.sql`.

## Alternatives considered

- **Supabase `app_metadata`** (writable only by the service role). Workable, but it puts
  authorization data in the identity provider instead of the database that RLS and reporting
  use, and makes the IdP harder to replace with an enterprise SSO provider later.
- **Custom JWT claims via a Supabase Auth hook.** A reasonable later step. It still needs the
  `users` table as its source.
