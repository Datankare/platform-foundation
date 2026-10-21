/**
 * platform/route-policy/app-route-policy.ts — The consuming app's route guards (TASK-136)
 *
 * CONSUMER-OWNED. platform-foundation ships this file empty; an app that consumes it declares
 * here the functions it uses to verify callers and apply rate limits, and any of its own routes
 * that are public or exempt by design — and lists this path in its sync exclude list so the sync
 * never overwrites it. See ./spec.ts for what each field means and how the tests check it.
 *
 * @module platform/route-policy
 */

import type { AppRoutePolicy } from "./spec";

export const APP_ROUTE_POLICY: AppRoutePolicy = {
  verifiers: [],
  limiters: [],
  publicRoutes: {},
  rateLimitExempt: {},
};
