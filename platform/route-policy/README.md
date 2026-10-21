# Route policy

How the two route checks recognise an app's own guards.

`__tests__/api-route-auth.test.ts` requires every API route to verify its caller, and
`__tests__/api-route-rate-limit.test.ts` requires every route handler to be rate limited (ADR-052).
Both recognise the platform's functions by name: `requireActorWithStatus`, `requireActor`,
`requireAuth`, `adminGuard` (verification) and `enforceRateLimit`, `adminGuard` (limits).

An app that wraps them declares the wrappers in **`app-route-policy.ts`** — consumer-owned, shipped
empty here, and listed in the app's sync exclude list (like `platform/errors/app-codes.ts`):

```ts
export const APP_ROUTE_POLICY: AppRoutePolicy = {
  verifiers: ["requireAuthWithStatus"], // lib/route-guard.ts
  limiters: ["resolveAgentRouteContext"], // lib/agent-route-context.ts
  publicRoutes: {}, // "app/api/…/route.ts": "reason"
  rateLimitExempt: {},
};
```

A declaration is checked, not trusted: the tests locate each declared function's definition and
require it to call a platform verifier (or `enforceRateLimit`), directly or through another declared
function. A wrapper that does neither fails CI.
