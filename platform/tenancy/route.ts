/**
 * platform/tenancy/route.ts — every route handler runs in its own tenant scope (ADR-053 D3), and
 * answers only what it declared (TASK-215, audit A-13)
 *
 *   export const POST = tenantRoute(async (request: NextRequest) => { … }, POST_RESPONSE);
 *
 * The scope starts empty; the route's rate limit (anonymous: the address's tenant) and its
 * verifier (the identity's tenant) fill it, and everything the handler then does — stores,
 * caches, budgets, audit — reads that one tenant. A CI check (__tests__/api-route-tenant.test.ts)
 * requires every exported handler of every API route to be wrapped.
 *
 * Each handler is also counted as in flight while it runs (platform/observability/in-flight.ts),
 * so a stopping instance waits for it before closing its database pools (ADR-055 D5).
 *
 * The second argument is the body the handler answers with (platform/errors/response-schema.ts):
 * every JSON answer is checked against it — an error against the registry's one error body — so a
 * field nobody declared fails outside production and is removed, and logged, in production.
 * __tests__/api-route-response-schema.test.ts requires it on every exported handler.
 *
 * @module platform/tenancy
 */

import { trackInFlight } from "@/platform/observability/in-flight";
import { checkedResponse, type ResponseSchema } from "@/platform/errors/response-schema";
import { runRequestScope } from "./context";

/** The route a request named, for a response check's message and log line. */
function routeOf(args: readonly unknown[]): string {
  const first = args[0] as { nextUrl?: { pathname?: string }; url?: string } | undefined;
  if (first?.nextUrl?.pathname) return first.nextUrl.pathname;
  try {
    return first?.url ? new URL(first.url).pathname : "(a route)";
  } catch {
    return "(a route)";
  }
}

/**
 * Wrap a route handler so it runs in its own tenant scope, and its JSON answers are checked
 * against `responses`. Arguments pass through unchanged.
 */
export function tenantRoute<A extends unknown[], R>(
  handler: (...args: A) => Promise<R>,
  responses?: ResponseSchema
): (...args: A) => Promise<R> {
  const wrapped = (...args: A): Promise<R> =>
    trackInFlight(() =>
      runRequestScope(async () => {
        const answer = await handler(...args);
        if (responses === undefined || !(answer instanceof Response)) return answer;
        return (await checkedResponse(answer, responses, routeOf(args))) as R;
      })
    );
  Object.defineProperty(wrapped, "name", { value: handler.name || "tenantRoute" });
  return wrapped;
}
