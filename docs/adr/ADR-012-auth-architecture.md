# ADR-012: Auth Architecture — Cognito + Supabase with Provider Interface

## Status

Accepted — March 2026

## Context

Phase 1 (Identity & Access Foundation) requires authentication, session management,
and integration with the database layer for RBAC, entitlements, and RLS. Two
architectural questions needed resolution:

1. **Which services?** AWS Cognito for auth (SSO, MFA, password policies, email
   verification) + Supabase for database/RLS (PostgreSQL, row-level security,
   data isolation). Cognito issues JWTs, Supabase validates them.

2. **How tightly coupled?** platform-foundation is a public template. Hardwiring
   Cognito into every route and middleware would make the template unusable for
   teams using Auth0, Firebase Auth, Clerk, or other providers.

## Decision

### Auth Provider Interface (platform-foundation)

platform-foundation defines an `AuthProvider` interface — a contract that any
auth provider must implement. The interface covers:

- Sign up (email/password)
- Sign in (email/password, SSO callback)
- Sign out
- Token verification (JWT validation)
- Token refresh
- Password recovery (initiate + confirm)
- MFA enrollment and challenge
- Email verification
- Guest token generation
- Device registration

The interface lives in `platform/auth/` and is the only auth contract that
routes, middleware, and components depend on. No route imports Cognito directly.

### Cognito Implementation (Consumer Example)

Consumer applications provide concrete implementations of the `AuthProvider` interface (e.g., Cognito).
This implementation:

- Configures the Cognito user pool (playform-auth, us-east-1)
- Handles SSO via Google, Apple, Microsoft identity providers
- Manages TOTP MFA via Cognito's built-in support
- Issues JWTs that Supabase validates via custom JWT configuration

### Supabase for Data (both repos)

Supabase provides:

