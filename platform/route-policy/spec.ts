/**
 * platform/route-policy/spec.ts — How an app declares its own route guards (ADR-052, TASK-136)
 *
 * Two CI tests scan every API route: each must verify its caller (`__tests__/api-route-auth.test.ts`)
 * and be rate limited (`__tests__/api-route-rate-limit.test.ts`). They recognise the platform's
 * verifiers and limiters by name. An app that wraps them — a route guard that adds its own account
 * rules, an agent context that verifies two principals — declares its wrappers in
 * app-route-policy.ts, and the tests then accept a route that calls them.
 *
 * A declared wrapper is not trusted on its name: the tests find its definition and require it to
 * call a platform verifier (or limiter), directly or through another declared wrapper. A
 * declaration cannot be used to bypass the checks.
 *
 * @module platform/route-policy
 */

export interface AppRoutePolicy {
  /** Names of the app's functions that verify the caller. Each must call a platform verifier. */
  readonly verifiers: readonly string[];
  /** Names of the app's functions that apply a rate limit. Each must call enforceRateLimit. */
  readonly limiters: readonly string[];
  /** The app's routes that are public by design (path from the repository root → reason). */
  readonly publicRoutes: Readonly<Record<string, string>>;
  /** The app's routes exempt from rate limiting (path → reason). */
  readonly rateLimitExempt: Readonly<Record<string, string>>;
}
