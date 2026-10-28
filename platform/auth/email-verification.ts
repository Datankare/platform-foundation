/**
 * platform/auth/email-verification.ts — Keep users.email and users.email_verified in step with
 * the identity provider (TASK-176, TASK-185; ADR-012 amendment)
 *
 * An account made by POST /api/auth/sign-up is provisioned at once, before the person has
 * confirmed the address, so its row says `email_verified = false`; an account provisioned by a
 * request that carried no address (a federated sign-in whose provider sent none at first, a
 * caller of the status guard without the token's profile) has `email` NULL. Nothing changed
 * either afterwards (TASK-185: TASK-176 wrote the flag only, "never users.email — not when the
 * row has none"), so the admin console listed those accounts as "—" for good.
 *
 * Now every request of a signed-in user through requireActor (platform/auth/middleware.ts) — and
 * the admin console's session read (app/api/admin/session) — brings the row up to date from what
 * verified the request: the identity provider's own answer for the token (Cognito GetUser:
 * `email`, `email_verified`, `identities`):
 *
 *   trusted source only (review 16 L8). Nothing is written unless the claim says the address is
 *                verified (`emailVerified` exactly true) by a source that may be believed: the
 *                pool itself (a native user entered the code) or federated providers that are
 *                all allow-listed (AUTH_TRUSTED_EMAIL_IDPS, default Google). Microsoft Entra
 *                ID's `email` is an attribute the account's own tenant can set to any address
 *                (nOAuth), so a user of an unlisted provider never records or verifies an
 *                address. A token that does not say who verified it is not believed either;
 *   same address → the flag, false → true only (TASK-176); never set back to false;
 *   no address   → the claim's address is recorded (as stored: trimmed, ASCII letters in lower
 *                case — user-provisioning storedEmail), verified (TASK-185);
 *   another address → recorded too, verified — but only on an active (or warned) account, and
 *                only from the provider's own answer to this request (TokenPayload.addressFresh,
 *                set by token-verification.ts): a remembered answer never moves it — two devices
 *                whose remembered answers differ would flip it between them (TASK-185). A banned account's address is never moved: the stored address is
 *                what a ban follows to a new identity (user-provisioning, audit A-11), and moving
 *                it would free the old address of the ban. A restricted or suspended account
 *                keeps its address until it is active again;
 *   the ban follows the recorded address (A-11): an address recorded here that belongs to a
 *                banned account of the tenant, or to one erased while banned, bans this account —
 *                as provisioning does for a new one (banFollowsAddress), so an account that was
 *                provisioned without its address does not escape the carry-over;
 *   cheap        the stored address, flag and status are read in the statement that resolves the
 *                binding (account-identity.ts resolveAccountRecord) — no read of their own; a write
 *                happens only when something differs: once per change, never per request;
 *   race-safe    each update names the value it read (`email_verified = false and email = …`, or
 *                `email is not distinct from <the stored value>`): of concurrent requests one
 *                changes the row, the others change nothing and record nothing;
 *   audited      the change and its record (profile_updated, field email_verified or email —
 *                never the address itself) are written in one transaction: no record, no change;
 *   best effort  a failure is logged and the request goes on (the row stays as it was): it is
 *                tried again on the next request. An erased account awaiting its purge is never
 *                written (nothing would match, on every request).
 *
 * An account whose person never signs in again keeps what it has, and so does one whose person
 * signs in only through a provider that is not allow-listed or does not verify the address: the
 * console tells the two apart ("never signed in since <created>" only with no recorded sign-in;
 * otherwise "address not received from the sign-in provider"). There is no administrative backfill.
 *
 * GenAI Principles: P11 (fail-closed — only a trusted verified claim writes, and a ban is never
 * loosened by it), P3 (every change recorded)
 *
 * @module platform/auth
 */

import { withTenantTx } from "@/platform/data";
import { recordAudit } from "@/platform/auth/audit";
import {
  CARRIED_BAN_REASON,
  banFollowsAddress,
  storedEmail,
} from "@/platform/auth/user-provisioning";
import {
  resolveAccountRecord,
  type StoredAddress,
} from "@/platform/auth/account-identity";
import { emailClaimTrusted } from "@/platform/auth/identity-directory";
import { getTrustedEmailIdps } from "@/platform/providers/environment-contract";
import { logger } from "@/lib/logger";

/** What verified the request says about the address: the provider's answer for the token. */
export interface AddressClaim {
  readonly email?: string;
  readonly emailVerified?: boolean;
  /** Who verified it: [] the pool itself, else the federated providers; undefined: not said. */
  readonly identityProviders?: readonly string[];
  /**
   * The provider answered this request itself (TokenPayload.addressFresh): only then may a stored
   * address be replaced by a different one (TASK-185).
   */
  readonly addressFresh?: boolean;
}

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

/** The statuses whose address may be moved to the one the provider verified (TASK-185). */
const MOVABLE_STATUSES: ReadonlySet<string> = new Set(["active", "warned"]);

/** The longest address recorded (RFC 5321's path limit); a longer claim is not an address. */
const MAX_ADDRESS = 254;

/** A claimed address worth recording: one `@`, nothing that is not printable, bounded. */
function recordable(address: string): boolean {
  if (address.length > MAX_ADDRESS || /[\p{Cc}\p{Cf}\s]/u.test(address)) return false;
  const at = address.indexOf("@");
  return at > 0 && at === address.lastIndexOf("@") && at < address.length - 1;
}

