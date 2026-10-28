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

## Amendment (v6.0.0, TASK-174, 2026-10-25) — an account is bound to its identity, not keyed by it

Found deploying Playform v0.9.0: the dev/staging Cognito pool was replaced (the old one was
deleted with its AWS account). Every `users` row carried the old pool's subject in
`users.cognito_sub` — and, since provisioning makes `id = cognito_sub = sub`, as its `id`. A
sign-in with the new pool's subject found no account and was given a second, ordinary one; the
staff accounts were unreachable and nobody could sign in as `super_admin` to repair it. Fixing it
by hand in the database is ruled out (no hand-made data changes in production). The same happens
when production moves to its own pool.

**Decision.**

- **D1 — the binding is `users.cognito_sub`; the account is `users.id`.** They are equal for an
  account provisioning created, and may differ: an account re-linked to a new pool keeps its id.
  The id is what every foreign key, audit record, trajectory, proposal, erasure record and module
  row names, so it never changes; only the subject does. One rule says which account an identity
  names (`platform/auth/account-identity.ts` `resolveAccount`): the row bound to the subject; else
  the subject's own id when free (a first request); a row with the subject's id but bound to
  another subject is never that identity's (`conflict` — refused, `403 account.identity_conflict`,
  not retryable; its sign-in events record no actor — review 15 L3/L4).
  This is how the original design read accounts (migration 003: `cognito_sub = auth.uid()` →
  `users.id`); `id = sub` had become an assumption in between.
- **D2 — everything account-keyed reads the bound account.** `requireActor` resolves it once:
  `actor.id` is the account's id and `actor.user.sub` the subject (account status, consent,
  export, erasure, sessions, quotas read `actor.id`). Permissions, the admin guard
  (`admin.userId` / `admin.sub`), appeals and the identity's tenant (`accountTenants`) already
  looked up by `cognito_sub`. The guest route's standing check and the sign-in, sign-out and MFA
  audit records resolve the account (`auditableAccountId`). Provisioning (`provisionAccount`)
  recognises an existing account by its subject before inserting and answers its id; the account
  guard refuses (fail closed) when it is called with a re-linked account's subject instead of its
  id, so no per-account restriction is ever read under the wrong key.
- **D3 — an erasure remembers the identity it closed** (`user_deletions.cognito_sub`, migration
  054), so a re-linked account, once purged, is never provisioned again from its subject.
- **D4 — re-linking is an operator command, never a data edit.**
  `node scripts/relink-identity.mjs --email <addr> --operator <who> --reason <why> [--apply]`
  (`platform/auth/identity-relink.ts`), run from a trusted machine with the owner connection and
  a key that may call `ListUsers` on the pool. It requires exactly one pool user with the address
  — enabled, confirmed or federated, `email_verified` true (for Google, its claim mapped into
  it) — and exactly one live account with it in the tenant; refuses an identity the pool holds in
  another tenant, an erased identity, and a new subject already held by another account — unless
  that account is the stray the person's first sign-in created and nothing is lost (same tenant,
  `id = cognito_sub`, active, default role, same or no address, sign-in residue only), merged only
  when named (`--merge-from <id>`). It changes only `cognito_sub`, with its audit record
  (`admin_action` / `identity_relinked`: operator, OS user, host, reason, pool, subjects as hashes)
  in one owner transaction; a dry run (the default) reads in a read-only transaction. After the
  commit both subjects' cached permissions and token verifications are voided through the shared
  cache. Bulk: `--all-staff` / `--all`, same checks, one transaction, any refusal stops the run
  unless `--skip-ambiguous`. Runbook: [TENANCY_OPERATIONS.md](../TENANCY_OPERATIONS.md) §6.

**Alternative rejected — change `id` too.** Rewriting the primary key means rewriting every
reference to it: twenty foreign keys with no `on update cascade`, and the id held as text in the
audit log (append-only), trajectories, proposals, sessions, metrics and every module's tables —
the history would name an account that no longer exists, and an export or erasure would miss it.
Keeping the id and moving only the binding touches one column.