- PostgreSQL database with Row-Level Security (RLS)
- User data isolation (User A cannot query User B's data)
- RBAC tables (roles, permissions, entitlements, audit_log)
- Standard SQL migrations (portable — not Supabase-specific)

The Supabase JS client is used for convenience but the schema, migrations,
and RLS policies are pure PostgreSQL. Switching from Supabase to any PostgreSQL
host requires only connection string changes.

### What Is NOT Abstracted

Leaf services (translation, TTS, STT, safety classification) are NOT abstracted
behind provider interfaces. Each is isolated in a single file with a clean
function signature. Swapping Google Translate for AWS Translate means rewriting
one file — no routes, components, or tests change. The cost of abstraction
exceeds the benefit for stateless API calls that are already file-isolated.

## Infrastructure

| Service     | Purpose                                     | Region    | Account            |
| ----------- | ------------------------------------------- | --------- | ------------------ |
| AWS Cognito | Authentication, MFA, SSO, password policies | us-east-1 | playform-auth      |
| Supabase    | PostgreSQL, RLS, data API                   | us-east-1 | Datankare/playform |
| Vercel      | Hosting, CI/CD                              | —         | Datankare          |

### Cognito Details

- User Pool ID: `<pool-id>` (resource identifiers are not recorded in the repository; this original pool was deleted with its AWS account — see ADR-050)
- App Client: playform-web (SPA, PKCE, no client secret)
- Client ID: `<client-id>`
- MFA: Optional, TOTP (authenticator apps)
- Device tracking: User opt-in, bypass MFA for trusted devices
- Sign-in: Email only
- Self-registration: Enabled
- Email verification: Required
- Password policy: 12+ chars, uppercase + lowercase + number + special
- Token signing: `https://cognito-idp.<region>.amazonaws.com/<pool-id>/.well-known/jwks.json`

### Supabase Details

- Project URL: `https://<project-ref>.supabase.co`
- Region: us-east-1 (East US, North Virginia)
- Auto-RLS: Enabled on all new tables
- Data API: Enabled

## Consequences

### Positive

- platform-foundation works with any auth provider (Cognito, Auth0, Firebase, Clerk)
- No route or component imports a provider directly — all go through the interface
- Database layer is pure PostgreSQL — portable to any PostgreSQL host
- Leaf services are file-isolated — swappable in hours without touching consumers
- Cognito handles the hard auth problems (MFA, SSO, password policies) out of the box

### Negative

- Auth provider interface adds ~1 day to Phase 1 Sprint 1
- Two services (Cognito + Supabase) require a JWT bridge layer
- Cognito's managed login pages are not used (we build our own UI for full control)
- Free tier limits apply (Cognito: 50K MAU, Supabase: 500MB database)

### Risks

- JWT bridge complexity: Cognito JWTs must be validated by Supabase. Misconfiguration
  could allow unauthorized data access. Mitigated by RLS policies as defense-in-depth.
- Provider lock-in on auth: Mitigated by the interface. Switching providers means
  implementing the interface, not rewriting routes.
- Cost at scale: Both services have free tiers sufficient for Phase 1-3. Production
  scaling costs are predictable and documented.

## Amendment (v6.0.0, 2026-10-24) — remembered token verification

Every protected request verified its access token with Cognito's `GetUser`: one AWS call per
request, under a per-account request-rate quota — at scale the quota runs out and every request
fails. `platform/auth/token-verification.ts` remembers the outcome:

- in the selected shared cache (`CACHE_PROVIDER`), keyed by a SHA-256 of the token, never the
  token; fresh for `auth.token_cache_seconds` (governed, default 30, at most 60) and never past the
  token's `exp`;
- revoked at once on every instance by a per-user stamp: sign-out (and its global sign-out), a
  suspension or ban, the account's deletion, a role, entitlement or MFA change. The stamp is read
  before `GetUser` is called, so a revocation during the call voids its answer;
- one `GetUser` per token per instance at a time (single flight); a foreign, expired or
  undecodable token is refused before any call.

When `GetUser` cannot answer (throttled, or Cognito down), privileged routes (`requireAdmin`:
administration, moderation, operation) **fail closed** with 503 `service.unavailable` (auth).
Ordinary routes **fail open only onto what Cognito itself verified**: an entry past its fresh
window, for `auth.token_stale_grace_seconds` more (default 300, at most 900, 0 off), never past
the token's expiry or a revocation; without one they fail closed too. An outage is never a 401.

**Residual revocation window.** A token revoked outside the platform (the Cognito console,
Cognito's own detection) is honoured until its entry stops being fresh — at most
`auth.token_cache_seconds` — or, during a `GetUser` outage on an ordinary route, until the grace
ends. Revocations the platform makes take effect at the next request. Recorded in
[ASSURANCE.md](../ASSURANCE.md) §3.

## Amendment (v6.0.0, review 8, 2026-10-24) — signatures checked locally, revocation made exact

Review 8 found four gaps in the amendment above; each is closed:

- **The signature is checked before `GetUser` (M5).** The claims checks alone let a forged,
  unsigned token cost one `GetUser` call each — a flood drained the quota into an outage, and the
  outage into the stale grace. `platform/auth/jwt-verification.ts` verifies every access token
  against the pool's published keys first, with `jose`: RS256 only (`none`, HS256 with the public
  key as its secret and every other algorithm refused before a key is looked at); the key by
  `kid` from `https://cognito-idp.<region>.amazonaws.com/<pool>/.well-known/jwks.json`, kept an
  hour, fetched one request at a time, refreshed at most once per 30 s whatever arrives, so an
  unknown `kid` causes one refresh and is then refused; keys fetched before stand in for a failed
  refresh for a day, after which verification is unavailable (503, never 401); `iss`, `exp`,
  `nbf`, `token_use` and `client_id` checked. Only a token the pool signed reaches `GetUser`.
- **A revocation during a call is exact (H-A).** A request joins only an in-flight `GetUser`
  asked under the revocation stamp it read itself; a request that arrived after a sign-out, role
  or MFA change asks for itself. After an answer the stamp is read again; the answer is saved
  only when the stamp is unchanged — otherwise the request asks once more under the new stamp,
  and an entry a revocation voided never stands in during an outage.
- **Attribute changes revoke (M1).** Assigning a user's tenant, and verifying an address, void
  the user's remembered verifications, so the next request reads the attribute.
- **More routes are privileged (M5).** Account export and deletion (`requireActor(…,
{ privileged: true })`) and MFA setup, verification and removal (`requireAuth(…,
{ privileged: true })`) fail closed like administration.

**What revocation guarantees, and where (L3).** A platform revocation reaches every instance at
the next request because the stamp is published in the shared cache. That holds only when the
cache is shared: a deployment refuses `CACHE_PROVIDER=memory` (the environment contract), which
remains for local and CI runs, bounded and swept. If the shared cache cannot be read, a request
asks `GetUser` (a miss); if a stamp cannot be written, the failure is logged and the fresh window
(at most `auth.token_cache_seconds`) bounds it.

## Amendment (v6.0.0, review 9, 2026-10-24) — the keys unavailable is an outage, not a sign-out

Review 9 found three more gaps; each is closed:

- **A cold instance (M4).** With no keys held yet, one failed JWKS fetch made every token
  unavailable for the whole 30 s cooldown. Now, while no keys are held, the store retries on a
  short backoff (250 ms, doubling, never longer than the cooldown) and makes two attempts within
  one call; one fetch at a time (single flight) throughout.
- **Unavailable keys reach the token verifier (M4).** `JwksUnavailableError` bypassed both the
  remembered verification and the stale grace. Now the provider hands the token to the verifier
  as "the identity provider cannot answer": a fresh remembered verification of that very token
  (its entry is keyed by the token's hash, and only `GetUser` ever wrote one) is honoured, an
  ordinary route may use the stale grace, a privileged route fails closed with 503. `GetUser` is
  not asked: an unverified signature still never costs a call against its quota.
- **A suppressed refresh is "unavailable", not "invalid" (L9).** A made-up `kid` spent the
  refresh cooldown, so a genuinely rotated `kid` inside it was a 401 — an attacker could repeat
  it every 30 s. Now an unknown `kid` whose refresh was suppressed answers unavailable (503, or
  the grace on an ordinary route); a `kid` the refreshed keys do not hold is still refused, and
  a pinned key set (`staticKeyStore`) refuses an unknown `kid` at once.
- **An outage answer is checked against revocation too (L11).** A request whose `GetUser` was in
  flight across a revocation, and then answered "unavailable", stood on its pre-revocation entry.
  The stamp is now read again on "unavailable" as on "valid"; a stamp that cannot be read then is
  no proof, and there is no stand-in.

**The shared cache on a container host (M5).** `CACHE_PROVIDER=memory` stays refused in every
deployment — revocation must reach every instance. A container host shares its cache through its
own Valkey or Redis (`CACHE_PROVIDER=valkey`, `VALKEY_URL=rediss://…`, TLS verify-full; the
CacheProvider conformance kit passes against a real server, and a revocation on one connection
voids another's entry) or through Upstash, as Vercel does.

## Amendment (v6.0.0, review 10, 2026-10-24) — a bounded wait, and no options in the cache URL

- **A cold instance waits at most 1 s per request (M4).** The retry inside a call slept the whole
  doubled backoff — up to the 30 s cooldown per request during an outage. Now it sleeps only what
  is left of the backoff since the last attempt, never more than 1 s (`COLD_WAIT_CAP_MS`), and a
  request that meets a fetch in flight joins it instead of sleeping. The backoff between fetches
  is unchanged; a request that would wait longer is answered "unavailable".
- **`VALKEY_URL` carries no options (M6).** The client read a connection URL's query parameters as
  options overriding those passed beside it — `?tls=` dropped TLS, `?commandTimeout=0` unbounded
  every command. The platform parses the URL, refuses a query string or fragment (the provider and
  the environment contract), and passes host, port, user, password and database explicitly with
  the TLS options.

## Amendment (v6.0.0, review 11, 2026-10-24) — the wait bounded in all, and one URL parser

- **1 s in all (L-6).** The review 10 cap bounded the backoff sleep, but a request joined a fetch
  in flight and then started or joined another: two 5 s fetch timeouts, about 10 s, on a cold
  instance whose JWKS endpoint hangs. Now the whole wait — backoff, joins and fetches — is bounded
  per request by `COLD_WAIT_CAP_MS`; past it the keys held (within their stale period) stand in, or
  the answer is "unavailable" (and an unknown key's refresh answers "not refreshed"). The fetch
  goes on and serves the requests after.
- **`VALKEY_URL` refused as a whole (L-6).** One parser (`platform/cache/valkey-url.ts`) for the
  provider and the boot contract: a malformed percent-escape and a user without a password are
  refused with `config.valkey_url_invalid`, as a query string is.

## References

- Phase 1 Identity & Access Plan (Playform_Phase1_Identity_Access_Plan_v1.0.pdf)
- ADR-006: Database Architecture
- ADR-009: Security Standards
