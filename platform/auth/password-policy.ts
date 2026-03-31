/**
 * platform/auth/password-policy.ts — Password policy service
 *
 * Resolves the effective password policy for a player using a
 * three-level cascade: individual → role → global default.
 *
 * Schema in Phase 1, enforcement in Phase 2.
 *
 * Sprint 4, Task 4.7
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

export interface PasswordPolicy {
  rotationDays: number;
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSpecial: boolean;
  passwordHistoryCount: number;
}

const DEFAULT_POLICY: PasswordPolicy = {
  rotationDays: 90,
  minLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecial: true,
  passwordHistoryCount: 5,
};

function toPolicy(row: Record<string, unknown>): PasswordPolicy {
  return {
    rotationDays: (row.rotation_days as number) || DEFAULT_POLICY.rotationDays,
    minLength: (row.min_length as number) || DEFAULT_POLICY.minLength,
    requireUppercase: row.require_uppercase as boolean,
    requireLowercase: row.require_lowercase as boolean,
    requireNumber: row.require_number as boolean,
    requireSpecial: row.require_special as boolean,
    passwordHistoryCount:
      (row.password_history_count as number) || DEFAULT_POLICY.passwordHistoryCount,
  };
}

/**
 * Resolve the effective password policy for a player.
 * Cascade: individual override → role override → global default.
 */
export async function getEffectivePasswordPolicy(
  playerId: string,
  roleId: string
): Promise<PasswordPolicy> {
  const supabase = getSupabaseServiceClient();

  // 1. Check for individual override
  const { data: individual } = await supabase
    .from("password_policy")
    .select("*")
    .eq("player_id", playerId)
    .single();

  if (individual) return toPolicy(individual);

  // 2. Check for role override
  const { data: rolePolicy } = await supabase
    .from("password_policy")
    .select("*")
    .eq("role_id", roleId)
    .single();

  if (rolePolicy) return toPolicy(rolePolicy);

  // 3. Check for global default (both role_id and player_id are null)
  const { data: global } = await supabase
    .from("password_policy")
    .select("*")
    .is("role_id", null)
    .is("player_id", null)
    .single();

  if (global) return toPolicy(global);

  // 4. Hardcoded fallback (should never reach here if seed data exists)
  logger.warn("No password policy found, using hardcoded default", {
    playerId,
    roleId,
    route: "platform/auth/password-policy",
  });
  return DEFAULT_POLICY;
}

/**
 * Validate a password against a policy.
 * Returns a list of violations (empty = valid).
 */
export function validatePassword(password: string, policy: PasswordPolicy): string[] {
  const violations: string[] = [];

  if (password.length < policy.minLength) {
    violations.push(`Must be at least ${policy.minLength} characters`);
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    violations.push("Must contain an uppercase letter");
  }
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    violations.push("Must contain a lowercase letter");
  }
  if (policy.requireNumber && !/[0-9]/.test(password)) {
    violations.push("Must contain a number");
  }
  if (policy.requireSpecial && !/[^A-Za-z0-9]/.test(password)) {
    violations.push("Must contain a special character");
  }

  return violations;
}
