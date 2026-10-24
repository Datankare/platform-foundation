/**
 * @jest-environment node
 */
/**
 * __tests__/api-route-tenant.test.ts — every API route runs in its own tenant scope (ADR-053 D3)
 *
 * The tenant is established by the route's rate limit and verifier, which are helpers the
 * handler awaits; they can only fill a scope created around the whole handler. So every exported
 * handler is `export const METHOD = tenantRoute(…)` — or an app wrapper declared in
 * platform/route-policy/app-route-policy.ts (`routeScopes`) whose definition calls tenantRoute.
 * A handler declared any other way would run with no tenant, and every store would refuse it;
 * this check finds it in CI instead.
 */

import { APP_ROUTE_POLICY } from "@/platform/route-policy/app-route-policy";
import {
  apiRoutes,
  handlerCount,
  read,
  resolveDeclared,
  scopedHandlerCount,
} from "./helpers/route-policy";

const ROUTES = apiRoutes();
const SCOPES = resolveDeclared(["tenantRoute"], APP_ROUTE_POLICY.routeScopes ?? []);

describe("API routes run in a tenant scope (ADR-053 D3)", () => {
  it("finds a plausible number of routes (self-test before any absence counts)", () => {
    expect(ROUTES.length).toBeGreaterThan(20);
  });

  it("accepts each declared app scope only if it calls tenantRoute", () => {
    expect(SCOPES.problems).toEqual([]);
  });

  it("every exported handler is wrapped", () => {
    const unwrapped = ROUTES.filter((f) => {
      const src = read(f);
      return (
        handlerCount(src) === 0 ||
        scopedHandlerCount(src, SCOPES.accepted) < handlerCount(src)
      );
    });
    expect(unwrapped).toEqual([]);
  });

  it("recognises both forms, so an unwrapped handler is counted (self-test)", () => {
    const plain =
      "export async function GET(r: Request) {}\nexport const POST = tenantRoute(async () => {});";
    expect(handlerCount(plain)).toBe(2);
    expect(scopedHandlerCount(plain, ["tenantRoute"])).toBe(1);
    expect(
      scopedHandlerCount("export const GET = other(async () => {});", ["tenantRoute"])
    ).toBe(0);
  });
});
