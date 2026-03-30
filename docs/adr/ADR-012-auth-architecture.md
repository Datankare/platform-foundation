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

### Cognito Implementation (Playform)

Playform provides the Cognito implementation of the `AuthProvider` interface.
This implementation:

- Configures the Cognito user pool (playform-auth, us-east-1)
- Handles SSO via Google, Apple, Microsoft identity providers
- Manages TOTP MFA via Cognito's built-in support
- Issues JWTs that Supabase validates via custom JWT configuration

### Supabase for Data (both repos)

Supabase provides:

- PostgreSQL database with Row-Level Security (RLS)
- Player data isolation (Player A cannot query Player B's data)
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

| Service     | Purpose                                     | Region    | Account             |
| ----------- | ------------------------------------------- | --------- | ------------------- |
| AWS Cognito | Authentication, MFA, SSO, password policies | us-east-1 | playform-auth       |
| Supabase    | PostgreSQL, RLS, data API                   | us-east-1 | Datankare/playform  |
| Vercel      | Hosting, CI/CD                              | —         | ramansud's projects |

### Cognito Details

- User Pool ID: us-east-1_VRyIcnOuP
- App Client: playform-web (SPA, PKCE, no client secret)
- Client ID: 5pb44pg40irb5v5p0k2atl7brk
- MFA: Optional, TOTP (authenticator apps)
- Device tracking: User opt-in, bypass MFA for trusted devices
- Sign-in: Email only
- Self-registration: Enabled
- Email verification: Required
- Password policy: 12+ chars, uppercase + lowercase + number + special
- Token signing: https://cognito-idp.us-east-1.amazonaws.com/us-east-1_VRyIcnOuP/.well-known/jwks.json

### Supabase Details

- Project URL: https://gjkngtsrgcjjvmyqrjmp.supabase.co
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

## References

- Phase 1 Identity & Access Plan (Playform_Phase1_Identity_Access_Plan_v1.0.pdf)
- ADR-006: Database Architecture
- ADR-009: Security Standards
