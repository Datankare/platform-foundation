/**
 * platform/auth/coppa.ts — COPPA compliance service
 *
 * Handles age verification and parental consent tracking.
 * Schema in Phase 1, full implementation in Phase 4.
 *
 * COPPA requires:
 * - Age collection before account creation
 * - Parental consent for users under 13
 * - Restricted data collection for minors
 * - Content rating enforcement based on age
 *
 * The user row is updated in the request's tenant (platform/data, ADR-053 D4).
 *
 * Sprint 4, Tasks 4.5 + 4.6
 */

import { withTenantTx } from "@/platform/data";
import { AuditWriteError, audited } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";

export type ParentalConsentStatus = "not_required" | "pending" | "granted" | "denied";

export type { AgeVerificationResult } from "@/platform/auth/age";
export { calculateAge, evaluateAge } from "@/platform/auth/age";
import { evaluateAge, type AgeVerificationResult } from "@/platform/auth/age";

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
 * Record age verification for a user.
 * Updates the user record with DOB, age_verified, and content_rating_level.
 */
export async function recordAgeVerification(
  userId: string,
  dateOfBirth: string
): Promise<{
  success: boolean;
  result?: AgeVerificationResult;
  error?: string;
}> {
  let evaluation: AgeVerificationResult;
  try {
    evaluation = evaluateAge(dateOfBirth);
  } catch (err) {
    // Not a real, past calendar date: nothing is recorded, and nothing is read as an adult.
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  const consentStatus = evaluation.requiresParentalConsent ? "pending" : "not_required";

  try {
    // Recorded before the age data takes effect; no record, no change (Adversarial Validation, 6).
    return await audited(
      {
        action: "profile_updated",
        actorId: userId,
        targetId: userId,
        details: {
          field: "age_verification",
          contentRatingLevel: evaluation.contentRatingLevel,
          requiresParentalConsent: evaluation.requiresParentalConsent,
        },
      },
      async (): Promise<{
        success: boolean;
        result?: AgeVerificationResult;
        error?: string;
      }> => {
        const error = await failure(() =>
          withTenantTx((tx) =>
            tx.query(
              `update users
                  set date_of_birth = $2::date, age_verified = true, age_verified_at = now(),
                      content_rating_level = $3,
                      parental_consent_status = $4::parental_consent_status
                where id = $1::uuid`,
              [userId, dateOfBirth, evaluation.contentRatingLevel, consentStatus]
            )
          )
        );

        if (error) {
          logger.error("Age verification failed", {
            userId,
            error,
            route: "platform/auth/coppa",
          });
          return { success: false, error };
        }

        return { success: true, result: evaluation };
      }
    );
  } catch (err) {
    if (err instanceof AuditWriteError)
      return { success: false, error: "audit unavailable" };
    throw err;
  }
}

/**
 * Record parental consent decision.
 */
export async function recordParentalConsent(
  userId: string,
  status: "granted" | "denied",
  parentEmail?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    return await audited(
      {
        action: status === "granted" ? "consent_granted" : "consent_denied",
        actorId: userId,
        targetId: userId,
        details: { type: "parental_consent", consentStatus: status },
      },
      async () => {
        const error = await failure(() =>
          withTenantTx((tx) =>
            tx.query(
              `update users
                  set parental_consent_status = $2::parental_consent_status,
                      parental_consent_email = $3
                where id = $1::uuid`,
              [userId, status, parentEmail || null]
            )
          )
        );

        if (error) {
          logger.error("Parental consent recording failed", {
            userId,
            consentStatus: status,
            error,
            route: "platform/auth/coppa",
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
