/**
 * platform/auth/consent.ts — Consent records service
 *
 * Tracks what the user agreed to, when, and which version.
 * GDPR requires purpose limitation — we can only use data for
 * the purposes the user consented to.
 *
 * Records live in consent_records in the request's tenant (platform/data, ADR-053 D4).
 *
 * Sprint 4, Task 4.8
 */

import { withTenantTx } from "@/platform/data";
import { AuditWriteError, audited } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";

export interface ConsentRecord {
  id: string;
  userId: string;
  consentType: string;
  consentVersion: string;
  granted: boolean;
  grantedAt: string;
  revokedAt: string | null;
}

interface ConsentRow {
  id: string;
  user_id: string;
  consent_type: string;
  consent_version: string;
  granted: boolean;
  granted_at: Date;
  revoked_at: Date | null;
}

/** Run a write; its error message, or undefined when it succeeded. */
async function failure(write: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await write();
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Record a user's consent for a specific purpose.
 */
export async function grantConsent(params: {
  userId: string;
  consentType: string;
  consentVersion: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    // Recorded before the consent takes effect; no record, no consent (Adversarial Validation, 6).
    return await audited(
      {
        action: "consent_granted",
        actorId: params.userId,
        targetId: params.userId,
        details: {
          consentType: params.consentType,
          consentVersion: params.consentVersion,
        },
      },
      async () => {
        const error = await failure(() =>
          withTenantTx((tx) =>
            tx.query(
              `insert into consent_records
                 (user_id, consent_type, consent_version, granted, ip_address, user_agent)
               values ($1::uuid, $2, $3, true, $4::inet, $5)`,
              [
                params.userId,
                params.consentType,
                params.consentVersion,
                params.ipAddress || null,
                params.userAgent || null,
              ]
            )
          )
        );

        if (error) {
          logger.error("Consent grant failed", {
            userId: params.userId,
            consentType: params.consentType,
            error,
            route: "platform/auth/consent",
          });
          return { success: false, error };
        }

        return { success: true };
      }
    );
  } catch (err) {
    if (err instanceof AuditWriteError)
      return { success: false, error: "audit unavailable" };
    throw err;
  }
}

/**
 * Revoke a user's consent for a specific purpose.
 * Sets revoked_at — does not delete the record (audit trail).
 */
export async function revokeConsent(params: {
  userId: string;
  consentType: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    return await audited(
      {
        action: "consent_revoked",
        actorId: params.userId,
        targetId: params.userId,
        details: { consentType: params.consentType },
      },
      async () => {
        const error = await failure(() =>
          withTenantTx((tx) =>
            tx.query(
              `update consent_records set revoked_at = now()
                where user_id = $1::uuid and consent_type = $2 and revoked_at is null`,
              [params.userId, params.consentType]
            )
          )
        );

        if (error) {
          logger.error("Consent revocation failed", {
            userId: params.userId,
            consentType: params.consentType,
            error,
            route: "platform/auth/consent",
          });
          return { success: false, error };
        }

        return { success: true };
      }
    );
  } catch (err) {
    if (err instanceof AuditWriteError)
      return { success: false, error: "audit unavailable" };
    throw err;
  }
}

/**
 * Get all active consent records for a user.
 */
export async function getUserConsents(userId: string): Promise<ConsentRecord[]> {
  let rows: ConsentRow[];
  try {
    ({ rows } = await withTenantTx((tx) =>
      tx.query<ConsentRow>(
        `select id, user_id, consent_type, consent_version, granted, granted_at, revoked_at
           from consent_records
          where user_id = $1::uuid and revoked_at is null
          order by granted_at desc`,
        [userId]
      )
    ));
  } catch {
    return [];
  }

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    consentType: row.consent_type,
    consentVersion: row.consent_version,
    granted: row.granted,
    grantedAt: row.granted_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  }));
}

/**
 * Check if a user has active consent for a specific type.
 */
export async function hasConsent(userId: string, consentType: string): Promise<boolean> {
  const consents = await getUserConsents(userId);
  return consents.some((c) => c.consentType === consentType);
}
