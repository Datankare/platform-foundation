# platform/auth/

Authentication and authorization infrastructure — cloud-agnostic.

## Architecture

This module defines the `AuthProvider` interface — the contract that any
authentication provider must implement. Routes, middleware, and components
depend on this interface, never on a provider directly.

See [ADR-012](../../docs/adr/ADR-012-auth-architecture.md) for the full
architecture decision.

## Files

| File             | Purpose                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `types.ts`       | Provider-agnostic type definitions (AuthResult, TokenPayload, etc.)                                         |
| `provider.ts`    | `AuthProvider` interface — the contract                                                                     |
| `index.ts`       | Public API — re-exports types and interface                                                                 |
| `guest-token.ts` | Platform-owned signed guest tokens (ADR-050 D4) — providers delegate here                                   |
| `middleware.ts`  | `requireAuth`, `optionalAuth`, `requirePermission`, `requireActor` (user, or guest where the route opts in) |
| `actor-guard.ts` | `requireActorWithStatus` — actor + account status (users only; guests are bounded by the guest allowance)   |

## Usage

```typescript
import type { AuthProvider, AuthResult } from "@/platform/auth";
```

### Routes that serve guests (ADR-050 D4)

Guest access is opt-in per route. A route that serves guests says so; every other route keeps
requiring a real user, and a guest there gets `401 { code: "sign_in_required" }`.

```typescript
import { requireActorWithStatus } from "@/platform/auth";

const guard = await requireActorWithStatus(request, "translate", { allowGuests: true });
if (guard.error) return guard.error;
// guard.actor.kind === "user" | "guest"; guard.actor.id — guest ids are `guest_…`, never a user id
```

A route that opts in must enforce the guest allowance (7A B1) before any paid call.

## Implementations

| Provider       | Location             | Status           |
| -------------- | -------------------- | ---------------- |
| AWS Cognito    | Playform (private)   | Phase 1 Sprint 2 |
| Mock (testing) | `__tests__/helpers/` | Phase 1 Sprint 1 |

## Phase

- Phase 1 Sprint 1: Interface + types + mock
- Phase 1 Sprint 2: Cognito implementation (Playform)
- Phase 1 Sprint 3+: Integrated into permissions middleware

---

_See [ADR-012](../../docs/adr/ADR-012-auth-architecture.md) for architecture context._
