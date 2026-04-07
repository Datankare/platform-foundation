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
import { writeAuditLog } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";

export type ParentalConsentStatus = "not_required" | "pending" | "granted" | "denied";

export interface AgeVerificationResult {
  isMinor: boolean;
  age: number;
  requiresParentalConsent: boolean;
  contentRatingLevel: number;
}

const MINOR_AGE_THRESHOLD = 13;
const TEEN_AGE_THRESHOLD = 18;

/**
 * Calculate age from date of birth.
 */
export function calculateAge(dateOfBirth: string): number {
  const dob = new Date(dateOfBirth);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const monthDiff = now.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) {
    age--;
  }
  return age;
}

/**
 * Determine age verification result and content rating level.
 *
 * Content rating levels:
 * 1 = strictest (under 13, COPPA applies)
 * 2 = moderate (13-17, teen content)
 * 3 = standard (18+, full content)
 */
export function evaluateAge(dateOfBirth: string): AgeVerificationResult {
  const age = calculateAge(dateOfBirth);

  if (age < MINOR_AGE_THRESHOLD) {
    return {
      isMinor: true,
      age,
      requiresParentalConsent: true,
      contentRatingLevel: 1,
    };
  }

  if (age < TEEN_AGE_THRESHOLD) {
    return {
      isMinor: true,
      age,
      requiresParentalConsent: false,
      contentRatingLevel: 2,
    };
  }

  return {
    isMinor: false,
    age,
    requiresParentalConsent: false,
    contentRatingLevel: 3,
  };
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
  const evaluation = evaluateAge(dateOfBirth);
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

  const { error } = await supabase.from("users").update(updateData).eq("id", userId);

  if (error) {
    logger.error("Age verification failed", {
      userId,
      error: error.message,
      route: "platform/auth/coppa",
    });
    return { success: false, error: error.message };
  }

  await writeAuditLog({
    action: "profile_updated",
    actorId: userId,
    targetId: userId,
    details: {
      field: "age_verification",
      contentRatingLevel: evaluation.contentRatingLevel,
      requiresParentalConsent: evaluation.requiresParentalConsent,
    },
  });

  return { success: true, result: evaluation };
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

  const { error } = await supabase.from("users").update(updateData).eq("id", userId);

  if (error) {
    logger.error("Parental consent recording failed", {
      userId,
      consentStatus: status,
      error: error.message,
      route: "platform/auth/coppa",
    });
    return { success: false, error: error.message };
  }

  await writeAuditLog({
    action: "consent_granted",
    actorId: userId,
    targetId: userId,
    details: { type: "parental_consent", consentStatus: status },
  });

  return { success: true };
}
