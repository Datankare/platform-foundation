/**
 * platform/auth/admin-key-readiness.ts — what operator readiness asks of an identity provider's
 * administrative key, shared by every Cognito provider (N-22, N-52, TASK-203)
 *
 * The erasure check looks up and "deletes" ERASURE_PROBE_USERNAME, a name no pool user can have, to
 * learn whether the key may call ListUsers and AdminDeleteUser without touching anyone; the
 * client-secret check compares the app client's secret, read with the key, with the one the
 * deployment holds — in constant time, never logged, never returned. Each Cognito provider (the
 * platform's fetch-based one, an app's SDK-based one) runs the calls; this module holds what they
 * share.
 *
 * @module platform/auth
 */

import { shown } from "@/platform/errors/shown-text";
import { createHash, timingSafeEqual } from "node:crypto";
import type { ClientSecretReadiness } from "@/platform/auth/provider";

/**
 * The pool username erasure readiness looks up and "deletes" (N-22): no pool user can have it —
 * a native user's username is its sub (a UUID) or address, a federated one's `Provider_id` — so the
 * lookup finds none and the delete answers UserNotFoundException when the key may call it.
 */
export const ERASURE_PROBE_USERNAME = "platform-erasure-readiness-probe";

/**
 * The app client's secret as the pool holds it against the one the deployment holds (N-52):
 * compared as SHA-256 digests in constant time, so neither the length nor a prefix leaks.
 */
export function compareClientSecrets(
  pool: string | undefined,
  held: string | undefined
): ClientSecretReadiness {
  if (!pool && !held) return { state: "ready" };
  if (pool && !held) {
    return {
      state: "mismatch",
      reason: shown("screens.readiness.secret_not_held"),
    };
  }
  if (!pool && held) {
    return {
      state: "mismatch",
      reason: shown("screens.readiness.secret_not_in_pool"),
    };
  }
  const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
  return timingSafeEqual(digest(pool!), digest(held!))
    ? { state: "ready" }
    : {
        state: "mismatch",
        reason: shown("screens.readiness.secret_differs"),
      };
}

/**
 * Whether a Cognito error type is the key's policy refusing the action (IAM's AccessDenied; the
 * older names some endpoints answer), as against a throttle or an outage.
 */
export function isAccessRefusal(type: string | undefined): boolean {
  return (
    type === "AccessDeniedException" ||
    type === "UnauthorizedOperation" ||
    type === "NotAuthorizedException"
  );
}
