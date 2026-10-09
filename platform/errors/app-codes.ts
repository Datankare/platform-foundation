/**
 * platform/errors/app-codes.ts — The consuming app's own error codes (ADR-051 D1)
 *
 * CONSUMER-OWNED. platform-foundation ships this file empty; an app that consumes it adds the
 * errors only it returns (its own routes and domain), and lists this path in its sync exclude
 * list so the sync never overwrites it. Platform codes live in registry.ts and are never
 * declared here.
 *
 * Every app code is `app.<area>.<name>` (lowercase, underscores). Its English message is
 * `errors.app.<area>.<name>` in messages/app/en.json — also consumer-owned. The registry merges
 * these with the platform's codes, so apiError() and the catalog checks treat both alike; app
 * codes are documented in docs/APP_API_ERRORS.md (generated).
 *
 * @module platform/errors
 */

import type { ErrorCodeSpec } from "@/platform/errors/spec";

export const APP_ERROR_CODES = {} as const satisfies Record<
  `app.${string}`,
  ErrorCodeSpec
>;