**Consequences.** One extra indexed read per `requireActor` (`users` by `cognito_sub` or `id`).
Code that treats the token's subject as an account id is wrong for a re-linked account and fails
closed (account guard, standing, export: refused or not found) — never served another account's
state; consumers pass `actor.id` ([MIGRATION_v5_to_v6.md](../MIGRATION_v5_to_v6.md) §1b, TASK-174 row).

### Amendment to D4 (review 15, 2026-10-25) — a re-link moves an account once, to the right person

A hostile review found the command's choice of target unsafe and its bulk run unscalable. D4 now
also holds:

- **D4a — a target is unbound in the current pool.** The account's current subject must not be a
  user of the current pool (ListUsers `sub = "…"`, `IdentityDirectory.findBySub`), and no
  `identity_relinked` record may name the account and this pool. `users.email` is not kept in
  step with the pool (since TASK-185 it follows the pool only when the account's own person signs
  in, D5b): once an account is moved, the person may change their address there and
  someone else may take it — without D4a the next routine run moved the staff account to that
  stranger. Replacing an identity of the current pool is account recovery, never this command
  (refused with that guidance; no flag).
- **D4b — the pool move time decides who is old.** `--created-before <time>` (ISO 8601 with its
  zone) is required; an account provisioned at or after it was made in the new pool and is never
  a target nor counted. Of the accounts made before it, one whose address was verified
  (`users.email_verified`) is the target and unverified ones never block it (anyone can type an
  address at sign-up); an unverified account is a target only when the operator names it
  (`--unverified-account <id>`; bulk `--accept-unverified`, and only as the address's one).
  _Superseded in part by D4f (TASK-176): the address's one pre-move account is the target
  whatever its own flag; `--accept-unverified` is removed._
- **D4c — addresses compare as ASCII.** An address is trimmed with only its ASCII letters
  lower-cased, in the command and in provisioning (`storedEmail`); a non-ASCII address is refused
  by the command. `toLowerCase()` had folded a Kelvin sign onto "k", storing a lookalike sign-up
  as the staff address. The ban carry-over still matches a lookalike folded (over-matching a ban
  is the safe side).
- **D4d — bulk is chunked and set-based.** Every address is planned first (any refusal stops the
  run before anything changes, unless `--skip-ambiguous`); two plans binding one identity are both
  refused (`subject.contested`); then each chunk of 500 addresses is one owner transaction that
  plans again under `for update` (a changed address is refused `account.changed`) and applies in
  two statements; lookups are one statement per chunk on migration 055's index. A chunk commits
  whole or not at all; a run interrupted after a commit is reported (exit 6) and completed by
  running it again.
- **D4e — after the commit, failure to invalidate is a warning, not a rollback claim.** Each
  subject's invalidation is caught and reported; the command says "Applied" and names what was
  not voided and the bound (≤ 60 s), exit 5. The command's database settings are checked as the
  environment contract checks them, stricter for a workstation (no TLS option in the URL, no
  plaintext to a remote host, the CA with verify-full).

### Amendment (TASK-176, 2026-10-25) — `users.email_verified` follows the pool; a re-link asks the current pool

**Problem.** Sign-up provisions the account before the person confirms the address, so it is
stored `email_verified = false`, and nothing updated it after they confirmed and signed in — most
real accounts said "unverified". D4b then made almost every legitimate staff re-link need
`--unverified-account`, and every other reader of the flag (the first-administrator promotion,
`makeTenantAdmin`) read a false fact.

- **D5 — the flag follows the provider, one way.** `requireActor` reads the bound account's
  `email` and `email_verified` in the statement that resolves the binding
  (`resolveAccountRecord`) and compares them with the provider's answer for the token (Cognito
  `GetUser`, cached by token-verification; for a federated user the pool's mapped
  `email_verified`). When the row says false and the claim says exactly `true` for the same
  address (trimmed, ASCII letters case-folded — `storedEmail`), one conditional update
  (`where email_verified = false and email = <stored>`) sets it and writes its audit record
  (`profile_updated`, `field: email_verified`) in the same transaction. No read of its own and no
  write per request: once per account. Never from an unverified or absent claim, never
  true → false (a pending address change, a provider that stopped sending the claim, a provider
  outage — the request is refused before, or verified from a remembered verified answer — all
  leave it), and a failure is logged and retried on the next request, never a refused request.
