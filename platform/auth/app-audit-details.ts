/**
 * platform/auth/app-audit-details.ts — The consuming app's own audit details (TASK-194, rebase I-1)
 *
 * CONSUMER-OWNED. platform-foundation ships this file empty; an app that consumes it registers the
 * detail keys its own audit records carry (its own routes and domain) and lists this path in its
 * sync exclude list, so the sync never overwrites it — as platform/errors/app-codes.ts does for
 * error codes. The platform's keys and actions live in audit-details.ts and are never declared
 * here; audit-details.ts merges the two (AUDIT_DETAIL_KINDS, AUDIT_DETAILS_SCHEMA).
 *
 * Rules, held by __tests__/audit-details-schema.test.ts:
 *   - an app key or action never redefines a platform one;
 *   - an app kind is never "text": free text a person wrote is erased with the account it is
 *     about, and the erasure's list of text keys is the platform's (platform/auth/user-data.ts);
 *   - every entry is written by a call site of the app (no entry nobody writes).
 *
 * @module platform/auth
 */

import type { AppDetailKind, DetailsSchema } from "@/platform/auth/audit-details";

/** Every key the app's own records may carry, and its kind (never "text"). */
export const APP_AUDIT_DETAIL_KINDS: Readonly<Record<string, AppDetailKind>> = {};

/**
 * Per action — for admin_action, per `admin_action:<type>` — the keys the app's own records may
 * carry beside the platform's COMMON_DETAIL_KEYS.
 */
export const APP_AUDIT_DETAILS_SCHEMA: DetailsSchema = {};
