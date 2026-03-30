# platform/auth/

Authentication and authorization infrastructure — cloud-agnostic.

## Architecture

This module defines the `AuthProvider` interface — the contract that any
authentication provider must implement. Routes, middleware, and components
depend on this interface, never on a provider directly.

See [ADR-012](../../docs/adr/ADR-012-auth-architecture.md) for the full
architecture decision.

## Files

| File          | Purpose                                                             |
| ------------- | ------------------------------------------------------------------- |
| `types.ts`    | Provider-agnostic type definitions (AuthResult, TokenPayload, etc.) |
| `provider.ts` | `AuthProvider` interface — the contract                             |
| `index.ts`    | Public API — re-exports types and interface                         |

## Usage

```typescript
import type { AuthProvider, AuthResult } from "@/platform/auth";
```

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