- **D5a — `users.email` is not rewritten.** _Superseded by D5b–D5d (TASK-185, below)._ When the pool's verified address differs from the
  stored one (changed there) or the row has none, nothing changes. The stored address is what a
  ban follows to a new identity (A-11: rewriting a banned account's address would free the old
  address of its ban) and what D4 matches accounts by, and an address change of an existing
  account is account recovery with the person, not a side effect of a request. D4a already
  assumes `users.email` is not kept in step with the pool.
- **D4f — for a re-link target, the current pool's verification is the evidence, not the old
  row's flag.** An old-pool account can never sign in again, so D5 can never update it, and no
  migration can backfill it (only the old pool knew who confirmed). What the flag protected
  against was a row whose address was typed by someone who never controlled it. In the old pool
  such a sign-up stayed unconfirmed and could not sign in — Cognito confirms an address by a code
  sent to it — so the row holds nothing but its sign-up; whoever confirmed it controlled the
  inbox. The command already requires the current pool's user to have the address verified
  (`pool.unverified`), i.e. the person proved control of it now. So the address's **one** account
  made before the move is the target whatever its own flag (the plan and the audit record say
  `accountUnverified`). The flag still breaks ties: one verified pre-move account is the target
  beside unverified ones; several pre-move accounts none verified are `account.many` (their ids
  offered) unless the operator names one (`--unverified-account`, recorded `unverifiedAccepted`).
  `--accept-unverified` is removed (its case is now the default; an unknown argument is refused,
  never ignored). Unchanged, so the takeover protections stand: accounts made at or after
  `--created-before` are never counted or chosen — a post-move sign-up with a staff address
  (unverified or verified) can neither block nor be the target, nor be named (H1/M1, D4b);
  an account bound in, or re-linked in, the current pool is never moved (D4a); the pool must hold
  exactly one enabled, confirmed, verified user of the address.
  _Residual:_ an old-pool account made through a federated provider that sent an unverified
  claim (the only way an unconfirmed address could sign in) and is its address's only pre-move
  account is moved to the address's verified owner in the new pool — the owner gains what that
  account held, nobody gains the owner's; staff roles are granted by staff, and
  `makeTenantAdmin` still requires a verified row.
  _Superseded in part (review 16): an account whose own flag is false is moved only on the
  operator's confirmation for it (D4f, amended, below); the residual above no longer applies._

### Amendment (review 16, 2026-10-26) — the right subject, an explicit confirmation, a truthful report

**Problems.** (1) The re-link wrote the pool's `sub` attribute, but the platform's own verifier
names a request by the Cognito **username** (the access token's `username`, GetUser's `Username`):
for a native user of an address pool the two coincide, for a federated user (`Google_1093…`) they
never do — a re-linked Google staff account was unreachable. (2) D4f's residual was larger than
stated: an old-pool account whose own address was never verified (an administrator-created or
phone-confirmed account with a mistyped address, or an address that changed hands) went to
whoever verified that address in the new pool, with only a printed note. (3) The invalidation's
failures were swallowed below the command, so its report said "voided on every instance" when
nothing was published. (4) Smaller gaps (L1–L9 of the review).

