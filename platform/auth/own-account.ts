/**
 * platform/auth/own-account.ts — an account's own data routes store a new account first
 * (TASK-225)
 *
 * A signed-in identity's account row is made by its first guarded request (the account-status
 * guard, TASK-117). The account page can be a new person's first page (sign-in back to it,
 * E-113), and its export and delete routes check the caller's permission from that row: a new
 * account was told it had no permission. These routes now store the account first — only when it
 * has no row (an existing account, however its subject is spelled, is left exactly as it is), as
 * a guarded request would — so its permission is its role's. An erased identity stays erased; a
 * store that cannot answer refuses (retryable).
 *
 * @module platform/auth
 */

import { resolveAccount } from "@/platform/auth/account-identity";
import { provisionAccount } from "@/platform/auth/user-provisioning";

/** The caller's own account, made ready: stored, erased, or not decidable now. */
export type OwnAccount = "ready" | "erased" | "unavailable";

export async function storeOwnAccount(user: {
  readonly sub: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
}): Promise<OwnAccount> {
  let kind: string;
  try {
    kind = (await resolveAccount(user.sub)).kind;
  } catch {
    return "unavailable";
  }
  if (kind !== "unprovisioned") return "ready";
  const { outcome } = await provisionAccount(user.sub, {
    ...(user.email ? { email: user.email } : {}),
    ...(user.emailVerified !== undefined ? { emailVerified: user.emailVerified } : {}),
  });
  if (outcome === "erased") return "erased";
  return outcome === "failed" ? "unavailable" : "ready";
}
