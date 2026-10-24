/**
 * platform/tenancy/route.ts — every route handler runs in its own tenant scope (ADR-053 D3)
 *
 *   export const POST = tenantRoute(async (request: NextRequest) => { … });
 *
 * The scope starts empty; the route's rate limit (anonymous: the address's tenant) and its
 * verifier (the identity's tenant) fill it, and everything the handler then does — stores,
 * caches, budgets, audit — reads that one tenant. A CI check (__tests__/api-route-tenant.test.ts)
 * requires every exported handler of every API route to be wrapped.
 *
 * @module platform/tenancy
 */

import { runRequestScope } from "./context";

/** Wrap a route handler so it runs in its own tenant scope. Arguments pass through unchanged. */
export function tenantRoute<A extends unknown[], R>(
  handler: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  const wrapped = (...args: A): Promise<R> => runRequestScope(() => handler(...args));
  Object.defineProperty(wrapped, "name", { value: handler.name || "tenantRoute" });
  return wrapped;
}
