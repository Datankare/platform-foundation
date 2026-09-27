# ADR-050: Deployment Environment Contract

Status: Proposed (Phase 5 Sprint 7A). Decision maker: Raman Sud.
Related: ADR-048 D3 and ADR-049 D1 (durable stores fail closed in production), ADR-049 D2 (session ownership), TASK-089 (production-boot check), TASK-091/092 (database baseline, production database), Sprint 7A (deployment & auth readiness). `platform/providers/registry.ts`, `platform/auth/*`, `instrumentation.ts`.

---

## 1. Context

Sprint 7 milestone 3 put the platform on a real deployment (`playform-dev` on Vercel) for the first time. Everything had been exercised in tests only, and the first deployment failed in ways no test could see:

| Finding                                             | Cause                                                                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Health 503                                          | No database configured; the ADR-048/049 guards failed closed (correctly)                                              |
| Every signed-in call rejected                       | Server running the **mock** auth provider — no `AUTH_PROVIDER` set, and nothing refused a test double in a deployment |
| SSO buttons always error                            | SSO never wired to the identity provider                                                                              |
| "Continue as Guest" admits, then every action fails | The platform auth check has **no guest path**                                                                         |
| Guest tokens forgeable                              | Guest tokens are base64 JSON with **no signature**; verification only decodes and checks expiry                       |
| Music / audio upload offered but can never work     | Optional features shown although not configured                                                                       |
| The deployed address ran old code                   | Vercel project tracked `main` instead of `develop`                                                                    |
| Two variables for one setting                       | `NEXT_PUBLIC_SUPABASE_URL` silently overrides `SUPABASE_URL`                                                          |
| E2E green while users saw errors                    | Journey tests accept "any alert" as success                                                                           |

The Cognito user pool behind the deployment had also been deleted with its AWS account (inactivity), so the deployment pointed at an identity provider that no longer existed.

## 2. Decisions

**D1 — No test doubles in production.** In a production context the runtime refuses to boot with the mock auth provider (and any other provider registered as a test double), exactly as ADR-048 D3 refuses in-memory stores. The `E2E_IN_MEMORY_STORES` harness opt-out does not extend to auth; the E2E harness runs against a real provider or a documented test provider.

_Implementation (7A A1):_ `assertEnvironmentContract()` (`platform/providers/environment-contract.ts`) runs first in `initProviders()`. `AUTH_PROVIDER` unset or `mock` is refused in production. An E2E harness running the production build opts in with its own switch, `E2E_TEST_DOUBLE_AUTH=true` (the "documented test provider"); every harness switch (`E2E_*`, `ADMIN_DEV_BYPASS`) is itself refused on a hosted deployment (`VERCEL=1`), so an opt-out cannot leak onto Vercel.

**D2 — The environment contract is declared and checked at boot.** Each required setting is declared once, with its shape (e.g. `SUPABASE_URL` is `https://<ref>.supabase.co`, no path, no trailing slash). Boot validates presence and shape and fails closed with the setting's name. Where two variables historically fed one setting (`NEXT_PUBLIC_SUPABASE_URL` vs `SUPABASE_URL`), the contract names one source and fails if both are set and disagree.

_Implementation (7A A1):_ `ENVIRONMENT_CONTRACT` declares `AUTH_PROVIDER`, the Cognito pool id, client id and region, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — each with one canonical name, its aliases and a shape. The canonical name is the one the widest reader needs: `NEXT_PUBLIC_COGNITO_*` (the browser needs the ids), `SUPABASE_URL` (server-only; a `NEXT_PUBLIC_` value is also baked into the client bundle at build time). In production an alias alone, or an alias that disagrees, is a violation. Every reader goes through the contract's resolvers (`getSupabaseUrl`, `getCognitoSettings`, `getAuthProviderSetting`) — the Supabase readers that read only `NEXT_PUBLIC_SUPABASE_URL` (`lib/supabase/server`, the account-status guard, the metrics sink) had no database on a deployment that set `SUPABASE_URL`. `AWS_REGION` is no longer read (a host sets it to the function's region, not the pool's); the Cognito region defaults to the pool id's own prefix and must match it. The service-role key must be the legacy JWT. Violations are reported together, by name, never with values.

**D3 — Optional features declare their settings; the UI offers only configured features.** Music identification, audio upload/transcription and each SSO provider declare the settings they need. A feature whose settings are absent is not offered (hidden, or shown as unavailable) rather than failing with "please try again".

**D4 — Guest identity is signed, opt-in and namespaced.** Guest tokens carry an HMAC signature under a server secret (`GUEST_TOKEN_SECRET`) and verification checks it. Guest access is granted only on routes that opt in (e.g. translate); every other route keeps requiring a real user. Guest actor ids are namespaced so they can never collide with a user id. Guest usage is bounded by governed configuration (a per-guest allowance, admin-settable within declared min/max).

_Implementation (7A A2 — signing):_ guest tokens are platform-owned. `platform/auth/guest-token.ts` mints `guest.<payload>.<HMAC-SHA256>` under `GUEST_TOKEN_SECRET` (declared in the contract; required whenever auth is a real provider) and verifies the MAC in constant time (Web Crypto — Node and Edge alike), then the claims: version, `typ`, a namespaced id (`guest_` + 128 random bits — never a user id), `iat` not in the future, unexpired, lifetime ≤ 30 days. Providers delegate to it; the platform's guest check (A3) calls it directly, so a provider with a weaker guest format cannot widen what the platform accepts. Outside production an unset secret falls back to a per-process random one.

**D5 — Every deployment is smoke-tested as deployed.** After each deploy to dev and staging, CI checks health and performs a real signed-in (or guest) translate against the deployed address. Unit and E2E tests stay; this is the layer that sees configuration.

**D6 — Deployment topology is explicit.** Each Vercel project maps to one branch (`playform-dev` ← `develop`, `playform-staging` ← `staging`, production ← `main`), and production has its own database (TASK-092). The mapping is documented and checked by the smoke test (it reports the deployed commit).

## 3. Consequences

- A misconfigured deployment fails at boot with a named setting, instead of running degraded.
- Guests become a supported, bounded, verifiable identity rather than an unsigned string.
- The UI stops offering features the deployment cannot perform.
- Consumers inherit D1, D2 and D4 on sync; D3's UI part and D5/D6 are per consumer.

## 4. Alternatives rejected

- **Documentation-only environment checklist.** It is what existed implicitly; nothing enforced it, and the deployment drifted on day one.
- **Accept unsigned guest tokens with rate limiting.** Forgeable identities cannot be rate-limited per identity.
