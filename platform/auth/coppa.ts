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
 * Sprint 4, Tasks 4.5 + 4.6
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { AuditWriteError, audited } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";

export type ParentalConsentStatus = "not_required" | "pending" | "granted" | "denied";

export type { AgeVerificationResult } from "@/platform/auth/age";
export { calculateAge, evaluateAge } from "@/platform/auth/age";
import { evaluateAge, type AgeVerificationResult } from "@/platform/auth/age";

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
  const supabase = getSupabaseServiceClient();

  const updateData: Record<string, unknown> = {
    date_of_birth: dateOfBirth,
    age_verified: true,
    age_verified_at: new Date().toISOString(),
    content_rating_level: evaluation.contentRatingLevel,
    parental_consent_status: evaluation.requiresParentalConsent
      ? "pending"
      : "not_required",
  };

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
        const { error } = await supabase
          .from("users")
          .update(updateData)
          .eq("id", userId);

        if (error) {
          logger.error("Age verification failed", {
            userId,
            error: error.message,
            route: "platform/auth/coppa",
          });
          return { success: false, error: error.message };
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
  const supabase = getSupabaseServiceClient();

  const updateData: Record<string, unknown> = {
    parental_consent_status: status as string,
    parental_consent_email: parentEmail || null,
  };

  try {
    return await audited(
      {
        action: status === "granted" ? "consent_granted" : "consent_denied",
        actorId: userId,
        targetId: userId,
        details: { type: "parental_consent", consentStatus: status },
      },
      async () => {
        const { error } = await supabase
          .from("users")
          .update(updateData)
          .eq("id", userId);

        if (error) {
          logger.error("Parental consent recording failed", {
            userId,
            consentStatus: status,
            error: error.message,
            route: "platform/auth/coppa",
          });
          return { success: false, error: error.message };
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