/**
 * What to do: nothing (and why), mark the stored address verified, or record the claim's address
 * (absent or changed). Pure; the whole rule (see the header).
 */
export type VerificationDecision =
  | {
      readonly kind: "none";
      readonly reason:
        | "already_verified"
        | "claim_unverified"
        | "claim_untrusted"
        | "no_address"
        | "address_differs"
        | "account_deleted"
        | "claim_not_fresh";
    }
  | { readonly kind: "mark"; readonly email: string }
  | {
      readonly kind: "record";
      /** The address to store (storedEmail of the claim's). */
      readonly email: string;
      /** The stored value it replaces, exactly as read (the update names it). */
      readonly previous: string | null;
      readonly change: "absent" | "changed";
    };

export function verificationDecision(
  stored: StoredAddress,
  claim: AddressClaim,
  trusted: ReadonlySet<string> = getTrustedEmailIdps()
): VerificationDecision {
  if (stored.deleted) return { kind: "none", reason: "account_deleted" };
  if (claim.emailVerified !== true) return { kind: "none", reason: "claim_unverified" };
  if (!emailClaimTrusted(claim.identityProviders, trusted))
    return { kind: "none", reason: "claim_untrusted" };
  const claimed = typeof claim.email === "string" ? claim.email.trim() : "";
  if (!claimed || !recordable(claimed)) return { kind: "none", reason: "no_address" };
  const address = storedEmail(claimed);
  if (stored.email === null || !stored.email.trim())
    return { kind: "record", email: address, previous: stored.email, change: "absent" };
  if (storedEmail(stored.email) === address)
    return stored.verified
      ? { kind: "none", reason: "already_verified" }
      : { kind: "mark", email: stored.email };
  if (!stored.status || !MOVABLE_STATUSES.has(stored.status))
    return { kind: "none", reason: "address_differs" };
  // A different address only from the provider's own answer to this request: remembered answers
  // of two devices can differ for the cache window, and would flip the address between them.
  if (claim.addressFresh !== true) return { kind: "none", reason: "claim_not_fresh" };
  return { kind: "record", email: address, previous: stored.email, change: "changed" };
}

export type VerificationSync = "unchanged" | "marked" | "recorded" | "failed";

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
  const verifiedBy = claim.identityProviders?.length
    ? claim.identityProviders.join("+")
    : "pool";
  if (decision.kind === "record") return recordAddress(accountId, decision, verifiedBy);
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
          verifiedBy,
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

/**
 * Record the provider's verified address on the account (TASK-185): absent, or changed on an
 * active account — the status and the stored value re-checked by the update itself. A ban on the
 * address follows it here (A-11). Never throws.
 */
async function recordAddress(
  accountId: string,
  decision: Extract<VerificationDecision, { kind: "record" }>,
  verifiedBy: string
): Promise<VerificationSync> {
  try {
    return await withTenantTx(async (tx) => {
      const banned = await banFollowsAddress(tx, decision.email, accountId);
      const { rows } = await tx.query<{ id: string }>(
        `update users set email = $2, email_verified = true,
                account_status = case when $4 then 'banned'::account_status else account_status end,
                banned_at = case when $4 and account_status <> 'banned' then now() else banned_at end,
                ban_reason = case when $4 and account_status <> 'banned' then $6 else ban_reason end,
                status_changed_by = case when $4 and account_status <> 'banned'
                                         then 'platform:ban-carry-over' else status_changed_by end,
                status_changed_at = case when $4 and account_status <> 'banned'
                                         then now() else status_changed_at end
          where id = $1::uuid and deleted_at is null
            and email is not distinct from $3
            and ($5 or account_status in ('active', 'warned'))
         returning id`,
        [
          accountId,
          decision.email,
          decision.previous,
          banned,
          decision.change === "absent",
          CARRIED_BAN_REASON,
        ]
      );
      if (rows.length === 0) return "unchanged" as const;
      await recordAudit({
        action: "profile_updated",
        actorId: accountId,
        targetId: accountId,
        details: {
          field: "email",
          change: decision.change,
          source: "identity_provider",
          verifiedBy,
          ...(banned ? { banCarriedOver: true } : {}),
        },
      });
      if (banned)
        logger.warn("A ban on the recorded address carried over to the account", {
          accountId,
          route: "platform/auth/email-verification",
        });
      return "recorded" as const;
    });
  } catch (err) {
    logger.warn("The account's address could not be recorded; tried again next request", {
      accountId,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/auth/email-verification",
    });
    return "failed";
  }
}

/**
 * The same, for a route that has the verified identity but has not resolved its account (the
 * admin console's session read, TASK-185): one read of the binding, then the sync. Never throws.
 */
export async function syncAccountAddress(
  subject: string,
  claim: AddressClaim
): Promise<VerificationSync> {
  try {
    const { resolution, address } = await resolveAccountRecord(subject);
    if (resolution.kind !== "bound" || !address) return "unchanged";
    return await syncEmailVerification(resolution.accountId, address, claim);
  } catch (err) {
    logger.warn("The account's address could not be checked; tried again next request", {
      error: err instanceof Error ? err.message : String(err),
      route: "platform/auth/email-verification",
    });
    return "failed";
  }
}