- **D6 — the subject bound is the verifier's, said, never guessed.** The command takes
  `--subject username|sub` (required): `username` for the platform's provider
  (`platform/auth/cognito-provider.ts`), `sub` for a provider that binds the token's `sub`
  (Playform's SDK-based provider). `DirectoryUser.subject` carries that value; it is what
  `users.cognito_sub` is set to, what an account's current subject is asked of the pool by
  (ListUsers `username = "…"` or `sub = "…"`, exact), what two plans contest (`subject.contested`)
  and what a stray's id is. A legacy row (no `cognito_sub`) is bound — and asked — by its id
  (L3). The audit record names the attribute (`subjectAttribute`).
  _Superseded (TASK-177, below): the subject is always the `sub`; the flag and the attribute are
  gone._
- **D4f, amended — an unverified account moves only on an explicit confirmation for it.** The
  current pool's verification proves who holds the address **now**, not that it was the account's
  person's when the account was made. An account whose `users.email_verified` is false is re-linked
  only when the operator names it (`--confirm-unverified <id>`, repeatable; `--unverified-account
<id>` is also its confirmation), recorded `unverifiedConfirmed`; otherwise it is refused
  `account.needs_confirmation`, single and bulk alike, and the dry run lists each such account with
  its flag. The old pool, which could have shown whether the address was verified there, is out of
  reach once deleted (while it exists, the runbook says to look before confirming). A named
  `--unverified-account` that is not the chosen target is refused, never silently replaced (L1).
- **D7 — which providers' `email_verified` is believed.** A federated user's `email_verified` is
  only as good as its provider. An allow-list, `AUTH_TRUSTED_EMAIL_IDPS` (default `Google`;
  `SignInWithApple` may be added), governs it everywhere it matters: the re-link (an untrusted
  provider's user is `pool.unverified`, and does not count when choosing among several users),
  provisioning (`users.email_verified` of a new account) and the D5 sync. A native user (Cognito's
  own code) is always believed; a token that does not say who verified it
  (`TokenPayload.identityProviders` absent) is not. **Microsoft Entra ID is never to be listed**:
  its `email` is a mutable attribute the account's own tenant sets, unverified ("nOAuth").
- **D8 — what the command reports is what happened.** The invalidation it uses is strict
  (`publishInvalidation`: each stamp's outcome; the command throws per subject when either was
  not published), so `notInvalidated` and exit 5 are true. A connection lost at a chunk's COMMIT is
  `indeterminate` (exit 7: "may have committed — run the verify command"), never "nothing was
  changed" (L7). A dry run that refused anything exits 1, `--skip-ambiguous` or not (L5); an
  address the dry run refused stays refused when applied (L2).
- **D9 — a pool squatter does not block.** Of several pool users with an address, those that are
  unconfirmed or unverified (or verified only by an untrusted provider) are ignored when exactly
  one enabled, confirmed, verified user exists for it (L4).
- **TASK-175 follow-up.** On a resume, every status the run's own path writes before or around
  its claim (a budget refusal, an approval mismatch, a hold, a failure, the completion) is a
  compare-and-set from the open statuses; one that does not apply refuses the call
  (`HeldActionNotApprovedError`). A `TrajectoryStore` must declare `supportsStatusCas: true` —
  `resumeApprovedAction` refuses a store that does not (`TrajectoryStoreCasError`) — and the
  conformance kit tests it (L6).

### Amendment (TASK-177, 2026-10-26) — the subject is the Cognito `sub`

**Problem.** Review 16's D6 made the operator say which attribute a deployment binds, because the
platform's own provider named a request by the pool's **username** while Playform's names it by
the token's **sub**. That kept a flag an operator could get wrong — and hid a defect: provisioning
accepts only a UUID subject, so on the platform's own provider a brand-new federated (Google) user,
whose username is `Google_1093…`, could never be provisioned. The provider's own payloads were not
even consistent with themselves: sign-in, SSO and MFA sessions named the user by `sub`, the
verified token by `username`, so a sign-out's revocation (keyed by the session's subject) missed
the verifications of a federated user.

**Decision — D10.** The subject is the Cognito `sub`, everywhere, for every provider: a UUID,
unique in the pool and never reused, of the same form for a native and a federated user. A
username embeds the federated provider's id and differs in format; it is never a subject.

- The platform's `CognitoAuthProvider` names a verified token by its signed `sub` claim
  (`TokenPayload.sub`); a GetUser answer whose `sub` attribute is another user's is refused.
  Sessions (sign-in, SSO, MFA, new password, refresh), revocation stamps
  (`revokeTokenVerification`, `tokenSubject` at sign-out, the stamp after an address is verified —
  AdminGetUser's `sub`), `getUserInfo`, provisioning and the identity tenant all use it — exactly
  as Playform's provider does.
- An administrative call (`AdminUpdateUserAttributes`, `AdminGetUser`) names a user by its pool
  username — Cognito accepts a native user's `sub` there, never a federated user's. The provider
  learns the username from the signature-checked `username` claim of the user's own token (and
  from GetUser), never guessed, in a bounded per-instance map; a subject it has not seen is
  addressed by its `sub` (right for every native user). The assignment after a federated first
  sign-in always follows that user's verified token on the same instance; a miss fails closed
  (`service.unavailable`), never another user. The username is also evidence that a user with no
  `identities` attribute is native (D7) — evidence only, never a subject.
- The re-link binds the `sub` always: `IdentityDirectory` is `findByEmail` + `findBySub` (the
  review-15 shape; `subjectAttribute` and `findBySubject` are gone); `DirectoryUser.sub` is the
  subject and `username` is shown to the operator only. `--subject` is removed: `--subject sub` is
  accepted for one release as a no-op with a deprecation note, anything else is refused (usage,
  exit 2). The audit record no longer carries `subjectAttribute`.
- The token-verification conformance kit proves it for any provider (a federated token is named by
  its `sub`; a revocation by the `sub` voids it, one by the username voids nothing).

**No data migration.** platform-foundation has no deployment with existing users, so nothing was
ever bound to a username. A consumer whose provider bound usernames would need its rows re-bound;
Playform's provider has always bound the `sub`, so it needs nothing.

### Amendment (review 17, TASK-178, 2026-10-26) — whose sign-out it is, and the pool's shape

**Problem.** Sign-out took the subject to revoke and the `logout` actor from the refresh cookie,
`<user id>.<refresh token>` — unsigned. An attacker's own refresh token behind a victim's id made
the platform void the victim's remembered verifications and record the victim's `logout`; a bearer
of user A with a cookie naming B voided B and never A (whose GlobalSignOut happened). The
conformance kit's mismatch case could not fail; a GetUser answer without `sub` was accepted and its
`Username` remembered; the native-user rule assumed `identities` readable and the pool signing in
by email address (the refresh's `SECRET_HASH` is computed with the `sub`), with nothing checking
either; `AUTH_TRUSTED_EMAIL_IDPS` matched case-sensitively and refused spaces after commas.

**Decision — D11.** A subject is used for a security effect only when the provider proved it:

- **Sign-out** revokes and records only a proven subject: the bearer, verified (`verifyToken`)
  before its sign-out ends it; else the cookie's user, proven by the provider issuing a session
  for the cookie's id from its refresh token (`REFRESH_TOKEN_AUTH` — whose fresh access token is
  then the one signed out everywhere). The cookie's id is used only when it equals a proven
  subject; `RevokeToken` succeeding proves nothing about it. Nothing proven: the tokens are still
  revoked, the record has no actor, no stamp is written.
- **The refresh cookie is tamper-evident**: `<user id>.<mac>.<refresh token>`, the MAC an
  HMAC-SHA256 under `REFRESH_COOKIE_KEY` (a new required setting with a real auth provider) over
  a label, the id and the token. Every reader (refresh, sign-out) refuses a cookie whose MAC fails
  under the current key and `REFRESH_COOKIE_KEY_PREVIOUS` (rotation: verifies, never signs).
  Cookies issued before this are refused — those users sign in again once.
- **GetUser must name the token's own `sub`**: an answer without one is invalid, and the pool
  username is remembered only after that check. The conformance kit asserts both (a lookup for
  another sub and one without a sub return `null`), and fails against a provider without the check.
- **The pool's shape is required and checked** (D7's evidence rests on it): users sign in by email
  address (`UsernameAttributes` includes `email`), and the app client may read `identities`.
  `checkPoolShape` (`DescribeUserPool`, `DescribeUserPoolClient`, administrative credentials)
  backs the readiness probe `identity-pool`: a username-sign-in pool is **unready** (it cannot
  refresh a session and is fixed at creation); `identities` hidden is **degraded** and the provider
  then takes no user as native; without credentials the operator's check is logged once and
  documented (ENV_REFERENCE "Cognito pool shape"). A user whose `identities` lists any provider —
  a native user linked with `AdminLinkProviderForUser` included — is that provider's user.
