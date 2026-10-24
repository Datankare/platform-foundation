/**
 * platform/auth/profile.ts — User profile service
 *
 * CRUD operations for user profiles with per-field visibility controls.
 * Reads and writes the user row in the request's tenant (platform/data, ADR-053 D4); writes
 * are audit logged.
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

import { withTenantTx } from "@/platform/data";
import { AuditWriteError, audited, recordAudit } from "@/platform/auth/audit";
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

const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v == null ? null : String(v);

/** The current tenant's live (not deleted) user row, or undefined. Throws when unreadable. */
async function readUserRow(userId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await withTenantTx((tx) =>
    tx.query(
      `select id, email, display_name, avatar_url, real_name, language_preference, timezone,
              profile_visibility, display_name_visibility, avatar_visibility,
              language_visibility, timezone_visibility, email_opt_in,
              push_notifications_enabled, mfa_enabled, email_verified, created_at, last_login_at
         from users where id = $1::uuid and deleted_at is null`,
      [userId]
    )
  );
  return rows[0];
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
    createdAt: iso(row.created_at) as string,
    lastLoginAt: iso(row.last_login_at),
  };
}

/**
 * Get the full profile for the authenticated user (own profile).
 * Returns all fields regardless of visibility — it's their own data.
 */
export async function getOwnProfile(userId: string): Promise<UserProfile | null> {
  // No row is "not found". A store failure is not: it is thrown, so a route can answer 503
  // rather than tell the user their profile is gone (Playform v0.8.0 release review).
  let data: Record<string, unknown> | undefined;
  try {
    data = await readUserRow(userId);
  } catch (err) {
    throw new Error(
      `profile read failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!data) {
    logger.warn("Profile not found", {
      userId,
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
  let data: Record<string, unknown> | undefined;
  try {
    data = await readUserRow(userId);
  } catch {
    return null;
  }
  if (!data) return null;

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

  try {
    // Recorded before the profile changes; no record, no change (Adversarial Validation, 6).
    return await audited(
      {
        action: "profile_updated",
        actorId: userId,
        targetId: userId,
        details: { fields: Object.keys(update) },
      },
      async () => {
        let error: string | undefined;
        try {
          // One fixed statement: a column changes only when its key is in the update.
          await withTenantTx((tx) =>
            tx.query(
              `update users set
                 display_name = case when $2::jsonb ? 'display_name' then $2::jsonb->>'display_name' else display_name end,
                 avatar_url = case when $2::jsonb ? 'avatar_url' then $2::jsonb->>'avatar_url' else avatar_url end,
                 real_name = case when $2::jsonb ? 'real_name' then $2::jsonb->>'real_name' else real_name end,
                 language_preference = case when $2::jsonb ? 'language_preference' then $2::jsonb->>'language_preference' else language_preference end,
                 timezone = case when $2::jsonb ? 'timezone' then $2::jsonb->>'timezone' else timezone end,
                 profile_visibility = case when $2::jsonb ? 'profile_visibility' then ($2::jsonb->>'profile_visibility')::profile_visibility else profile_visibility end,
                 display_name_visibility = case when $2::jsonb ? 'display_name_visibility' then ($2::jsonb->>'display_name_visibility')::profile_visibility else display_name_visibility end,
                 avatar_visibility = case when $2::jsonb ? 'avatar_visibility' then ($2::jsonb->>'avatar_visibility')::profile_visibility else avatar_visibility end,
                 language_visibility = case when $2::jsonb ? 'language_visibility' then ($2::jsonb->>'language_visibility')::profile_visibility else language_visibility end,
                 timezone_visibility = case when $2::jsonb ? 'timezone_visibility' then ($2::jsonb->>'timezone_visibility')::profile_visibility else timezone_visibility end,
                 email_opt_in = case when $2::jsonb ? 'email_opt_in' then ($2::jsonb->>'email_opt_in')::boolean else email_opt_in end,
                 push_notifications_enabled = case when $2::jsonb ? 'push_notifications_enabled' then ($2::jsonb->>'push_notifications_enabled')::boolean else push_notifications_enabled end
               where id = $1::uuid and deleted_at is null`,
              [userId, JSON.stringify(dbUpdate)]
            )
          );
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }

        if (error) {
          logger.error("Profile update failed", {
            userId,
            error,
            route: "platform/auth/profile",
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
 * Get a user's profile for admin viewing.
 * Returns all fields. Audit logged (admin accessed user data): the access is recorded before
 * the profile is returned, and when it cannot be recorded AuditWriteError is thrown and nothing
 * is disclosed. (Null stays "no such profile", so an audit failure is never mistaken for one.)
 */
export async function getProfileAsAdmin(
  adminId: string,
  userId: string
): Promise<UserProfile | null> {
  const profile = await getOwnProfile(userId);

  if (profile) {
    await recordAudit({
      action: "profile_viewed_by_admin",
      actorId: adminId,
      targetId: userId,
    });
  }

  return profile;
}
