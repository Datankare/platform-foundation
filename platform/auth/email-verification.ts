/**
 * platform/auth/email-verification.ts — Keep users.email_verified in step with the identity
 * provider (TASK-176, ADR-012 amendment)
 *
 * An account made by POST /api/auth/sign-up is provisioned at once, before the person has
 * confirmed the address, so its row says `email_verified = false`. Nothing changed it afterwards:
 * after they confirmed the address with the code and signed in, the row still said false — for
 * most real accounts. Everything that reads the flag (the first-administrator promotion,
 * platform/tenancy/admin.ts makeTenantAdmin; the identity re-link's tie-break between accounts,
 * platform/auth/identity-relink.ts) read a fact that was not true.
 *
 * Now every request of a signed-in user through requireActor (platform/auth/middleware.ts) brings
 * the flag up to date from what verified the request — the identity provider's own answer for
 * the token (Cognito GetUser: `email`, `email_verified`; for a federated user, the provider's
 * claim mapped into the pool's `email_verified` attribute):
 *
 *   cheap        the account's stored address and flag are read in the statement that resolves
 *                the binding (account-identity.ts resolveAccountRecord) — no read of their own;
 *                a write happens only when the flag is false and the claim says the same address
 *                is verified: once per account, never per request;
 *   one way      false → true only. Never set from an unverified claim (`emailVerified` must be
 *                exactly true), and never set back to false: a claim that says false (the person
 *                is changing their address in the pool, a federated provider that stopped
 *                sending the claim) and a provider that cannot answer (the request is refused
 *                before this, or verified from a remembered answer that was itself verified)
 *                leave the row as it is;
 *   same address only. The claim's address must be the stored one (both as stored: trimmed,
 *                ASCII letters in lower case — user-provisioning storedEmail). users.email is
 *                never rewritten here — not when the pool's address changed, not when the row
 *                has none: the stored address is what a ban follows to a new identity
 *                (user-provisioning, audit A-11: moving it would free the old address of the
 *                ban) and what the re-link matches an account by; an address change is the
 *                person's account recovery, not a side effect of a request. A row whose address
 *                differs from the pool's keeps its flag;
 *   trusted source only (review 16 L8). The claim is believed only when the pool itself verified
 *                the address (a native user: the person entered the code) or every federated
 *                provider the user signs in with is allow-listed (AUTH_TRUSTED_EMAIL_IDPS,
 *                default Google): a provider's email_verified mapped into the pool is only as
 *                good as the provider — Microsoft Entra ID's `email` is an attribute the
 *                account's own tenant can set to any address, unverified (nOAuth), so a user of
 *                another provider never marks an address verified, whatever the pool's mapping
 *                says. A token that does not say who verified it (identityProviders absent:
 *                a provider that does not fill it) is not believed either;
 *   race-safe    the update says `where email_verified = false and email = <the stored value>`:
 *                of concurrent requests one changes the row, the others change nothing and
 *                record nothing;
 *   audited      the change and its record (profile_updated, field email_verified) are written in
 *                one transaction: no record, no change — and exactly one record per change;
 *   best effort  a failure is logged and the request goes on (the flag stays as it was): it is
 *                tried again on the next request.
 *
 * GenAI Principles: P11 (fail-closed — only a verified claim of the same address moves the flag,
 * and only up), P3 (the change recorded)
 *
 * @module platform/auth
 */

import { withTenantTx } from "@/platform/data";
import { recordAudit } from "@/platform/auth/audit";
import { storedEmail } from "@/platform/auth/user-provisioning";
import type { StoredAddress } from "@/platform/auth/account-identity";
import { emailClaimTrusted } from "@/platform/auth/identity-directory";
import { getTrustedEmailIdps } from "@/platform/providers/environment-contract";
import { logger } from "@/lib/logger";

/** What verified the request says about the address: the provider's answer for the token. */
export interface AddressClaim {
  readonly email?: string;
  readonly emailVerified?: boolean;
  /** Who verified it: [] the pool itself, else the federated providers; undefined: not said. */
  readonly identityProviders?: readonly string[];
}

/**
 * What to do: nothing (and why), or mark the stored address verified. Pure; the whole rule.
 */
export type VerificationDecision =
  | {
      readonly kind: "none";
      readonly reason:
        | "already_verified"
        | "claim_unverified"
        | "claim_untrusted"
        | "no_address"
        | "address_differs";
    }
  | { readonly kind: "mark"; readonly email: string };

/**
 * Whether the claim says the address is verified by a source that may be believed (review 16
 * L8): `emailVerified` exactly true, from the pool itself or an allow-listed provider. What
 * provisioning stores as users.email_verified for a new account, and what the sync below acts on.
 */
export function trustedVerifiedClaim(
  claim: AddressClaim,
  trusted: ReadonlySet<string> = getTrustedEmailIdps()
): boolean {
  return (
    claim.emailVerified === true && emailClaimTrusted(claim.identityProviders, trusted)
  );
}

export function verificationDecision(
  stored: StoredAddress,
  claim: AddressClaim,
  trusted: ReadonlySet<string> = getTrustedEmailIdps()
): VerificationDecision {
  if (stored.verified) return { kind: "none", reason: "already_verified" };
  if (claim.emailVerified !== true) return { kind: "none", reason: "claim_unverified" };
  if (!emailClaimTrusted(claim.identityProviders, trusted))
    return { kind: "none", reason: "claim_untrusted" };
  const claimed = typeof claim.email === "string" ? claim.email.trim() : "";
  if (!claimed || stored.email === null || !stored.email.trim())
    return { kind: "none", reason: "no_address" };
  if (storedEmail(stored.email) !== storedEmail(claimed))
    return { kind: "none", reason: "address_differs" };
  return { kind: "mark", email: stored.email };
}

export type VerificationSync = "unchanged" | "marked" | "failed";

/**
 * Bring account `accountId`'s users.email_verified up to date from `claim` (see the header).
 * Never throws.
 */
export async function syncEmailVerification(
  accountId: string,
  stored: StoredAddress,
  claim: AddressClaim
): Promise<VerificationSync> {
  const decision = verificationDecision(stored, claim);
  if (decision.kind === "none") return "unchanged";
  try {
    return await withTenantTx(async (tx) => {
      const { rows } = await tx.query(
        `update users set email_verified = true
          where id = $1::uuid and email_verified = false and email = $2 and deleted_at is null
         returning id`,
        [accountId, decision.email]
      );
      if (rows.length === 0) return "unchanged" as const;
      // In the same transaction (it joins): a record that cannot be written undoes the change.
      await recordAudit({
        action: "profile_updated",
        actorId: accountId,
        targetId: accountId,
        details: {
          field: "email_verified",
          from: false,
          to: true,
          source: "identity_provider",
          verifiedBy: claim.identityProviders?.length
            ? claim.identityProviders.join("+")
            : "pool",
        },
      });
      return "marked" as const;
    });
  } catch (err) {
    logger.warn(
      "The account's address could not be marked verified; tried again next request",
      {
        accountId,
        error: err instanceof Error ? err.message : String(err),
        route: "platform/auth/email-verification",
      }
    );
    return "failed";
  }
}
