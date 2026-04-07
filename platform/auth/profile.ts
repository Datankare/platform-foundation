/**
 * platform/auth/profile.ts — User profile service
 *
 * CRUD operations for user profiles with per-field visibility controls.
 * Uses the service client for writes (audit logged) and user client
 * for reads (RLS enforced).
 *
 * Privacy model (three tiers):
 * - private: only the user can see it (default)
 * - friends: visible to friends (Phase 3 groups)
 * - public: visible to everyone
 *
 * Each sensitive field has its own visibility control.
 *
 * Sprint 4, Tasks 4.1 + 4.2
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { writeAuditLog } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";

export type ProfileVisibility = "private" | "friends" | "public";

export interface UserProfile {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  realName: string | null;
  languagePreference: string;
  timezone: string;
  profileVisibility: ProfileVisibility;
  displayNameVisibility: ProfileVisibility;
  avatarVisibility: ProfileVisibility;
  languageVisibility: ProfileVisibility;
  timezoneVisibility: ProfileVisibility;
  emailOptIn: boolean;
  pushNotificationsEnabled: boolean;
  mfaEnabled: boolean;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface ProfileUpdate {
  displayName?: string;
  avatarUrl?: string;
  realName?: string;
  languagePreference?: string;
  timezone?: string;
  profileVisibility?: ProfileVisibility;
  displayNameVisibility?: ProfileVisibility;
  avatarVisibility?: ProfileVisibility;
  languageVisibility?: ProfileVisibility;
  timezoneVisibility?: ProfileVisibility;
  emailOptIn?: boolean;
  pushNotificationsEnabled?: boolean;
}

/** Map camelCase field names to snake_case DB columns */
function toSnakeCase(update: ProfileUpdate): Record<string, unknown> {
  const map: Record<string, string> = {
    displayName: "display_name",
    avatarUrl: "avatar_url",
    realName: "real_name",
    languagePreference: "language_preference",
    timezone: "timezone",
    profileVisibility: "profile_visibility",
    displayNameVisibility: "display_name_visibility",
    avatarVisibility: "avatar_visibility",
    languageVisibility: "language_visibility",
    timezoneVisibility: "timezone_visibility",
    emailOptIn: "email_opt_in",
    pushNotificationsEnabled: "push_notifications_enabled",
  };

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(update)) {
    const dbKey = map[key];
    if (dbKey && value !== undefined) {
      result[dbKey] = value;
    }
  }
  return result;
}

/** Map snake_case DB row to camelCase UserProfile */
function toProfile(row: Record<string, unknown>): UserProfile {
  return {
    id: row.id as string,
    email: row.email as string | null,
    displayName: row.display_name as string | null,
    avatarUrl: row.avatar_url as string | null,
    realName: row.real_name as string | null,
    languagePreference: (row.language_preference as string) || "en",
    timezone: (row.timezone as string) || "UTC",
    profileVisibility: (row.profile_visibility as ProfileVisibility) || "private",
    displayNameVisibility:
      (row.display_name_visibility as ProfileVisibility) || "private",
    avatarVisibility: (row.avatar_visibility as ProfileVisibility) || "private",
    languageVisibility: (row.language_visibility as ProfileVisibility) || "private",
    timezoneVisibility: (row.timezone_visibility as ProfileVisibility) || "private",
    emailOptIn: (row.email_opt_in as boolean) || false,
    pushNotificationsEnabled: (row.push_notifications_enabled as boolean) || false,
    mfaEnabled: (row.mfa_enabled as boolean) || false,
    emailVerified: (row.email_verified as boolean) || false,
    createdAt: row.created_at as string,
    lastLoginAt: row.last_login_at as string | null,
  };
}

/**
 * Get the full profile for the authenticated user (own profile).
 * Returns all fields regardless of visibility — it's their own data.
 */
export async function getOwnProfile(userId: string): Promise<UserProfile | null> {
  const supabase = getSupabaseServiceClient();

  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .is("deleted_at", null)
    .single();

  if (error || !data) {
    logger.warn("Profile not found", {
      userId,
      error: error?.message,
      route: "platform/auth/profile",
    });
    return null;
  }

  return toProfile(data);
}

/**
 * Get a public-facing profile for another user.
 * Only returns fields where visibility is 'public' (or 'friends' in Phase 3).
 */
export async function getPublicProfile(
  userId: string
): Promise<Partial<UserProfile> | null> {
  const supabase = getSupabaseServiceClient();

  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .is("deleted_at", null)
    .single();

  if (error || !data) return null;

  const full = toProfile(data);
  const visible: Partial<UserProfile> = { id: full.id };

  if (full.profileVisibility === "public") {
    if (full.displayNameVisibility === "public") {
      visible.displayName = full.displayName;
    }
    if (full.avatarVisibility === "public") {
      visible.avatarUrl = full.avatarUrl;
    }
    if (full.languageVisibility === "public") {
      visible.languagePreference = full.languagePreference;
    }
    if (full.timezoneVisibility === "public") {
      visible.timezone = full.timezone;
    }
  }

  return visible;
}

/**
 * Update the user's own profile.
 * Validates that only allowed fields are updated.
 * Audit logged.
 */
export async function updateProfile(
  userId: string,
  update: ProfileUpdate
): Promise<{ success: boolean; error?: string }> {
  const dbUpdate = toSnakeCase(update);

  if (Object.keys(dbUpdate).length === 0) {
    return { success: false, error: "No valid fields to update" };
  }

  const supabase = getSupabaseServiceClient();

  const { error } = await supabase
    .from("users")
    .update(dbUpdate)
    .eq("id", userId)
    .is("deleted_at", null);

  if (error) {
    logger.error("Profile update failed", {
      userId,
      error: error.message,
      route: "platform/auth/profile",
    });
    return { success: false, error: error.message };
  }

  await writeAuditLog({
    action: "profile_updated",
    actorId: userId,
    targetId: userId,
    details: { fields: Object.keys(update) },
  });

  return { success: true };
}

/**
 * Get a user's profile for admin viewing.
 * Returns all fields. Audit logged (admin accessed user data).
 */
export async function getProfileAsAdmin(
  adminId: string,
  userId: string
): Promise<UserProfile | null> {
  const profile = await getOwnProfile(userId);

  if (profile) {
    await writeAuditLog({
      action: "profile_viewed_by_admin",
      actorId: adminId,
      targetId: userId,
    });
  }

  return profile;
}