- `AUTH_TRUSTED_EMAIL_IDPS` names match case-insensitively, trimmed around commas; a malformed
  value is refused by the environment contract and by the re-link command (exit 2).

### Amendment (TASK-185, 2026-10-28) — `users.email` follows the pool too; supersedes D5a

**Problem.** D5a kept `users.email` as provisioning first wrote it. An account provisioned
without an address — a first request whose caller passed no profile (`isInGoodStanding`), a
federated sign-in whose provider sent none at first — kept `email` NULL for good: the admin
console listed it as "—", and the ban carry-over (A-11), which matches by address, never saw it.
On playform-dev that was every account made by a first sign-in on the new pool and every Google
sign-in.

- **D5b — the address is recorded from the same trusted claim as the flag.** The sync
  (`platform/auth/email-verification.ts`) now also writes `users.email`, verified, when the claim
  is a trusted verified one (D5, review 16 L8: `emailVerified` exactly true; the pool itself, or
  federated providers all in `AUTH_TRUSTED_EMAIL_IDPS`) and the row has **no address**, or a
  **different** one on an **active or warned** account — a different one only from the provider's
  own answer to this request (`TokenPayload.addressFresh`, set by the token verifier, never on a
  remembered verification or an outage stand-in: two devices whose remembered answers differ
  would otherwise flip it between them for the cache window). Never from an unverified, untrusted or
  unsaid claim, and never a value that is not an address (one `@`, printable, ≤ 254 characters).
  One conditional update names the value it read (`email is not distinct from <read>`) and, for a
  change, re-checks the status; its `profile_updated` record (`field: email`, `change`) is in the
  same transaction and never holds the address.
- **D5c — a ban is never loosened by it.** A banned account's address is never moved (D5a's
  reason stands: the ban follows the stored address); a restricted or suspended account's waits
  until it is active again. The recorded address goes through the ban carry-over
  (`banFollowsAddress`, shared with provisioning): an address that a banned account of the tenant
  holds, or that an account erased while banned left as a hash, bans this account too
  (`platform:ban-carry-over`, recorded `banCarriedOver`).
- **D5d — where it runs.** Every request through `requireActor`, as D5, and the admin console's
  session read (`GET /api/admin/session`), since staff requests go through `requireAdmin`.
  Provisioning's callers pass the token's profile where they hold it (`isInGoodStanding(id,
profile)`, the guest route). No backfill: only the pool knows the address; an account whose
  person never signs in again keeps none, and the console says so.

D4a is unaffected and still needed: the re-link chooses its target from the pool's user for the
address and never moves an account bound in the current pool; an address kept in step with the
pool only makes the stored one more current.

## References

- Phase 1 Identity & Access Plan (Playform_Phase1_Identity_Access_Plan_v1.0.pdf)
- ADR-006: Database Architecture
- ADR-009: Security Standards
